/**
 * Proxy 代理路由 —— 基于官方 SDK
 *
 * 特性：
 * - 根据 api_format 路由到 OpenAI Chat / Anthropic Messages / OpenAI Responses
 * - 故障转移：请求模型失败 → 按 sort_index 顺序尝试下一个可用模型，失败模型自动锁定xx时间
 * - isDisable=true 的模型不出现在可用池中，过期锁定自动清空
 * - 支持 tool_calls 完整转发
 * - Token 使用量追踪
 */

import { Router, Request, Response } from 'express';
import db from '../config/database';

import {
  createModelProvider,
  convertToOpenAIChatMessages,
  convertAnthropicRequestToCommon,
  toAnthropicError,
  convertOpenAIChatToAnthropicResponse,
  convertResponsesRequestToChatRequest,
  estimateMessagesTokens,
  estimateTextTokens,
  generateRandomString,
  buildOpenAIModel,
  parseModelCapabilities,
  getEffectiveContentLength,
  getEffectiveMaxToken,
  MAX_RESPONSE_TOKENS,
  LOCK_DURATION_MS,
  REQUEST_TIMEOUT_MS,
  API_FORMAT,
  isModelLocked,
  callOpenAIChat,
  callAnthropic,
  callOpenAIResponses,
  callAnthropicMessages,
  streamAnthropicMessages,
  type ModelRow,
  type GenericMessage,
  type ChatCallParams,
} from '../utils/model-provider';

import {
  writeSSE,
  writeSSEEvent,
  processChatStream,
  processAnthropicStream,
  streamChatAsAnthropicSSE,
} from '../utils/stream-convert';

import {
  streamChatAsResponses as streamChatAsResponsesV2,
  processResponsesFetchStream,
  buildResponsesResponse,
} from '../utils/responses-stream';

import { trackTokenUsage, trackApiCall } from '../utils/tokenTracker';
import { getUserApiKey } from '../config/database';
import { errorBroadcaster } from '../utils/errorBroadcaster';
import OpenAI from 'openai';

// ===== Service-Convert Proxy 框架 =====
import { pickProxy, createSSECallbacks, executeProxy, type InputFormat, type ProviderType } from '../utils/service-convert/express-bridge';

const router = Router();

// ========== 用户设置辅助 ==========

interface UserSettings {
  max_content_length: number;
  max_token: number;
}

function getUserSettings(): UserSettings {
  const settings = db
    .prepare('SELECT max_content_length, max_token FROM user_settings WHERE id = 1')
    .get() as UserSettings | undefined;
  return settings || { max_content_length: 0, max_token: 0 };
}

// ========== 用户查询辅助 ==========

/** 根据用户名查询用户 ID */
function getUserIdByUsername(username: string): number | null {
  const user = db
    .prepare('SELECT id FROM users WHERE name = ?')
    .get(username) as { id: number } | undefined;
  return user?.id ?? null;
}

// ========== 数据库读取辅助 ==========

function getAllModels(userId?: number): ModelRow[] {
  if (userId !== undefined) {
    return db
      .prepare(
        'SELECT * FROM models WHERE user_id = ? ORDER BY CASE WHEN sort_index = -1 THEN 999999 ELSE sort_index END ASC, created_at ASC',
      )
      .all(userId) as ModelRow[];
  }
  return db
    .prepare(
      'SELECT * FROM models ORDER BY CASE WHEN sort_index = -1 THEN 999999 ELSE sort_index END ASC, created_at ASC',
    )
    .all() as ModelRow[];
}

function unlockExpiredModels(userId?: number): void {
  const now = Date.now();
  const expiredIds = getAllModels(userId)
    .filter((m) => m.isLock > 0 && now - m.isLock > LOCK_DURATION_MS)
    .map((m) => m.id);

  if (expiredIds.length > 0) {
    const placeholders = expiredIds.map(() => '?').join(',');
    db.prepare(`UPDATE models SET isLock = 0 WHERE id IN (${placeholders})`).run(...expiredIds);
  }
}

function getAvailableModels(userId?: number): ModelRow[] {
  unlockExpiredModels(userId);
  return getAllModels(userId).filter((m) => !m.isDisable && !isModelLocked(m.isLock).locked);
}

function getModelByName(name: string, userId?: number): ModelRow | undefined {
  if (userId !== undefined) {
    return db
      .prepare('SELECT * FROM models WHERE name = ? AND user_id = ?')
      .get(name, userId) as ModelRow | undefined;
  }
  return db.prepare('SELECT * FROM models WHERE name = ?').get(name) as ModelRow | undefined;
}

