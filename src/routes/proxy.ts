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
  convertToAnthropicMessages,
  convertToOpenAIChatMessages,
  convertToAnthropicTools,
  convertAnthropicToChatCompletion,
  convertAnthropicStreamEvent,
  isModelLocked,
  LOCK_DURATION_MS,
  type ModelRow,
  type AIProvider,
  type GenericMessage,
  type OpenAITool,
} from '../utils/aiSdkProvider';
import {
  convertResponsesRequestToChatRequest,
  convertChatCompletionToResponse,
  generateRandomString,
} from '../utils/proxy';
import { trackTokenUsage } from '../utils/tokenTracker';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import OpenAI from 'openai';

const router = Router();
const MAX_RESPONSE_TOKENS = 64000;

// ========== 用户设置辅助 ==========

interface UserSettings {
  max_content_length: number;
  max_token: number;
}

function getUserSettings(): UserSettings {
  const settings = db.prepare('SELECT max_content_length, max_token FROM user_settings WHERE id = 1').get() as UserSettings | undefined;
  return settings || { max_content_length: 0, max_token: 0 };
}

function getEffectiveContentLength(modelContentLength: number): number {
  const settings = getUserSettings();
  return settings.max_content_length > 0 ? settings.max_content_length : modelContentLength;
}

// ========== 用户查询辅助 ==========

/** 根据用户名查询用户 ID */
function getUserIdByUsername(username: string): number | null {
  const user = db.prepare('SELECT id FROM users WHERE name = ?').get(username) as { id: number } | undefined;
  return user?.id ?? null;
}

// ========== 数据库读取辅助 ==========

function getAllModels(userId?: number): ModelRow[] {
  if (userId !== undefined) {
    return db
      .prepare(
        'SELECT * FROM models WHERE user_id = ? ORDER BY CASE WHEN sort_index = -1 THEN 999999 ELSE sort_index END ASC, created_at ASC'
      )
      .all(userId) as ModelRow[];
  }
  return db
    .prepare(
      'SELECT * FROM models ORDER BY CASE WHEN sort_index = -1 THEN 999999 ELSE sort_index END ASC, created_at ASC'
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

function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 3));
}

function estimateMessagesTokens(messages: GenericMessage[]): number {
  return estimateTextTokens(
    messages
      .map((m) => {
        const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
        return `${m.role || ''}:${content}`;
      })
      .join('\n')
  );
}

function getModelByName(name: string, userId?: number): ModelRow | undefined {
  if (userId !== undefined) {
    return db.prepare('SELECT * FROM models WHERE name = ? AND user_id = ?').get(name, userId) as ModelRow | undefined;
  }
  return db.prepare('SELECT * FROM models WHERE name = ?').get(name) as ModelRow | undefined;
}

function buildOpenAIModel(model: ModelRow) {
  const capabilities = model.capabilities
    ? JSON.parse(model.capabilities)
    : ['completion', 'tools', 'thinking'];
  const effectiveContentLength = getEffectiveContentLength(model.max_content_length);
  return {
    id: model.name,
    object: 'model',
    created: Math.floor(new Date(model.created_at).getTime() / 1000),
    owned_by: 'library',
    name: model.name,
    content_length: effectiveContentLength,
    capabilities,
  };
}

function parseModelCapabilities(raw?: string | null): string[] {
  if (!raw) return ['completion', 'tools', 'thinking'];
  try {
    return Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : ['completion', 'tools', 'thinking'];
  } catch {
    return ['completion', 'tools', 'thinking'];
  }
}

// ========== 故障转移核心 ==========

async function tryModelsSequentially<T>(
  requestModelName: string,
  tryFn: (model: ModelRow) => Promise<T> | T,
  userId?: number,
): Promise<T | null> {
  const now = Date.now();

  // 构建可用池
  let available = getAvailableModels(userId);

  if (available.length === 0) return null;

  // 命中的模型排首位
  const requestModel = available.find((m) => m.name === requestModelName);
  if (requestModel) {
    available = [requestModel, ...available.filter((m) => m.id !== requestModel.id)];
  }

  // 依次尝试
  for (const model of available) {
    try {
      return await tryFn(model);
    } catch (err) {
      const error = err as Error & { status?: number; statusCode?: number };
      const status = error.status || error.statusCode || 500;
      console.error(`[proxy] Model "${model.name}" failed (${status}): ${(err as Error).message}`);
      db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(now, model.id);
    }
  }

  return null;
}

// ========== 流式处理：SSE 写入辅助 ==========

