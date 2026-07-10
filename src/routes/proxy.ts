/**
 * Proxy 代理路由 —— 基于官方 SDK
 *
 * 特性：
 * - 根据 api_format 路由到 OpenAI Chat / Anthropic Messages / OpenAI Responses
 * - 故障转移：请求模型失败 → 按 sort_index 顺序尝试下一个可用模型，失败模型自动锁定 10 分钟
 * - isDisable=true 的模型不出现在可用池中，过期锁定自动清空
 * - 支持 tool_calls 完整转发
 * - Token 使用量追踪
 */

import { Router, Request, Response } from 'express';
import db from '../config/database';

import {
  createModelProvider,
  convertToOpenAIChatMessages,
  convertResponsesRequestToChatRequest,
  convertChatCompletionToResponse,
  convertOpenAIChatToAnthropicResponse,
  convertAnthropicRequestToCommon,
  toAnthropicError,
  mapToolChoice,
  mapStopSequences,
  callOpenAIChat,
  callAnthropic,
  callOpenAIResponses,
  callAnthropicMessages,
  streamAnthropicMessages,
  isModelLocked,
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
  type ModelRow,
  type GenericMessage,
  type ChatCallParams,
} from '../utils/format-convert';

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

import { trackTokenUsage } from '../utils/tokenTracker';
import { getUserApiKey } from '../config/database';
import { errorBroadcaster } from '../utils/errorBroadcaster';
import OpenAI from 'openai';

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
      return await tryFn(model);
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

// ========== 统一处理函数：Chat Completions ==========

async function handleChatCompletions(req: Request, res: Response, userId?: number): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const requestModelName = (body.model as string) || '';
  const isStream = body.stream === true;

  const ordered = getOrderedModels(requestModelName, userId);
  if (ordered.length === 0) {
    res.status(503).json({
      error: { message: '没有可用的模型', type: 'upstream_error', status: 503 },
    });
    return;
  }

  const params = buildChatParams(body);
  const promptTokens = estimateMessagesTokens(params.messages);

  if (isStream) {
    if (res.headersSent) return;

    let idx = 0;
    while (idx < ordered.length) {
      const model = ordered[idx++];
      const provider = createModelProvider(model);

      try {
        if (provider.type === 'anthropic') {
          await processAnthropicStream(
            provider,
            { ...params, system: body.system as string, maxOutputTokens: params.maxTokens },
            res,
            { modelId: model.id, promptTokens },
          );
        } else {
          const client = provider.client as OpenAI;
          const stream = await client.chat.completions.create(
            {
              model: provider.modelName,
              messages: params.messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
              max_tokens: params.maxTokens,
              temperature: params.temperature,
              top_p: params.topP,
              tools: params.tools
                ? params.tools.map((t) => ({ type: 'function' as const, function: t.function }))
                : undefined,
              tool_choice: params.toolChoice as OpenAI.Chat.ChatCompletionToolChoiceOption | undefined,
              stream: true,
              stream_options: { include_usage: true },
            } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
            { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
          );

          await processChatStream(stream, res, provider.modelName, {
            modelId: model.id,
            promptTokens,
          });
        }
        return;
      } catch (err) {
        const error = err as Error & { status?: number; statusCode?: number };
        const status = error.status || error.statusCode || 500;
        const errMsg = (err as Error).message;
        const errorType = err instanceof Error && err.name === 'TimeoutError' ? 'timeout_error' : 'chat_stream_error';
        console.error(`[chat stream] Model "${model.name}" failed (${status}): ${errMsg}`, {
          error: err,
          model: { id: model.id, name: model.name, api_format: model.api_format },
          requestModelName,
        });
        errorBroadcaster.emitError(model.id, model.name, errorType, `[${status}] ${errMsg}`);

        // 不支持多模态等客户端错误：直接返回，不锁定模型、不故障转移
        if (status === 400 && isMultimodalNotSupportedError(err)) {
          if (!res.headersSent) {
            res.status(400).json({
              error: { message: errMsg, type: 'invalid_request_error', status: 400 },
            });
          }
          return;
        }

        db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);

        if (res.headersSent) {
          try { writeSSE(res, { error: { message: errMsg, type: 'server_error' } }); } catch { /* ignore */ }
          res.end();
          return;
        }
        if (idx < ordered.length) continue;

        console.error(`[chat stream] All models failed. Last error:`, err);
        res.status(503).json({
          error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 },
        });
        return;
      }
    }
    return;
  }

  // 非流式
  let usedModel: ModelRow | undefined;
  let result: any = null;
  try {
    result = await tryModelsSequentially(
      requestModelName,
      async (model: ModelRow) => {
        const provider = createModelProvider(model);
        usedModel = model;

        if (provider.type === 'anthropic') {
          return callAnthropic(provider, {
            ...params,
            maxOutputTokens: params.maxTokens,
          });
        } else {
          return callOpenAIChat(provider, {
            ...params,
            maxOutputTokens: params.maxTokens,
          });
        }
      },
      userId,
    );
  } catch (err) {
    // 不支持多模态等客户端错误：直接返回错误
    if (isMultimodalNotSupportedError(err)) {
      const status = (err as any).status || (err as any).statusCode || 400;
      res.status(status).json({
        error: { message: (err as Error).message, type: 'invalid_request_error', status },
      });
      return;
    }
    throw err;
  }

  if (!result) {
    res.status(503).json({
      error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 },
    });
    return;
  }

  if (result.usage) {
    trackTokenUsage(usedModel?.id, result.usage as any);
  } else if (usedModel) {
    trackTokenUsage(usedModel.id, {
      prompt_tokens: promptTokens,
      completion_tokens: estimateTextTokens(JSON.stringify(result)),
      total_tokens: promptTokens + estimateTextTokens(JSON.stringify(result)),
    });
  }

  res.json(result);
}