// ========== 重试机制 ==========

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 500;

/** 判断是否为可重试的错误（50x 上游错误 或 请求超时） */
function isRetryableError(err: unknown): boolean {
  const status = (err as any).status || (err as any).statusCode || 0;
  const errName = (err as Error)?.name || '';
  const errMsg = (err as Error)?.message || '';

  // 50x 上游错误
  if (status >= 500 && status < 600) return true;

  // 请求超时（AbortError / TimeoutError / ECONNRESET / ETIMEDOUT）
  if (/TimeoutError|AbortError|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(errName)) return true;
  if (/timeout|terminated|aborted|timed out/i.test(errMsg)) return true;

  return false;
}

/** 带重试的异步执行：遇到 50x 或超时自动每隔 RETRY_INTERVAL_MS 重试，最多 RETRY_MAX_ATTEMPTS 次 */
async function withRetry<T>(fn: () => Promise<T> | T): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await Promise.resolve(fn());
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_MAX_ATTEMPTS && isRetryableError(err)) {
        const errMsg = (err as Error).message;
        const status = (err as any).status || (err as any).statusCode || '-';
        console.warn(`[proxy] Retryable error (attempt ${attempt + 1}/${RETRY_MAX_ATTEMPTS}): [${status}] ${errMsg}`);
        await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ========== 故障转移核心 ==========

/** 判断是否为"不支持多模态"类型的错误，这类错误不应锁定模型或故障转移 */
function isMultimodalNotSupportedError(err: unknown): boolean {
  const msg = (err as Error)?.message || '';
  return (
    /image_url/i.test(msg) ||
    /image content/i.test(msg) ||
    /multimodal/i.test(msg) ||
    /unsupported.*image/i.test(msg) ||
    /does not support.*image/i.test(msg) ||
    /invalid_request_error.*image/i.test(msg)
  );
}

async function tryModelsSequentially<T>(
  requestModelName: string,
  tryFn: (model: ModelRow) => Promise<T> | T,
  userId?: number,
): Promise<T | null> {
  const now = Date.now();

  let available = getAvailableModels(userId);
  if (available.length === 0) return null;

  // 命中的模型排首位
  const requestModel = available.find((m) => m.name === requestModelName);
  if (requestModel) {
    available = [requestModel, ...available.filter((m) => m.id !== requestModel.id)];
  }

  for (const model of available) {
    try {
      return await withRetry(() => tryFn(model));
    } catch (err) {
      const error = err as Error & { status?: number; statusCode?: number };
      const status = error.status || error.statusCode || 500;
      const errMsg = (err as Error).message;
      const errorType = err instanceof Error && err.name === 'TimeoutError' ? 'timeout_error' : 'upstream_error';
      console.error(`[proxy] Model "${model.name}" failed (${status}): ${errMsg}`, {
        error: err,
        model: { id: model.id, name: model.name, api_format: model.api_format },
        requestModelName,
      });
      errorBroadcaster.emitError(model.id, model.name, errorType, `[${status}] ${errMsg}`);

      // 不支持多模态等客户端错误：直接抛出，不锁定模型、不故障转移
      if (status === 400 && isMultimodalNotSupportedError(err)) {
        throw err;
      }

      db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(now, model.id);
    }
  }

  return null;
}

// ========== 公共参数构建 ==========

interface ChatRequestParams {
  messages: GenericMessage[];
  maxTokens: number;
  temperature?: number;
  topP?: number;
  tools?: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
  toolChoice?: string;
  system?: string;
}

function buildChatParams(body: Record<string, unknown>): ChatRequestParams {
  const messages = convertToOpenAIChatMessages((body.messages as any[]) || []);
  const settingsMaxToken = getUserSettings().max_token;
  const maxTokens =
    settingsMaxToken > 0
      ? settingsMaxToken
      : Math.min((body.max_tokens as number) ?? MAX_RESPONSE_TOKENS, MAX_RESPONSE_TOKENS);

  return {
    messages,
    maxTokens,
    temperature: body.temperature as number | undefined,
    topP: body.top_p as number | undefined,
    tools: body.tools
      ? (body.tools as Array<{
          function: { name: string; description?: string; parameters: Record<string, unknown> };
        }>)
      : undefined,
    toolChoice: body.tool_choice as string | undefined,
    system: body.system as string | undefined,
  };
}

function getOrderedModels(requestModelName: string, userId?: number): ModelRow[] {
  const allModels = getAvailableModels(userId);
  const requestModel = allModels.find((m) => m.name === requestModelName);
  return requestModel
    ? [requestModel, ...allModels.filter((m) => m.id !== requestModel.id)]
    : allModels;
}

/**
 * 移除对象中值为 undefined 的 key，避免透传 undefined 到上游 API
 */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if (result[key] === undefined) delete result[key];
  }
  return result;
}