function writeSSE(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function writeSSEEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ========== 流式处理：Chat Completion SSE ==========

function streamOpenAIChatCompletion(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  res: Response,
  modelName: string,
  modelId?: number,
  promptTokens = 0,
) {
  const completionId = `chatcmpl-${generateRandomString(12)}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let usage: OpenAI.CompletionUsage | null = null;
  let textContent = ''; // 用于估算输出 token

  (async () => {
    try {
      for await (const chunk of stream) {
        if (res.writableEnded) break;

        if (chunk.usage) usage = chunk.usage;

        // 收集文本内容用于估算
        const deltaContent = chunk.choices[0]?.delta?.content;
        if (typeof deltaContent === 'string') {
          textContent += deltaContent;
        }

        const delta = chunk.choices[0]?.delta || {};

        writeSSE(res, {
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [{ index: 0, delta, finish_reason: chunk.choices[0]?.finish_reason ?? null }],
        });
      }

      // 记录统计：优先使用 API 返回的 usage，否则使用估算值
      if (usage) {
        writeSSE(res, {
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          usage: {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
          },
        });
        trackTokenUsage(modelId, usage);
      } else if (textContent.length > 0) {
        // 厂商未返回 usage 时，使用估算值（中文约 1.5 字符/token，英文约 4 字符/token）
        const estimatedOutputTokens = Math.ceil(textContent.length / 3);
        const estimatedUsage = {
          prompt_tokens: promptTokens,
          completion_tokens: estimatedOutputTokens,
          total_tokens: promptTokens + estimatedOutputTokens,
        };
        trackTokenUsage(modelId, estimatedUsage);
      }

      // 发送 SSE 完成信号
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      console.error('[chat stream] fatal:', err);
      if (!res.writableEnded) res.end();
    }
  })();
}

// ========== 流式处理：Anthropic SSE ==========

function streamAnthropicMessages(
  stream: AsyncIterable<MessageStreamEvent>,
  res: Response,
  modelName: string,
  modelId?: number,
  promptTokens = 0,
) {
  const completionId = `chatcmpl-${generateRandomString(12)}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let usage: { input_tokens?: number; output_tokens?: number } | null = null;
  let textContent = ''; // 用于估算输出 token

  (async () => {
    try {
      for await (const event of stream) {
        if (res.writableEnded) break;

        // 捕获 usage
        const eventObj = event as unknown as Record<string, unknown>;
        if (event.type === 'message_delta') {
          const deltaEvent = eventObj as { usage?: { input_tokens?: number; output_tokens?: number } };
          if (deltaEvent.usage) usage = deltaEvent.usage;
        }

        // 收集文本内容用于估算
        if (event.type === 'content_block_delta') {
          const deltaEvent = eventObj as { delta?: { type?: string; text?: string } };
          if (deltaEvent.delta?.type === 'text_delta' && deltaEvent.delta?.text) {
            textContent += deltaEvent.delta.text;
          }
        }

        const chunk = convertAnthropicStreamEvent(event);
        if (chunk) {
          chunk.model = modelName;
          chunk.id = completionId;
          writeSSE(res, chunk);
        }
      }

      // 记录统计：优先使用 API 返回的 usage，否则使用估算值
      if (usage) {
        trackTokenUsage(modelId, {
          prompt_tokens: usage.input_tokens ?? 0,
          completion_tokens: usage.output_tokens ?? 0,
          total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
        });
      } else if (textContent.length > 0) {
        // 厂商未返回 usage 时，使用估算值（中文约 1.5 字符/token，英文约 4 字符/token）
        const estimatedOutputTokens = Math.ceil(textContent.length / 3);
        const estimatedUsage = {
          prompt_tokens: promptTokens,
          completion_tokens: estimatedOutputTokens,
          total_tokens: promptTokens + estimatedOutputTokens,
        };
        trackTokenUsage(modelId, estimatedUsage);
      }

      // 发送 SSE 完成信号
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      console.error('[anthropic stream] fatal:', err);
      if (!res.writableEnded) res.end();
    }
  })();
}


// ========== API 调用核心 ==========

async function callAnthropic(
  provider: AIProvider,
  params: {
    messages: GenericMessage[];
    system?: string;
    maxOutputTokens: number;
    temperature?: number;
    tools?: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
  }
): Promise<Record<string, unknown>> {
  const client = provider.client as Anthropic;
  const anthropicParams = convertToAnthropicMessages(params.messages, params.system);

  const response = await client.messages.create({
    model: provider.modelName,
    max_tokens: params.maxOutputTokens,
    messages: anthropicParams.messages,
    system: anthropicParams.system,
    temperature: params.temperature,
    tools: params.tools ? convertToAnthropicTools(params.tools as unknown as OpenAITool[]) : undefined,
    stream: false,
  });

  return convertAnthropicToChatCompletion(response, provider.modelName);
}

async function streamAnthropic(
  provider: AIProvider,
  params: {
    messages: GenericMessage[];
    system?: string;
    maxOutputTokens: number;
    temperature?: number;
    tools?: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
  },
  res: Response,
  modelId?: number,
  promptTokens = 0,
): Promise<void> {
  const client = provider.client as Anthropic;
  const anthropicParams = convertToAnthropicMessages(params.messages, params.system);

  const stream = await client.messages.stream({
    model: provider.modelName,
    max_tokens: params.maxOutputTokens,
    messages: anthropicParams.messages,
    system: anthropicParams.system,
    temperature: params.temperature,
    tools: params.tools ? convertToAnthropicTools(params.tools as unknown as OpenAITool[]) : undefined,
  });

  streamAnthropicMessages(stream as unknown as AsyncIterable<MessageStreamEvent>, res, provider.modelName, modelId, promptTokens);
}

async function callOpenAIChat(
  provider: AIProvider,
  params: {
    messages: GenericMessage[];
    maxOutputTokens: number;
    temperature?: number;
    topP?: number;
    tools?: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
    toolChoice?: string;
  }
): Promise<OpenAI.Chat.ChatCompletion> {
  const client = provider.client as OpenAI;

  const response = await client.chat.completions.create({
    model: provider.modelName,
    messages: params.messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
    max_tokens: params.maxOutputTokens,
    temperature: params.temperature,
    top_p: params.topP,
    tools: params.tools ? params.tools.map(t => ({ type: 'function' as const, function: t.function })) : undefined,
    tool_choice: params.toolChoice as OpenAI.Chat.ChatCompletionToolChoiceOption | undefined,
    stream: false,
  });

  return response;
}

async function streamOpenAIChat(
  provider: AIProvider,
  params: {
    messages: GenericMessage[];
    maxOutputTokens: number;
    temperature?: number;
    topP?: number;
    tools?: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
    toolChoice?: string;
  },
  res: Response,
  modelId?: number,
  promptTokens = 0,
): Promise<void> {
  const client = provider.client as OpenAI;

  const stream = await client.chat.completions.create({
    model: provider.modelName,
    messages: params.messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
    max_tokens: params.maxOutputTokens,
    temperature: params.temperature,
    top_p: params.topP,
    tools: params.tools ? params.tools.map(t => ({ type: 'function' as const, function: t.function })) : undefined,
    tool_choice: params.toolChoice as OpenAI.Chat.ChatCompletionToolChoiceOption | undefined,
    stream: true,
    stream_options: { include_usage: true },
  } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming);

  streamOpenAIChatCompletion(stream, res, provider.modelName, modelId, promptTokens);
}

async function callOpenAIResponses(
  provider: AIProvider,
  params: {
    messages: GenericMessage[];
    maxOutputTokens: number;
    temperature?: number;
    tools?: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
  },
  _originalBody: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const client = provider.client as OpenAI;

  // 转换 messages 为 Responses 格式
  const responseInput: Record<string, unknown>[] = [];

  for (const msg of params.messages) {
    if (msg.role === 'system') {
      responseInput.push({ type: 'input_text', text: msg.content || '' });
    } else if (msg.role === 'user') {
      responseInput.push({ type: 'input_text', text: msg.content || '' });
    } else if (msg.role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      if (msg.content) {
        parts.push({ type: 'output_text', text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            type: 'function_call',
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
      responseInput.push({ type: 'message', role: 'assistant', content: parts });
    } else if (msg.role === 'tool') {
      responseInput.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || '',
        output: msg.content || '',
      });
    }
  }

  const tools = params.tools?.map((t) => ({
    type: 'function',
    name: (t as unknown as { function: { name: string } }).function.name,
    description: (t as unknown as { function: { description?: string } }).function.description,
    parameters: (t as unknown as { function: { parameters: Record<string, unknown> } }).function.parameters,
  }));

  const response = await client.responses.create({
    model: provider.modelName,
    input: responseInput as unknown as any,
    max_output_tokens: params.maxOutputTokens,
    temperature: params.temperature,
    tools: tools as unknown as any,
    stream: false,
  });

  // 转换响应为 Chat Completion 格式
  const textParts = response.output.filter((o) => (o as unknown as { type: string }).type === 'text');
  const text = textParts.map((o) => (o as unknown as { text: string }).text).join('');

  const functionCalls = response.output.filter((o) => (o as unknown as { type: string }).type === 'function_call');
  const toolCalls = functionCalls.map((o) => {
    const fc = o as unknown as { call_id: string; name: string; arguments: unknown };
    return {
      id: fc.call_id,
      type: 'function' as const,
      function: {
        name: fc.name,
        arguments: typeof fc.arguments === 'string' ? fc.arguments : JSON.stringify(fc.arguments),
      },
    };
  });

  const message: Record<string, unknown> = { role: 'assistant', content: text || null };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
    message.content = null;
  }

  const result: Record<string, unknown> = {
    id: response.id,
    object: 'chat.completion',
    created: response.created_at,
    model: provider.modelName,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
  };

  if (response.usage) {
    result.usage = {
      prompt_tokens: response.usage.input_tokens,
      completion_tokens: response.usage.output_tokens,
      total_tokens: response.usage.input_tokens + response.usage.output_tokens,
    };
  }

  return result;
}

async function streamOpenAIResponses(
  provider: AIProvider,
  params: {
    messages: GenericMessage[];
    maxOutputTokens: number;
    temperature?: number;
    tools?: Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }>;
  },
  _originalBody: Record<string, unknown>,
  res: Response,
  modelId?: number,
): Promise<void> {
  const client = provider.client as OpenAI;

  // 转换 messages
  const responseInput: Record<string, unknown>[] = [];

  for (const msg of params.messages) {
    if (msg.role === 'system') {
      responseInput.push({ type: 'input_text', text: msg.content || '' });
    } else if (msg.role === 'user') {
      responseInput.push({ type: 'input_text', text: msg.content || '' });
    } else if (msg.role === 'assistant') {
      const parts: Record<string, unknown>[] = [];
      if (msg.content) {
        parts.push({ type: 'output_text', text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            type: 'function_call',
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
      responseInput.push({ type: 'message', role: 'assistant', content: parts });
    } else if (msg.role === 'tool') {
      responseInput.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id || '',
        output: msg.content || '',
      });
    }
  }

  const tools = params.tools?.map((t) => ({
    type: 'function',
    name: (t as unknown as { function: { name: string } }).function.name,
    description: (t as unknown as { function: { description?: string } }).function.description,
    parameters: (t as unknown as { function: { parameters: Record<string, unknown> } }).function.parameters,
  }));

  const stream = await client.responses.create({
    model: provider.modelName,
    input: responseInput as unknown as any,
    max_output_tokens: params.maxOutputTokens,
    temperature: params.temperature,
    tools: tools as unknown as any,
    stream: true,
  });

  // 使用自定义 SSE 处理
  const responseId = `resp_${generateRandomString(12)}`;
  const createdAt = Math.floor(Date.now() / 1000);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let text = '';
  let completed = false;

  writeSSEEvent(res, 'response.created', {
    type: 'response.created',
    response: { id: responseId, object: 'response', created_at: createdAt, status: 'in_progress' as const, model: provider.modelName, output: [], error: null },
  });

  (async () => {
    try {
      for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) {
        if (completed || res.writableEnded) break;

        if (event.type === 'response.output_text.delta') {
          const delta = (event as { delta: string }).delta;
          text += delta;
          writeSSEEvent(res, 'response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: (event as { item_id: string }).item_id,
            output_index: (event as { output_index: number }).output_index,
            content_index: (event as { content_index: number }).content_index,
            delta,
          });
        } else if (event.type === 'response.completed') {
          completed = true;
          const completedEvent = event as { response?: { id: string }; usage?: { input_tokens: number; output_tokens: number } };
          if (completedEvent.usage) {
            trackTokenUsage(modelId, {
              prompt_tokens: completedEvent.usage.input_tokens,
              completion_tokens: completedEvent.usage.output_tokens,
              total_tokens: completedEvent.usage.input_tokens + completedEvent.usage.output_tokens,
            });
          }
          writeSSEEvent(res, 'response.completed', {
            type: 'response.completed',
            response: {
              id: responseId,
              object: 'response',
              created_at: createdAt,
              status: 'completed' as const,
              model: provider.modelName,
              output: [{ id: completedEvent.response?.id, type: 'message' as const, role: 'assistant' as const, content: [{ type: 'output_text' as const, text }] }],
              usage: completedEvent.usage,
              error: null,
            },
          });
          writeSSE(res, 'data: [DONE]\n\n');
          res.end();
        }
      }
    } catch (err) {
      console.error('[responses stream] fatal:', err);
      if (!res.writableEnded) res.end();
    }
  })();
}