// ========== previous_response_id 缓存 ==========

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

async function handleResponses(req: Request, res: Response, userId?: number): Promise<void> {
  const body = req.body as Record<string, unknown>;
  const requestModelName = (body.model as string) || '';
  const isStream = body.stream === true;

  // 转换 Responses 请求为 Chat 请求（用于 Chat/Anthropic 路径）
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

  const ordered = getOrderedModels(requestModelName, userId);
  if (ordered.length === 0) {
    res.status(503).json({
      error: { message: '没有可用的模型', type: 'upstream_error', status: 503 },
    });
    return;
  }

  // 流式处理
  if (isStream) {
    if (res.headersSent) return;

    let idx = 0;
    while (idx < ordered.length) {
      const model = ordered[idx++];
      const provider = createModelProvider(model);
      const baseURL = model.url.replace(/\/$/, '');

      try {
        if (provider.type === 'anthropic') {
          // Anthropic 非流式调用 → 转为 Chat Completion 格式 → 包装为单 chunk 流
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
        } else if (provider.type === 'openai-responses') {
          // 原生 Responses API → 使用 HTTP fetch 直接代理
          // 避免 OpenAI SDK 与非标准 Responses 端点的兼容问题
          const prevResponseId = body.previous_response_id
            ? (body.previous_response_id as string)
            : getCachedResponseId(baseURL, provider.modelName);

          const upstreamBody: Record<string, unknown> = {
            model: provider.modelName,
            input: (body as any).input || [],
            max_output_tokens: params.maxTokens,
            temperature: params.temperature,
            top_p: params.topP,
            stream: true,
          };

          // 透传 optional 字段
          if (body.instructions) upstreamBody.instructions = body.instructions;
          if (body.tools) upstreamBody.tools = body.tools;
          if (body.tool_choice) upstreamBody.tool_choice = body.tool_choice;
          if (body.reasoning) upstreamBody.reasoning = body.reasoning;
          if (body.text) upstreamBody.text = body.text;
          if (prevResponseId) upstreamBody.previous_response_id = prevResponseId;

          await processResponsesFetchStream(
            `${baseURL}/responses`,
            model.api_key,
            upstreamBody,
            res,
            { modelId: model.id },
          );
        } else {
          // openai-chat → Chat Completions API → 转换为 Responses SSE
          const client = provider.client as OpenAI;
          const stream = await client.chat.completions.create(
            {
              model: provider.modelName,
              messages: params.messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
              max_tokens: params.maxTokens,
              temperature: params.temperature,
              top_p: params.topP,
              tools: params.tools
                ? params.tools.map((t) => ({ type: 'function' as const, function: t.function }))
                : undefined,
              tool_choice: params.toolChoice as OpenAI.Chat.ChatCompletionToolChoiceOption | undefined,
              stream: true,
              stream_options: { include_usage: true },
            } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
            { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
          );

          await streamChatAsResponsesV2(stream, res, provider.modelName, {
            modelId: model.id,
            promptTokens,
          });
        }
        return;
      } catch (err) {
        const error = err as Error & { status?: number; statusCode?: number };
        const status = error.status || error.statusCode || 500;
        const errMsg = (err as Error).message;
        const errorType = err instanceof Error && err.name === 'TimeoutError' ? 'timeout_error' : 'responses_stream_error';
        console.error(`[responses stream] Model "${model.name}" failed (${status}): ${errMsg}`);
        errorBroadcaster.emitError(model.id, model.name, errorType, `[${status}] ${errMsg}`);

        // 不支持多模态等客户端错误：直接返回，不锁定模型、不故障转移
        if (status === 400 && isMultimodalNotSupportedError(err)) {
          if (!res.headersSent) {
            res.status(400).json({
              error: { message: errMsg, type: 'invalid_request_error', status: 400 },
            });
          }
          return;
        }

        db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);

        if (res.headersSent) {
          try { writeSSE(res, { error: { message: errMsg, type: 'server_error' } }); } catch { /* ignore */ }
          res.end();
          return;
        }
        if (idx < ordered.length) continue;

        console.error(`[responses stream] All models failed. Last error:`, err);
        res.status(503).json({
          error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 },
        });
        return;
      }
    }
    return;
  }

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
          return callAnthropic(provider, {
            ...params,
            system: chatBody.system as string,
            maxOutputTokens: params.maxTokens,
          });
        } else if (provider.type === 'openai-responses') {
          return callOpenAIResponses(provider, {
            ...params,
            maxOutputTokens: params.maxTokens,
          }, body);
        } else {
          return callOpenAIChat(provider, {
            ...params,
            maxOutputTokens: params.maxTokens,
          });
        }
      },
      userId,
    );
  } catch (err) {
    if (isMultimodalNotSupportedError(err)) {
      const status = (err as any).status || (err as any).statusCode || 400;
      res.status(status).json({
        error: { message: (err as Error).message, type: 'invalid_request_error', status },
      });
      return;
    }
    throw err;
  }

  if (!result) {
    res.status(503).json({
      error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 },
    });
    return;
  }

  if (result.usage) {
    trackTokenUsage(usedModel?.id, result.usage as any);
  } else if (usedModel) {
    trackTokenUsage(usedModel.id, {
      prompt_tokens: promptTokens,
      completion_tokens: estimateTextTokens(JSON.stringify(result)),
      total_tokens: promptTokens + estimateTextTokens(JSON.stringify(result)),
    });
  }

  // 使用增强版 buildResponsesResponse 构建完整响应
  const responseResult = buildResponsesResponse(result as Record<string, unknown>, body);
  res.json(responseResult);
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

    // Anthropic SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let idx = 0;
    while (idx < ordered.length) {
      const model = ordered[idx++];
      const provider = createModelProvider(model);

      try {
        if (provider.type === 'anthropic') {
          // 原生 Anthropic 流 — 直接转发原始 SSE 事件
          const anthropicStream = await streamAnthropicMessages(provider, {
            ...params,
            maxOutputTokens: params.maxOutputTokens,
          });

          let usage: { input_tokens?: number; output_tokens?: number } | null = null;

          for await (const event of anthropicStream as unknown as AsyncIterable<Record<string, unknown>>) {
            if (res.writableEnded) break;

            const eventType = event.type as string;
            const eventData = event as any;

            // 捕获 usage
            if (eventType === 'message_delta' && eventData.usage) {
              usage = eventData.usage;
            }

            // 直接转发原始 Anthropic SSE 事件
            writeSSEEvent(res, eventType, event);
          }

          // 记录 token 统计
          if (usage && model.id) {
            trackTokenUsage(model.id, {
              prompt_tokens: usage.input_tokens ?? 0,
              completion_tokens: usage.output_tokens ?? 0,
              total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            });
          } else if (model.id) {
            trackTokenUsage(model.id, {
              prompt_tokens: promptTokens,
              completion_tokens: 0,
              total_tokens: promptTokens,
            });
          }

          res.write('data: [DONE]\n\n');
          res.end();
        } else if (provider.type === 'openai-chat' || provider.type === 'openai-responses') {
          // OpenAI Chat/Responses → Anthropic SSE 转换
          const client = provider.client as OpenAI;
          const stream = await client.chat.completions.create(
            {
              model: provider.modelName,
              messages: params.messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
              max_tokens: params.maxOutputTokens,
              temperature: params.temperature,
              top_p: params.topP,
              tools: params.tools
                ? params.tools.map((t) => ({ type: 'function' as const, function: t.function }))
                : undefined,
              stream: true,
              stream_options: { include_usage: true },
            } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
            { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
          );

          await streamChatAsAnthropicSSE(stream, res, provider.modelName, promptTokens, model.id);
        }
        return;
      } catch (err) {
        const error = err as Error & { status?: number; statusCode?: number };
        const status = error.status || error.statusCode || 500;
        const errMsg = (err as Error).message;
        const errorType = err instanceof Error && err.name === 'TimeoutError' ? 'timeout_error' : 'anthropic_stream_error';
        console.error(`[anthropic messages stream] Model "${model.name}" failed (${status}): ${errMsg}`);
        errorBroadcaster.emitError(model.id, model.name, errorType, `[${status}] ${errMsg}`);

        // 不支持多模态等客户端错误：直接返回，不锁定模型、不故障转移
        if (status === 400 && isMultimodalNotSupportedError(err)) {
          if (!res.headersSent) {
            res.status(400).json(toAnthropicError(errMsg, 'invalid_request_error'));
          } else {
            writeSSEEvent(res, 'error', { type: 'error', error: { type: 'invalid_request_error', message: errMsg } });
            res.end();
          }
          return;
        }

        db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);

        if (res.headersSent) {
          try { writeSSEEvent(res, 'error', { type: 'error', error: { type: 'overloaded_error', message: 'Stream error' } }); } catch { /* ignore */ }
          res.end();
          return;
        }
        if (idx < ordered.length) continue;

        console.error(`[anthropic messages stream] All models failed. Last error:`, err);

        // 尝试写入错误事件（headers 可能已发送）
        if (!res.headersSent) {
          res.status(503).json(toAnthropicError('所有模型均不可用', 'overloaded_error'));
        } else {
          writeSSEEvent(res, 'error', { type: 'error', error: { type: 'overloaded_error', message: '所有模型均不可用' } });
          res.end();
        }
        return;
      }
    }
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

  res.json(result);
}