// ========== 统一处理函数：Chat Completions ==========

async function handleChatCompletions(req: Request, res: Response, userId?: number): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const requestModelName = (body.model as string) || '';
  const isStream = body.stream === true;

  const ordered = getOrderedModels(requestModelName, userId);
  if (ordered.length === 0) {
    res.status(503).json({ error: { message: '没有可用的模型', type: 'upstream_error', status: 503 } });
    return;
  }

  const params = buildChatParams(body);
  const promptTokens = estimateMessagesTokens(params.messages);

  if (isStream) {
    if (res.headersSent) return;

    let idx = 0;
    let callbacks: ReturnType<typeof createSSECallbacks> | null = null;

    while (idx < ordered.length) {
      const model = ordered[idx++];
      const providerType = toProviderType(createModelProvider(model).type);
      const baseURL = model.url.replace(/\/$/, '');

      // 为当前 model 创建回调（传入 modelId 以自动跟踪 token）
      callbacks = createSSECallbacks('chat' as InputFormat, res, { modelId: model.id, promptTokens, modelName: model.model_name });

      const proxyBody: Record<string, unknown> = stripUndefined({
        model: model.model_name,
        messages: params.messages as unknown as Array<Record<string, unknown>>,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
        top_p: params.topP,
        tools: params.tools as unknown as Array<Record<string, unknown>> | undefined,
        tool_choice: params.toolChoice,
        stream: true,
        stream_options: { include_usage: true },
      });
      if (params.system) proxyBody.system = params.system;

      // Anthropic 原生 API 路径：调用 /v1/messages，不走 Chat hub
      if (providerType === 'anthropic') {
        try {
          const provider = createModelProvider(model);
          await processAnthropicStream(
            provider,
            { ...params, system: params.system || '', maxOutputTokens: params.maxTokens },
            res,
            { modelId: model.id, promptTokens },
          );
          trackApiCall(model.id);
          return;
        } catch (err) {
          const error = err as Error & { status?: number; statusCode?: number };
          const status = error.status || error.statusCode || 500;
          const errMsg = (err as Error).message;
          console.error(`[proxy] Anthropic model "${model.name}" failed (${status}): ${errMsg}`);
          errorBroadcaster.emitError(model.id, model.name, 'anthropic_error', `[${status}] ${errMsg}`);
          if (status === 400 && isMultimodalNotSupportedError(err)) {
            callbacks.onError?.(err as Error);
            callbacks.onDone?.();
            return;
          }
          db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);
          if (idx < ordered.length) continue;
          callbacks.onError?.(new Error('所有可用模型均失败'));
          callbacks.onDone?.();
          return;
        }
      }

      // 非 Anthropic 路径：设置 SSE 头后走 Proxy 框架
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
      }

      const proxy = pickProxy('chat' as InputFormat, providerType);
      if (!proxy) {
        callbacks.onError?.(new Error(`不支持的转换: chat→${providerType}`));
        callbacks.onDone?.();
        return;
      }

      try {
        await executeProxy(proxy, {
          baseUrl: baseURL,
          apiKey: model.api_key,
          providerLabel: `Chat→${providerType}`,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }, proxyBody, callbacks);

        trackApiCall(model.id);
        return;
      } catch (err) {
        const error = err as Error & { status?: number; statusCode?: number };
        const status = error.status || error.statusCode || 500;
        const errMsg = (err as Error).message;
        const errorType = err instanceof Error && err.name === 'TimeoutError' ? 'timeout_error' : 'upstream_error';
        console.error(`[proxy] Model "${model.name}" failed (${status}): ${errMsg}`);
        errorBroadcaster.emitError(model.id, model.name, errorType, `[${status}] ${errMsg}`);

        if (status === 400 && isMultimodalNotSupportedError(err)) {
          callbacks.onError?.(err as Error);
          callbacks.onDone?.();
          return;
        }
        db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);
      }
    }

    callbacks!.onError?.(new Error('所有可用模型均失败'));
    callbacks!.onDone?.();
  } else {
    // 非流式
    let result: any = null;
    let usedModel: ModelRow | undefined;
    try {
      result = await tryModelsSequentially(
        requestModelName,
        async (model: ModelRow) => {
          const provider = createModelProvider(model);
          usedModel = model;
          if (provider.type === 'anthropic') {
            return callAnthropic(provider, { ...params, maxOutputTokens: params.maxTokens });
          }
          return callOpenAIChat(provider, { ...params, maxOutputTokens: params.maxTokens });
        },
        userId,
      );
    } catch (err) {
      if (isMultimodalNotSupportedError(err)) {
        const status = (err as any).status || (err as any).statusCode || 400;
        res.status(status).json({ error: { message: (err as Error).message, type: 'invalid_request_error', status } });
        return;
      }
      throw err;
    }

    if (!result) {
      res.status(503).json({ error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 } });
      return;
    }
    if (result.usage) trackTokenUsage(usedModel?.id, result.usage as any);
    else if (usedModel) {
      const outText = JSON.stringify(result);
      trackTokenUsage(usedModel.id, { prompt_tokens: promptTokens, completion_tokens: estimateTextTokens(outText), total_tokens: promptTokens + estimateTextTokens(outText) });
    }
    trackApiCall(usedModel?.id);
    res.json(result);
  }
}