// 将 Chat Completion SSE 转换为 Responses API SSE 格式
function streamOpenAIChatAsResponses(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  res: Response,
  modelName: string,
  modelId?: number,
  promptTokens = 0,
) {
  const responseId = `resp_${generateRandomString(12)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl-${generateRandomString(12)}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // 发送 response.created 事件
  writeSSEEvent(res, 'response.created', {
    type: 'response.created',
    response: {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      status: 'in_progress' as const,
      model: modelName,
      output: [],
      error: null,
    },
  });

  let text = '';
  let messageId = `msg_${generateRandomString(12)}`;
  let toolCalls: Array<{
    id: string;
    type: 'function_call';
    status: 'in_progress' | 'completed';
    call_id: string;
    name: string;
    arguments: string;
  }> = [];
  let currentToolCallIndex = -1;
  let usage: OpenAI.CompletionUsage | null = null;
  let finished = false;

  (async () => {
    try {
      for await (const chunk of stream) {
        if (finished || res.writableEnded) break;

        if (chunk.usage) usage = chunk.usage;

        const delta = chunk.choices[0]?.delta || {};
        const finishReason = chunk.choices[0]?.finish_reason;

        // 处理文本内容
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          writeSSEEvent(res, 'response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: delta.content,
          });
        }

        // 处理 tool_calls
        if (delta.tool_calls && delta.tool_calls.length > 0) {
          for (const tc of delta.tool_calls) {
            if (tc.function?.name) {
              // 新的 tool_call 开始
              currentToolCallIndex++;
              const newToolCall = {
                id: `fc_${generateRandomString(12)}`,
                type: 'function_call' as const,
                status: 'in_progress' as const,
                call_id: tc.id || `call_${generateRandomString(12)}`,
                name: tc.function.name,
                arguments: tc.function.arguments || '',
              };
              toolCalls.push(newToolCall);
              writeSSEEvent(res, 'response.function_call_arguments_delta', {
                type: 'response.function_call_arguments_delta',
                item_id: newToolCall.id,
                output_index: 1 + currentToolCallIndex,
                call_id: newToolCall.call_id,
                name: newToolCall.name,
                delta: tc.function.arguments || '',
              });
            } else if (tc.function?.arguments) {
              // tool_call 参数增量
              const lastTc = toolCalls[toolCalls.length - 1];
              if (lastTc && lastTc.status === 'in_progress') {
                lastTc.arguments += tc.function.arguments;
                writeSSEEvent(res, 'response.function_call_arguments_delta', {
                  type: 'response.function_call_arguments_delta',
                  item_id: lastTc.id,
                  output_index: 1 + currentToolCallIndex,
                  call_id: lastTc.call_id,
                  delta: tc.function.arguments,
                });
              }
            }
          }
        }

        // 处理完成
        if (finishReason === 'stop' || finishReason === 'tool_calls') {
          finished = true;

          // 标记所有 tool_calls 为完成
          for (const tc of toolCalls) {
            tc.status = 'completed';
            writeSSEEvent(res, 'response.function_call_completed', {
              type: 'response.function_call_completed',
              item_id: tc.id,
              output_index: 0,
              call_id: tc.call_id,
              name: tc.name,
              arguments: tc.arguments,
            });
          }

          // 构建 output 数组
          const output: Array<Record<string, unknown>> = [];
          if (text) {
            output.push({
              id: messageId,
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text, annotations: [] }],
            });
          }
          output.push(...toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function_call',
            status: 'completed',
            call_id: tc.call_id,
            name: tc.name,
            arguments: tc.arguments,
          })));

          // 记录 token 使用
          if (usage) {
            trackTokenUsage(modelId, {
              prompt_tokens: usage.prompt_tokens,
              completion_tokens: usage.completion_tokens,
              total_tokens: usage.total_tokens,
            });
          } else {
            // 估算 token
            const estimatedOutputTokens = Math.ceil(text.length / 3);
            trackTokenUsage(modelId, {
              prompt_tokens: promptTokens,
              completion_tokens: estimatedOutputTokens,
              total_tokens: promptTokens + estimatedOutputTokens,
            });
          }

          writeSSEEvent(res, 'response.completed', {
            type: 'response.completed',
            response: {
              id: responseId,
              object: 'response',
              created_at: createdAt,
              status: 'completed' as const,
              model: modelName,
              output,
              usage: usage ? {
                input_tokens: usage.prompt_tokens,
                output_tokens: usage.completion_tokens,
              } : null,
              error: null,
            },
          });

          writeSSE(res, 'data: [DONE]\n\n');
          res.end();
        }
      }

      // 如果循环正常结束但未收到 finish_reason，手动发送完成事件
      if (!finished && !res.writableEnded) {
        const output: Array<Record<string, unknown>> = [];
        if (text) {
          output.push({
            id: messageId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
          });
        }

        writeSSEEvent(res, 'response.completed', {
          type: 'response.completed',
          response: {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            status: 'completed' as const,
            model: modelName,
            output,
            usage: usage ? {
              input_tokens: usage.prompt_tokens,
              output_tokens: usage.completion_tokens,
            } : null,
            error: null,
          },
        });

        writeSSE(res, 'data: [DONE]\n\n');
        res.end();
      }
    } catch (err) {
      console.error('[responses stream from chat] fatal:', err);
      if (!res.writableEnded) res.end();
    }
  })();
}

// ========== 路由实现 ==========

// GET /v1/models
router.get('/v1/models', (_req: Request, res: Response) => {
  res.json({
    object: 'list',
    data: getAllModels().filter((m) => !m.isDisable).map(buildOpenAIModel),
  });
});

// POST /v1/chat/completions
router.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const requestModelName = (body.model as string) || '';
  const isStream = body.stream === true;

  // 获取可用模型
  const allModels = getAvailableModels();
  const requestModel = allModels.find((m) => m.name === requestModelName);
  const ordered = requestModel
    ? [requestModel, ...allModels.filter((m) => m.id !== requestModel.id)]
    : allModels;

  if (ordered.length === 0) {
    res.status(503).json({ error: { message: '没有可用的模型', type: 'upstream_error', status: 503 } });
    return;
  }

  const messages = convertToOpenAIChatMessages((body.messages as any[]) || []);
  const promptTokens = estimateMessagesTokens(messages);
  const tools = body.tools ? body.tools as Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }> : undefined;
  // 用户设置的 max_token > 0 时完全覆盖，否则使用请求的 max_tokens（上限为 MAX_RESPONSE_TOKENS）
  const settingsMaxToken = getUserSettings().max_token;
  const maxTokens = settingsMaxToken > 0
    ? settingsMaxToken
    : Math.min((body.max_tokens as number) ?? MAX_RESPONSE_TOKENS, MAX_RESPONSE_TOKENS);

  // 流式处理
  if (isStream) {
    if (res.headersSent) return;

    let idx = 0;

    while (idx < ordered.length) {
      const model = ordered[idx++];
      const provider = createModelProvider(model);

      try {
        if (provider.type === 'anthropic') {
          await streamAnthropic(provider, {
            messages,
            system: body.system as string,
            maxOutputTokens: maxTokens,
            temperature: body.temperature as number | undefined,
            tools,
          }, res, model.id, promptTokens);
        } else {
          await streamOpenAIChat(provider, {
            messages,
            maxOutputTokens: maxTokens,
            temperature: body.temperature as number | undefined,
            topP: body.top_p as number | undefined,
            tools,
            toolChoice: body.tool_choice as string | undefined,
          }, res, model.id, promptTokens);
        }
        return;
      } catch (err) {
        const error = err as Error & { status?: number; statusCode?: number };
        const status = error.status || error.statusCode || 500;
        console.error(`[chat stream] Model "${model.name}" failed (${status}): ${(err as Error).message}`);
        db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);

        // 如果是流式响应且 headers 已发送（已开始返回数据），无法切换到其他模型
        if (isStream && res.headersSent) {
          console.error('[chat stream] Headers already sent, cannot switch to next model');
          return;
        }
        if (idx < ordered.length) continue;

        res.status(503).json({ error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 } });
        return;
      }
    }
  }

  // 非流式
  let usedModel: ModelRow | undefined;
  const result = await tryModelsSequentially(requestModelName, async (model: ModelRow) => {
    const provider = createModelProvider(model);
    usedModel = model;

    if (provider.type === 'anthropic') {
      return callAnthropic(provider, {
        messages,
        system: body.system as string,
        maxOutputTokens: maxTokens,
        temperature: body.temperature as number | undefined,
        tools,
      });
    } else {
      const chatResult = await callOpenAIChat(provider, {
        messages,
        maxOutputTokens: maxTokens,
        temperature: body.temperature as number | undefined,
        topP: body.top_p as number | undefined,
        tools,
        toolChoice: body.tool_choice as string | undefined,
      });
      return chatResult as unknown as Record<string, unknown>;
    }
  });

  if (!result) {
    res.status(503).json({ error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 } });
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
});

// POST /v1/responses
router.post('/v1/responses', async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>;
  const requestModelName = (body.model as string) || '';
  const isStream = body.stream === true;

  // 转换 Responses 请求为 Chat 请求
  const chatBody = convertResponsesRequestToChatRequest({
    ...body,
    model: requestModelName,
    max_tokens: Math.min(
      (body.max_output_tokens as number) ?? (body.max_tokens as number) ?? MAX_RESPONSE_TOKENS,
      MAX_RESPONSE_TOKENS
    ),
  });

  const messages = convertToOpenAIChatMessages((chatBody.messages as any[]) || []);
  const tools = chatBody.tools ? chatBody.tools as Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }> : undefined;
  // 用户设置的 max_token > 0 时完全覆盖，否则使用请求的 max_tokens（上限为 MAX_RESPONSE_TOKENS）
  const settingsMaxToken = getUserSettings().max_token;
  const maxTokens = settingsMaxToken > 0
    ? settingsMaxToken
    : Math.min((chatBody.max_tokens as number) ?? MAX_RESPONSE_TOKENS, MAX_RESPONSE_TOKENS);

  // 获取可用模型
  const allModels = getAvailableModels();
  const requestModel = allModels.find((m) => m.name === requestModelName);
  const ordered = requestModel
    ? [requestModel, ...allModels.filter((m) => m.id !== requestModel.id)]
    : allModels;

  if (ordered.length === 0) {
    res.status(503).json({ error: { message: '没有可用的模型', type: 'upstream_error', status: 503 } });
    return;
  }

  // 流式处理
  if (isStream) {
    if (res.headersSent) return;

    let idx = 0;

    while (idx < ordered.length) {
      const model = ordered[idx++];
      const provider = createModelProvider(model);

      try {
        if (provider.type === 'anthropic') {
          await streamAnthropic(provider, {
            messages,
            system: chatBody.system as string,
            maxOutputTokens: maxTokens,
            temperature: chatBody.temperature as number | undefined,
            tools,
          }, res, model.id);
        } else if (provider.type === 'openai-responses') {
          await streamOpenAIResponses(provider, {
            messages,
            maxOutputTokens: maxTokens,
            temperature: chatBody.temperature as number | undefined,
            tools,
          }, body, res, model.id);
        } else {
          // openai-chat 类型模型，使用 Chat Completions API 并转换为 Responses 格式
          const client = provider.client as OpenAI;
          const promptTokens = estimateMessagesTokens(messages);
          const stream = await client.chat.completions.create({
            model: provider.modelName,
            messages: messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
            max_tokens: maxTokens,
            temperature: chatBody.temperature as number | undefined,
            tools: tools ? tools.map(t => ({ type: 'function' as const, function: t.function })) : undefined,
            stream: true,
            stream_options: { include_usage: true },
          } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming);
          streamOpenAIChatAsResponses(stream, res, provider.modelName, model.id, promptTokens);
        }
        return;
      } catch (err) {
        const error = err as Error & { status?: number; statusCode?: number };
        const status = error.status || error.statusCode || 500;
        console.error(`[responses stream] Model "${model.name}" failed (${status}): ${(err as Error).message}`);
        db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);

        if (res.headersSent) return;
        if (idx < ordered.length) continue;

        res.status(503).json({ error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 } });
        return;
      }
    }
  }

  // 非流式
  const result = await tryModelsSequentially(requestModelName, async (model: ModelRow) => {
    const provider = createModelProvider(model);

    if (provider.type === 'anthropic') {
      return callAnthropic(provider, {
        messages,
        system: chatBody.system as string,
        maxOutputTokens: maxTokens,
        temperature: chatBody.temperature as number | undefined,
        tools,
      });
    } else if (provider.type === 'openai-responses') {
      return callOpenAIResponses(provider, {
        messages,
        maxOutputTokens: maxTokens,
        temperature: chatBody.temperature as number | undefined,
        tools,
      }, body);
    } else {
      const chatResult = await callOpenAIChat(provider, {
        messages,
        maxOutputTokens: maxTokens,
        temperature: chatBody.temperature as number | undefined,
        tools,
      });
      return chatResult as unknown as Record<string, unknown>;
    }
  });

  if (!result) {
    res.status(503).json({ error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 } });
    return;
  }

  const usedModel =
    getAllModels().find((m) => m.name === requestModelName) ??
    getAllModels().filter((m) => !m.isDisable)[0];

  if (result.usage) {
    trackTokenUsage(usedModel?.id, result.usage as any);
  }

  const responseResult = convertChatCompletionToResponse(result, body);
  res.json(responseResult);
});

// ========== Ollama 兼容接口 ==========

router.get('/api/tags', (_req: Request, res: Response) => {
  res.json({
    models: getAvailableModels()
      .map((model) => ({
        name: model.name,
        model: model.name,
        remote_model: model.model_name,
        remote_host: model.url,
        modified_at: model.created_at,
        size: 342,
        digest: generateRandomString(),
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
// 支持 /:username/v1/models, /:username/v1/chat/completions 等
// 挂载在 /:username 下，Express 会自动剥离 /:username 前缀，
// 因此 userRouter 内部收到的路径已是 /v1/models

const userRouter = Router({ mergeParams: true });

// 扩展 Request 类型，添加 userId
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

// 将请求代理到现有路由

userRouter.get('/v1/test', async (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  const userId = reqWithUser.proxyUserId;
  const available = getAvailableModels(userId);
  if (available.length === 0) {
    res.status(404).json({ error: { message: 'no available model', type: 'upstream_error', status: 503 } });
    return;
  }

  const requestedModel = typeof req.query.model === 'string' && req.query.model.trim() !== ''
    ? req.query.model.trim()
    : '';
  const model = requestedModel
    ? available.find((m) => m.name === requestedModel || m.model_name === requestedModel)
    : available[0];

  if (!model) {
    res.status(404).json({ error: { message: 'model not found', type: 'upstream_error', status: 404 } });
    return;
  }

  const queryContent = typeof req.query.content === 'string' && req.query.content.trim() !== ''
    ? req.query.content
    : 'hello';

  try {
    const provider = createModelProvider(model);
    const chatResult = await callOpenAIChat(provider, {
      messages: [{ role: 'user', content: queryContent }],
      maxOutputTokens: MAX_RESPONSE_TOKENS,
    });

    const promptTokens = estimateMessagesTokens([{ role: 'user', content: queryContent }]);

    if (chatResult.usage) {
      trackTokenUsage(model.id, chatResult.usage as any);
    } else if (chatResult.choices && chatResult.choices[0]) {
      const outputText = typeof chatResult.choices[0].message?.content === 'string'
        ? chatResult.choices[0].message.content : JSON.stringify(chatResult.choices[0]);
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

// ========== 用户级 API 路由（使用 proxyUserId 过滤） ==========

// GET /v1/models - 返回当前用户的可用模型
userRouter.get('/v1/models', (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  const userId = reqWithUser.proxyUserId;
  res.json({
    object: 'list',
    data: getAllModels(userId).filter((m) => !m.isDisable).map(buildOpenAIModel),
  });
});

// POST /v1/chat/completions - 用户级聊天补全
userRouter.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  const userId = reqWithUser.proxyUserId;
  const body = req.body as Record<string, unknown>;
  const requestModelName = (body.model as string) || '';
  const isStream = body.stream === true;

  const allModels = getAvailableModels(userId);
  const requestModel = allModels.find((m) => m.name === requestModelName);
  const ordered = requestModel
    ? [requestModel, ...allModels.filter((m) => m.id !== requestModel.id)]
    : allModels;

  if (ordered.length === 0) {
    res.status(503).json({ error: { message: '没有可用的模型', type: 'upstream_error', status: 503 } });
    return;
  }

  const messages = convertToOpenAIChatMessages((body.messages as any[]) || []);
  const promptTokens = estimateMessagesTokens(messages);
  const tools = body.tools ? body.tools as Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }> : undefined;
  const settingsMaxToken = getUserSettings().max_token;
  const maxTokens = settingsMaxToken > 0
    ? settingsMaxToken
    : Math.min((body.max_tokens as number) ?? MAX_RESPONSE_TOKENS, MAX_RESPONSE_TOKENS);

  if (isStream) {
    if (res.headersSent) return;

    let idx = 0;
    while (idx < ordered.length) {
      const model = ordered[idx++];
      const provider = createModelProvider(model);

      try {
        if (provider.type === 'anthropic') {
          await streamAnthropic(provider, {
            messages,
            system: body.system as string,
            maxOutputTokens: maxTokens,
            temperature: body.temperature as number | undefined,
            tools,
          }, res, model.id, promptTokens);
        } else {
          await streamOpenAIChat(provider, {
            messages,
            maxOutputTokens: maxTokens,
            temperature: body.temperature as number | undefined,
            topP: body.top_p as number | undefined,
            tools,
            toolChoice: body.tool_choice as string | undefined,
          }, res, model.id, promptTokens);
        }
        return;
      } catch (err) {
        const error = err as Error & { status?: number; statusCode?: number };
        const status = error.status || error.statusCode || 500;
        console.error(`[chat stream] Model "${model.name}" failed (${status}): ${(err as Error).message}`);
        db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);

        if (isStream && res.headersSent) {
          console.error('[chat stream] Headers already sent, cannot switch to next model');
          return;
        }
        if (idx < ordered.length) continue;

        res.status(503).json({ error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 } });
        return;
      }
    }
  }

  let usedModel: ModelRow | undefined;
  const result = await tryModelsSequentially(requestModelName, async (model: ModelRow) => {
    const provider = createModelProvider(model);
    usedModel = model;

    if (provider.type === 'anthropic') {
      return callAnthropic(provider, {
        messages,
        system: body.system as string,
        maxOutputTokens: maxTokens,
        temperature: body.temperature as number | undefined,
        tools,
      });
    } else {
      const chatResult = await callOpenAIChat(provider, {
        messages,
        maxOutputTokens: maxTokens,
        temperature: body.temperature as number | undefined,
        topP: body.top_p as number | undefined,
        tools,
        toolChoice: body.tool_choice as string | undefined,
      });
      return chatResult as unknown as Record<string, unknown>;
    }
  }, userId);

  if (!result) {
    res.status(503).json({ error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 } });
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
});

// POST /v1/responses - 用户级 Responses API
userRouter.post('/v1/responses', async (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  const userId = reqWithUser.proxyUserId;
  const body = req.body as Record<string, unknown>;
  const requestModelName = (body.model as string) || '';
  const isStream = body.stream === true;

  const chatBody = convertResponsesRequestToChatRequest({
    ...body,
    model: requestModelName,
    max_tokens: Math.min(
      (body.max_output_tokens as number) ?? (body.max_tokens as number) ?? MAX_RESPONSE_TOKENS,
      MAX_RESPONSE_TOKENS
    ),
  });

  const messages = convertToOpenAIChatMessages((chatBody.messages as any[]) || []);
  const tools = chatBody.tools ? chatBody.tools as Array<{ function: { name: string; description?: string; parameters: Record<string, unknown> } }> : undefined;
  const settingsMaxToken = getUserSettings().max_token;
  const maxTokens = settingsMaxToken > 0
    ? settingsMaxToken
    : Math.min((chatBody.max_tokens as number) ?? MAX_RESPONSE_TOKENS, MAX_RESPONSE_TOKENS);

  const allModels = getAvailableModels(userId);
  const requestModel = allModels.find((m) => m.name === requestModelName);
  const ordered = requestModel
    ? [requestModel, ...allModels.filter((m) => m.id !== requestModel.id)]
    : allModels;

  if (ordered.length === 0) {
    res.status(503).json({ error: { message: '没有可用的模型', type: 'upstream_error', status: 503 } });
    return;
  }

  if (isStream) {
    if (res.headersSent) return;

    let idx = 0;
    while (idx < ordered.length) {
      const model = ordered[idx++];
      const provider = createModelProvider(model);

      try {
        if (provider.type === 'anthropic') {
          await streamAnthropic(provider, {
            messages,
            system: chatBody.system as string,
            maxOutputTokens: maxTokens,
            temperature: chatBody.temperature as number | undefined,
            tools,
          }, res, model.id);
        } else if (provider.type === 'openai-responses') {
          await streamOpenAIResponses(provider, {
            messages,
            maxOutputTokens: maxTokens,
            temperature: chatBody.temperature as number | undefined,
            tools,
          }, body, res, model.id);
        } else {
          // openai-chat 类型模型，使用 Chat Completions API 并转换为 Responses 格式
          const client = provider.client as OpenAI;
          const promptTokens = estimateMessagesTokens(messages);
          const stream = await client.chat.completions.create({
            model: provider.modelName,
            messages: messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
            max_tokens: maxTokens,
            temperature: chatBody.temperature as number | undefined,
            tools: tools ? tools.map(t => ({ type: 'function' as const, function: t.function })) : undefined,
            stream: true,
            stream_options: { include_usage: true },
          } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming);
          streamOpenAIChatAsResponses(stream, res, provider.modelName, model.id, promptTokens);
        }
        return;
      } catch (err) {
        const error = err as Error & { status?: number; statusCode?: number };
        const status = error.status || error.statusCode || 500;
        console.error(`[responses stream] Model "${model.name}" failed (${status}): ${(err as Error).message}`);
        db.prepare('UPDATE models SET isLock = ? WHERE id = ?').run(Date.now(), model.id);

        if (res.headersSent) return;
        if (idx < ordered.length) continue;

        res.status(503).json({ error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 } });
        return;
      }
    }
  }

  const result = await tryModelsSequentially(requestModelName, async (model: ModelRow) => {
    const provider = createModelProvider(model);

    if (provider.type === 'anthropic') {
      return callAnthropic(provider, {
        messages,
        system: chatBody.system as string,
        maxOutputTokens: maxTokens,
        temperature: chatBody.temperature as number | undefined,
        tools,
      });
    } else if (provider.type === 'openai-responses') {
      return callOpenAIResponses(provider, {
        messages,
        maxOutputTokens: maxTokens,
        temperature: chatBody.temperature as number | undefined,
        tools,
      }, body);
    } else {
      const chatResult = await callOpenAIChat(provider, {
        messages,
        maxOutputTokens: maxTokens,
        temperature: chatBody.temperature as number | undefined,
        tools,
      });
      return chatResult as unknown as Record<string, unknown>;
    }
  }, userId);

  if (!result) {
    res.status(503).json({ error: { message: '所有模型均不可用', type: 'upstream_error', status: 503 } });
    return;
  }

  const usedModel =
    getAllModels(userId).find((m) => m.name === requestModelName) ??
    getAllModels(userId).filter((m) => !m.isDisable)[0];

  if (result.usage) {
    trackTokenUsage(usedModel?.id, result.usage as any);
  }

  const responseResult = convertChatCompletionToResponse(result, body);
  res.json(responseResult);
});

// GET /api/tags - Ollama 兼容（用户级）
userRouter.get('/api/tags', (req: Request, res: Response) => {
  const reqWithUser = req as RequestWithUser;
  const userId = reqWithUser.proxyUserId;
  res.json({
    models: getAvailableModels(userId)
      .map((model) => ({
        name: model.name,
        model: model.name,
        remote_model: model.model_name,
        remote_host: model.url,
        modified_at: model.created_at,
        size: 342,
        digest: generateRandomString(),
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

// POST /api/show - Ollama 兼容（用户级）
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

// GET /api/version - Ollama 兼容（无状态）
userRouter.get('/api/version', (_req: Request, res: Response) => {
  res.json({ version: '0.30.2' });
});

// 挂载根路由（处理未被 userRouter 上面明确定义的路由）
userRouter.use(router);

// 导出用户路由
export { userRouter };

export default router;