// ========== 路由挂载 ==========

// GET /v1/models
router.get('/v1/models', (_req: Request, res: Response) => {
  res.json({
    object: 'list',
    data: getAllModels()
      .filter((m) => !m.isDisable)
      .map(buildOpenAIModel),
  });
});

// POST /v1/chat/completions
router.post('/v1/chat/completions', (req: Request, res: Response) => {
  handleChatCompletions(req, res);
});

// POST /v1/responses
router.post('/v1/responses', (req: Request, res: Response) => {
  handleResponses(req, res);
});

// POST /v1/messages — Anthropic Messages API
router.post('/v1/messages', (req: Request, res: Response) => {
  handleAnthropicMessages(req, res);
});

// POST /v1/anthropic/messages — Anthropic Messages API 别名路径
router.post('/v1/anthropic/messages', (req: Request, res: Response) => {
  handleAnthropicMessages(req, res);
});

// GET /v1/anthropic — Anthropic 兼容信息
router.get('/v1/anthropic', (_req: Request, res: Response) => {
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

// ========== Ollama 兼容接口 ==========

router.get('/api/tags', (_req: Request, res: Response) => {
  res.json({
    models: getAvailableModels().map((model) => ({
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

router.post('/api/show', (req: Request, res: Response) => {
  const { model: name } = req.body as { model?: string };
  const models = getAvailableModels();
  const model = name ? getModelByName(name) : models[0];
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

router.get('/api/version', (_req: Request, res: Response) => {
  res.json({ version: '0.30.2' });
});

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
  console.log('[test] Available models:', available.map(m => ({ name: m.name, model_name: m.model_name, id: m.id, user_id: m.user_id, isDisable: m.isDisable })));

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

// 挂载根路由（处理未在 userRouter 上面明确定义的路由）
userRouter.use(router);

export { userRouter };
export default router;