/**
 * 轻量内存缓存，用于 Responses API 的 previous_response_id 状态保持。
 * key = "baseUrl|modelName"
 * value = 最近的 response_id
 *
 * Codex 通过 previous_response_id 实现多轮对话上下文延续。
 * 当上游不支持 previous_response_id 时，退化到全量发送上下文。
 */
const responseIdCache = new Map<string, string>();
const RESPONSE_ID_CACHE_MAX = 100;

function getCachedResponseId(baseUrl: string, modelName: string): string | undefined {
  const key = `${baseUrl}|${modelName}`;
  return responseIdCache.get(key);
}

function setCachedResponseId(baseUrl: string, modelName: string, responseId: string): void {
  const key = `${baseUrl}|${modelName}`;
  responseIdCache.set(key, responseId);
  // LRU 简单淘汰
  if (responseIdCache.size > RESPONSE_ID_CACHE_MAX) {
    const firstKey = responseIdCache.keys().next().value;
    if (firstKey) responseIdCache.delete(firstKey);
  }
}

// ========== Responses API 辅助函数 ==========

/**
 * 将 Chat Completion 响应转换为单个流式 chunk
 * 用于 Anthropic → Chat → Responses 转换路径
 */
function chatResultToChunk(
  chatResult: Record<string, unknown>,
  modelName: string,
): OpenAI.Chat.ChatCompletionChunk {
  const choice = ((chatResult.choices as Array<Record<string, unknown>>) || [{}])[0];
  const message = (choice.message || {}) as Record<string, unknown>;

  return {
    id: (chatResult.id as string) || `chatcmpl-${generateRandomString(12)}`,
    object: 'chat.completion.chunk',
    created: (chatResult.created as number) || Math.floor(Date.now() / 1000),
    model: modelName,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        content: (message.content as string) || null,
        tool_calls: (message.tool_calls as Array<Record<string, unknown>>)?.map((tc, i) => ({
          index: i,
          id: tc.id as string,
          type: 'function' as const,
          function: {
            name: ((tc.function as Record<string, unknown>)?.name) as string,
            arguments: ((tc.function as Record<string, unknown>)?.arguments) as string,
          },
        })),
      },
      finish_reason: (choice.finish_reason as string) || 'stop',
    }],
    usage: chatResult.usage as OpenAI.CompletionUsage | undefined,
  } as unknown as OpenAI.Chat.ChatCompletionChunk;
}

/**
 * 从单个 chunk 创建 AsyncIterable 流
 * 用于将非流式响应包装为流式格式
 */
function createSingleChunkStream<T>(chunk: T): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let emitted = false;
      return {
        next: async (): Promise<IteratorResult<T>> => {
          if (emitted) return { done: true, value: undefined as any };
          emitted = true;
          return { done: false, value: chunk };
        },
      };
    },
  };
}

// ========== 统一处理函数：Responses API ==========

/** 转换 provider.type 到枚举 */
function toProviderType(type: string): ProviderType {
  if (type === 'anthropic') return 'anthropic';
  if (type === 'openai-responses') return 'openai-responses';
  return 'openai-chat';
}

async function handleResponses(req: Request, res: Response, userId?: number): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const requestModelName = (body.model as string) || '';
  const isStream = body.stream === true;

  const ordered = getOrderedModels(requestModelName, userId);
  if (ordered.length === 0) {
    res.status(503).json({ error: { message: '没有可用的模型', type: 'upstream_error', status: 503 } });
    return;
  }

  if (isStream) {
    if (res.headersSent) return;

    const callbacks = createSSECallbacks('responses' as InputFormat, res);
    let idx = 0;

    while (idx < ordered.length) {
      const model = ordered[idx++];
      const providerType = toProviderType(createModelProvider(model).type);
      const baseURL = model.url.replace(/\/$/, '');

      const proxyBody: Record<string, unknown> = stripUndefined({
        ...body,
        model: model.model_name,
        stream: true,
      });

      // Anthropic 原生 API 路径
      if (providerType === 'anthropic' && Array.isArray(body.input)) {

        const chatBody = convertResponsesRequestToChatRequest({
          ...body,
          model: requestModelName,
          max_tokens: Math.min(
            (body.max_output_tokens as number) ?? (body.max_tokens as number) ?? MAX_RESPONSE_TOKENS,
            MAX_RESPONSE_TOKENS,
          ),
        });

        const params = buildChatParams(chatBody);
        const promptTokens = estimateMessagesTokens(params.messages);

        try {
          const provider = createModelProvider(model);
          const chatResult = await callAnthropic(provider, {
            ...params,
            system: (body.instructions as string) || params.system,
            maxOutputTokens: params.maxTokens,
          });
          const singleChunk = chatResultToChunk(chatResult, provider.modelName);
          const singleItemStream = createSingleChunkStream(singleChunk);

          await streamChatAsResponsesV2(singleItemStream, res, provider.modelName, {
            modelId: model.id,
            promptTokens,
          });
          trackApiCall(model.id);
          return;
        } catch (err) {
          const errName = (err as Error).name;
          const errMsg = (err as Error).message;
          console.error(`[proxy] Anthropic model "${model.name}" failed:`, { name: errName, message: errMsg, url: model.url, apiFormat: model.api_format, stack: (err as Error).stack?.split('\n').slice(0, 8).join('\n') });
          errorBroadcaster.emitError(model.id, model.name, 'anthropic_error', errMsg);
          if (/abort|terminated|timeout/i.test(errName) || /terminated|aborted|timeout/i.test(errMsg)) {
            console.error(`[proxy] Timeout/terminated (not locking model "${model.name}")`);
            if (idx < ordered.length) continue;
            callbacks.onError?.(new Error('所有可用模型均失败'));
            callbacks.onDone?.();
            return;
          }
          db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);
          if (idx < ordered.length) continue;
          callbacks.onError?.(new Error('所有可用模型均失败'));
          callbacks.onDone?.();
          return;
        }
      }

      // 非 Anthropic 路径：设置 SSE 头后走 Proxy 框架
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
      }

      const proxy = pickProxy('responses' as InputFormat, providerType);
      if (!proxy) {
        callbacks.onError?.(new Error(`不支持的转换: responses→${providerType}`));
        callbacks.onDone?.();
        return;
      }

      try {
        await executeProxy(proxy, {
          baseUrl: baseURL,
          apiKey: model.api_key,
          providerLabel: `Responses→${providerType}`,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }, proxyBody, callbacks);

        trackApiCall(model.id);
        return;
      } catch (err) {
        const error = err as Error & { status?: number; statusCode?: number };
        const status = error.status || error.statusCode || 500;
        const errMsg = (err as Error).message;
        const errorType = err instanceof Error && err.name === 'TimeoutError' ? 'timeout_error' : 'upstream_error';
        console.error(`[proxy] Model "${model.name}" failed (${status}): ${errMsg}`);
        errorBroadcaster.emitError(model.id, model.name, errorType, `[${status}] ${errMsg}`);

        if (status === 400 && isMultimodalNotSupportedError(err)) {
          callbacks.onError?.(err as Error);
          callbacks.onDone?.();
          return;
        }
        db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);
      }
    }

    callbacks!.onError?.(new Error('所有可用模型均失败'));
    callbacks!.onDone?.();
  } else {
    res.status(400).json({ error: { message: 'Responses API 仅支持流式模式', type: 'invalid_request' } });
  }
}

// ========== 统一处理函数：Anthropic Messages API ==========

/**
 * POST /v1/messages — Anthropic Messages API 端点
 *
 * 接收 Anthropic 格式请求，根据模型的 api_format 进行转换：
 *   api_format=2 (anthropic)      → 直接转发，返回原生 Anthropic 响应
 *   api_format=1 (openai-chat)    → 转换为 Chat Completion，再转回 Anthropic 格式
 *   api_format=3 (openai-responses) → 转换为 Chat Completion，再转回 Anthropic 格式
 *
 * 支持流式（anthropic-version: 2023-06-01 或 stream=true）和非流式
 */
async function handleAnthropicMessages(req: Request, res: Response, userId?: number): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const requestModelName = (body.model as string) || '';

  // 判断是否为流式请求
  const isStream = body.stream === true;

  const ordered = getOrderedModels(requestModelName, userId);
  if (ordered.length === 0) {
    res.status(503).json(toAnthropicError('没有可用的模型', 'overloaded_error'));
    return;
  }

  // 转换 Anthropic 请求为通用内部格式
  let params: ChatCallParams;
  try {
    params = convertAnthropicRequestToCommon(body);
  } catch (err) {
    res.status(400).json(toAnthropicError('请求格式转换失败: ' + (err as Error).message, 'invalid_request_error'));
    return;
  }

  const promptTokens = estimateMessagesTokens(params.messages);

  // 流式处理
  if (isStream) {
    if (res.headersSent) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const callbacks = createSSECallbacks('anthropic' as InputFormat, res);
    let idx = 0;

    while (idx < ordered.length) {
      const model = ordered[idx++];
      const providerType = toProviderType(createModelProvider(model).type);
      const baseURL = model.url.replace(/\/$/, '');

      const proxyBody: Record<string, unknown> = stripUndefined({
        model: model.model_name,
        messages: params.messages as unknown as Array<Record<string, unknown>>,
        max_tokens: params.maxOutputTokens,
        temperature: params.temperature,
        top_p: params.topP,
        tools: params.tools as unknown as Array<Record<string, unknown>> | undefined,
        stream: true,
        stream_options: { include_usage: true },
      });
      if (params.system) proxyBody.system = params.system;
      if (body.stop_sequences) proxyBody.stop_sequences = body.stop_sequences;
      if (body.metadata) proxyBody.metadata = body.metadata;

      const proxy = pickProxy('anthropic' as InputFormat, providerType);
      if (!proxy) {
        callbacks.onError?.(new Error(`不支持的转换: anthropic→${providerType}`));
        callbacks.onDone?.();
        return;
      }

      try {
        await executeProxy(proxy, {
          baseUrl: baseURL,
          apiKey: model.api_key,
          providerLabel: `Anthropic→${providerType}`,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }, proxyBody, callbacks);

        trackApiCall(model.id);
        return;
      } catch (err) {
        const error = err as Error & { status?: number; statusCode?: number };
        const status = error.status || error.statusCode || 500;
        const errMsg = (err as Error).message;
        const errorType = err instanceof Error && err.name === 'TimeoutError' ? 'timeout_error' : 'upstream_error';
        console.error(`[proxy] Model "${model.name}" failed (${status}): ${errMsg}`);
        errorBroadcaster.emitError(model.id, model.name, errorType, `[${status}] ${errMsg}`);

        if (status === 400 && isMultimodalNotSupportedError(err)) {
          callbacks.onError?.(err as Error);
          callbacks.onDone?.();
          return;
        }
        db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);
      }
    }

    callbacks.onError?.(new Error('所有可用模型均失败'));
    callbacks.onDone?.();
    return;
  }

  // 非流式处理
  let result: any = null;
  try {
    result = await tryModelsSequentially(
      requestModelName,
      async (model: ModelRow) => {
        const provider = createModelProvider(model);

        if (provider.type === 'anthropic') {
          // 原生 Anthropic 调用 — 直接返回
          return callAnthropicMessages(provider, {
            ...params,
            maxOutputTokens: params.maxOutputTokens,
          });
        } else if (provider.type === 'openai-chat' || provider.type === 'openai-responses') {
          // OpenAI Chat → 转换为 Anthropic 格式
          const chatResult = await callOpenAIChat(provider, {
            ...params,
            maxOutputTokens: params.maxOutputTokens,
          });
          return convertOpenAIChatToAnthropicResponse(
            chatResult as unknown as Record<string, unknown>,
            body,
          );
        }
        return null;
      },
      userId,
    );
  } catch (err) {
    if (isMultimodalNotSupportedError(err)) {
      const status = (err as any).status || (err as any).statusCode || 400;
      res.status(status).json(toAnthropicError((err as Error).message, 'invalid_request_error'));
      return;
    }
    throw err;
  }

  if (!result) {
    res.status(503).json(toAnthropicError('所有模型均不可用', 'overloaded_error'));
    return;
  }

  // 记录 token 统计
  // result 可能是 Anthropic Message 格式或 Chat Completion 格式
  let usedModel = getAllModels(userId).find((m) => m.name === requestModelName);
  if (!usedModel) {
    usedModel = getAllModels(userId).filter((m) => !m.isDisable)[0];
  }

  // 尝试从不同格式提取 usage
  const usage = (result as any).usage;
  if (usage && usedModel) {
    if (usage.input_tokens !== undefined || usage.prompt_tokens !== undefined) {
      trackTokenUsage(usedModel.id, {
        prompt_tokens: usage.input_tokens ?? usage.prompt_tokens ?? 0,
        completion_tokens: usage.output_tokens ?? usage.completion_tokens ?? 0,
        total_tokens: (usage.input_tokens ?? usage.prompt_tokens ?? 0) + (usage.output_tokens ?? usage.completion_tokens ?? 0),
      });
    }
  } else if (usedModel) {
    trackTokenUsage(usedModel.id, {
      prompt_tokens: promptTokens,
      completion_tokens: estimateTextTokens(JSON.stringify(result)),
      total_tokens: promptTokens + estimateTextTokens(JSON.stringify(result)),
    });
  }
  trackApiCall(usedModel?.id);

  res.json(result);
}

// ========== 用户名前缀路由 ==========

const userRouter = Router({ mergeParams: true });

interface RequestWithUser extends Request {
  proxyUsername?: string;
  proxyUserId?: number;
}

// 记录用户名到 req 上，并查询 userId
userRouter.use((req: Request, _res: Response, next) => {
  const username = (req.params as Record<string, string>).username;
  if (username) {
    const reqWithUser = req as RequestWithUser;
    reqWithUser.proxyUsername = username;
    reqWithUser.proxyUserId = getUserIdByUsername(username) ?? undefined;
  }
  next();
});

// API Key 验证中间件
userRouter.use((req: Request, res: Response, next) => {
  const username = (req.params as Record<string, string>).username;
  if (!username) return next();

  const storedApiKey = getUserApiKey(username);
  if (!storedApiKey) {
    return next();
  }

  const authHeader = req.headers.authorization;
  let requestApiKey: string | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    requestApiKey = authHeader.slice(7);
  }

  if (!requestApiKey || requestApiKey !== storedApiKey) {
    res.status(401).json({
      error: {
        message: 'Invalid API key',
        type: 'authentication_error',
        code: 'invalid_api_key',
      },
    });
    return;
  }

  next();
});

// 用户级 API 路由
userRouter.get('/v1/test', async (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  const userId = reqWithUser.proxyUserId;
  const username = reqWithUser.proxyUsername;

  console.log('[test] Username:', username, 'UserId:', userId);

  // 获取所有模型（不过滤锁定和禁用状态，用于测试）
  const userModels = userId ? getAllModels(userId) : [];
  const globalModels = getAllModels(); // 无参数获取所有模型
  const available = [...userModels, ...globalModels.filter(m => !userModels.some(um => um.id === m.id))];

  console.log('[test] User models count:', userModels.length, 'Global models count:', globalModels.length, 'Total:', available.length);

  if (available.length === 0) {
    res.status(404).json({ error: { message: 'no available model', type: 'upstream_error', status: 503 } });
    return;
  }

  const requestedModel =
    typeof req.query.model === 'string' && req.query.model.trim() !== ''
      ? req.query.model.trim()
      : '';

  console.log('[test] Requested model:', requestedModel);

  const model = requestedModel
    ? available.find((m) => m.name === requestedModel || m.model_name === requestedModel)
    : available[0];

  if (!model) {
    console.log('[test] Model not found. Requested:', requestedModel);
    res.status(404).json({ error: { message: 'model not found', type: 'upstream_error', status: 404 } });
    return;
  }

  const queryContent =
    typeof req.query.content === 'string' && req.query.content.trim() !== ''
      ? req.query.content
      : 'hello';

  try {
    const provider = createModelProvider(model);
    const messages = [{ role: 'user' as const, content: queryContent }];
    const promptTokens = estimateMessagesTokens(messages);

    let chatResult: any;
    if (provider.type === 'anthropic') {
      // Anthropic SDK 要求使用流式调用
      const stream = await streamAnthropicMessages(provider, {
        messages,
        maxOutputTokens: MAX_RESPONSE_TOKENS,
      });

      let text = '';
      let usage: { input_tokens?: number; output_tokens?: number } | null = null;

      for await (const event of stream as any) {
        if (event.type === 'content_block_delta' && event.delta?.text) {
          text += event.delta.text;
        } else if (event.type === 'message_delta' && event.usage) {
          usage = event.usage;
        }
      }

      chatResult = {
        choices: [{ message: { content: text } }],
        usage: usage ? {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? 0,
          total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        } : null,
      };
    } else {
      chatResult = await callOpenAIChat(provider, {
        messages,
        maxOutputTokens: MAX_RESPONSE_TOKENS,
      });
    }

    if (chatResult.usage) {
      trackTokenUsage(model.id, chatResult.usage as any);
    } else if (chatResult.choices && chatResult.choices[0]) {
      const outputText =
        typeof chatResult.choices[0].message?.content === 'string'
          ? chatResult.choices[0].message.content
          : JSON.stringify(chatResult.choices[0]);
      const estimatedOutputTokens = estimateTextTokens(outputText);
      trackTokenUsage(model.id, {
        prompt_tokens: promptTokens,
        completion_tokens: estimatedOutputTokens,
        total_tokens: promptTokens + estimatedOutputTokens,
      });
    }

    res.json(chatResult);
  } catch (error: any) {
    console.error('[test] Error:', error?.message);
    const statusCode = error.response?.status || 500;
    res.status(statusCode).json({ error: { message: error.message, type: 'upstream_error', status: statusCode } });
  }
});

// 用户级模型列表
userRouter.get('/v1/models', (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  const userId = reqWithUser.proxyUserId;
  res.json({
    object: 'list',
    data: getAllModels(userId)
      .filter((m) => !m.isDisable)
      .map(buildOpenAIModel),
  });
});

// 用户级 Chat Completions
userRouter.post('/v1/chat/completions', (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  handleChatCompletions(req, res, reqWithUser.proxyUserId);
});

// 用户级 Responses API
userRouter.post('/v1/responses', (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  handleResponses(req, res, reqWithUser.proxyUserId);
});

// 用户级 Anthropic Messages API
userRouter.post('/v1/messages', (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  handleAnthropicMessages(req, res, reqWithUser.proxyUserId);
});

// 用户级 Anthropic Messages API 别名路径
userRouter.post('/v1/anthropic/messages', (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  handleAnthropicMessages(req, res, reqWithUser.proxyUserId);
});

// 用户级 Anthropic 兼容信息
userRouter.get('/v1/anthropic', (_req: Request, res: Response) => {
  res.json({
    type: 'info',
    message: 'Anthropic-compatible proxy endpoint',
    endpoints: {
      messages: '/v1/anthropic/messages',
      messages_legacy: '/v1/messages',
    },
    description: '使用此端点可作为 Anthropic Messages API 的代理，支持 Claude 系列模型及 OpenAI 兼容格式的自动转换',
  });
});

// 用户级 Ollama 兼容接口
userRouter.get('/api/tags', (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  const userId = reqWithUser.proxyUserId;
  res.json({
    models: getAvailableModels(userId).map((model) => ({
      name: model.name,
      model: model.name,
      remote_model: model.model_name,
      remote_host: model.url,
      modified_at: model.created_at,
      size: 342,
      digest: '',
      details: {
        parent_model: '',
        format: '',
        family: '',
        families: null,
        parameter_size: '',
        quantization_level: '',
        context_length: getEffectiveContentLength(model.max_content_length),
      },
      capabilities: parseModelCapabilities(model.capabilities),
    })),
  });
});

userRouter.post('/api/show', (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  const userId = reqWithUser.proxyUserId;
  const { model: name } = req.body as { model?: string };
  const models = getAvailableModels(userId);
  const model = name ? getModelByName(name, userId) : models[0];
  if (!model) {
    res.status(404).json({ error: 'model not found' });
    return;
  }
  const effectiveContentLength = getEffectiveContentLength(model.max_content_length);
  res.json({
    name: model.name,
    details: {
      parent_model: '',
      format: '',
      family: '',
      families: null,
      parameter_size: '32682372656',
      quantization_level: 'BF16',
    },
    model_info: {
      'custom.context_length': effectiveContentLength,
      'custom.embedding_length': 5376,
      'general.architecture': 'custom',
      'general.parameter_count': 32682372656,
    },
    capabilities: parseModelCapabilities(model.capabilities),
    modified_at: model.created_at,
  });
});

userRouter.get('/api/version', (_req: Request, res: Response) => {
  res.json({ version: '0.30.2' });
});

export { userRouter };
export default router;
