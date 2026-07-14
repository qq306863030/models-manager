/**
 * Responses API SSE 流式转换器
 *
 * 提供完整的 Responses API SSE 事件序列，适配 Codex/Copilot 等客户端。
 *
 * 两种工作模式：
 *   1. Chat Conversion — 将 Chat Completions SSE 流转换为 Responses API SSE 事件
 *   2. Native Proxy    — 直接转发上游 Responses API 的 SSE 事件（HTTP fetch）
 *
 * 完整事件序列：
 *   response.created
 *   response.in_progress
 *   response.output_item.added (message)
 *   response.content_part.added
 *   (response.output_text.delta)*     ← 主文本流
 *   response.output_text.done
 *   response.content_part.done
 *   response.output_item.done
 *   [response.output_item.added (function_call)
 *    (response.function_call_arguments.delta)*
 *    response.function_call_arguments.done
 *    response.output_item.done]*      ← 工具调用
 *   response.completed                 ← 含 usage
 */

import { Response } from 'express';
import OpenAI from 'openai';
import { generateRandomString, REQUEST_TIMEOUT_MS } from './model-provider';
import { trackTokenUsage, trackApiCall } from './tokenTracker';

// ========== 类型定义 ==========

export interface ResponsesStreamOptions {
  modelId?: number;
  promptTokens?: number;
}

interface ToolCallState {
  id: string;
  name: string;
  arguments: string;
  functionCallItemId: string;
  outputIndex: number;
  started: boolean;
  done: boolean;
}

interface StreamState {
  responseId: string;
  messageItemId: string;
  createdAt: number;
  text: string;
  usage: OpenAI.CompletionUsage | null;
  toolCalls: ToolCallState[];
  messageStarted: boolean;
  messageContentStarted: boolean;
  messageDone: boolean;
  completed: boolean;
}

// ========== SSE 写入辅助 ==========

/** 写入标准 SSE data 行 */
function writeSSE(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** 写入命名 SSE 事件（event + data） */
function writeSSEEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ========== SSE 头部设置 ==========

function setSSEHeaders(res: Response): void {
  if (res.headersSent) return;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

// ========== 工具函数 ==========

function buildResponseBase(
  responseId: string,
  createdAt: number,
  modelName: string,
  status: string = 'in_progress',
  output?: Array<Record<string, unknown>>,
  usage?: Record<string, unknown> | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    error: null,
    incomplete_details: null,
    model: modelName,
    output: output || [],
  };
  if (status === 'completed' && usage) {
    base.usage = usage;
  }
  return base;
}

function buildUsage(
  usage: OpenAI.CompletionUsage | null,
  promptTokens?: number,
  text?: string,
): Record<string, unknown> | null {
  if (usage) {
    return {
      input_tokens: usage.prompt_tokens,
      output_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    };
  }
  if (promptTokens || text) {
    return {
      input_tokens: promptTokens || 0,
      output_tokens: text ? Math.ceil(text.length / 3) : 0,
      total_tokens: (promptTokens || 0) + (text ? Math.ceil(text.length / 3) : 0),
    };
  }
  return null;
}

// ========== Chat → Responses SSE 转换 ==========

/**
 * 将 Chat Completions 流式 chunk 转换为完整的 Responses API SSE 事件序列。
 *
 * 修复了原实现中缺失的生命周期事件（content_part.added、content_part.done 等），
 * 确保 Codex/Copilot 能正确解析流。
 */
export async function streamChatAsResponses(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  res: Response,
  modelName: string,
  options?: ResponsesStreamOptions,
): Promise<void> {
  // ---- 初始化状态 ----
  const state: StreamState = {
    responseId: `resp_${generateRandomString(12)}`,
    messageItemId: `msg_${generateRandomString(12)}`,
    createdAt: Math.floor(Date.now() / 1000),
    text: '',
    usage: null,
    toolCalls: [],
    messageStarted: false,
    messageContentStarted: false,
    messageDone: false,
    completed: false,
  };

  setSSEHeaders(res);

  // == 阶段 1: response.created + response.in_progress ==
  const responseBase = buildResponseBase(state.responseId, state.createdAt, modelName, 'in_progress');
  writeSSEEvent(res, 'response.created', { type: 'response.created', response: responseBase });
  writeSSEEvent(res, 'response.in_progress', { type: 'response.in_progress', response: responseBase });

  // ---- 辅助函数 ----

  const startMessage = () => {
    if (state.messageStarted) return;
    state.messageStarted = true;

    writeSSEEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: state.messageItemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
  };

  const startMessageContent = () => {
    startMessage();
    if (state.messageContentStarted) return;
    state.messageContentStarted = true;

    writeSSEEvent(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: state.messageItemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const handleToolCallChunk = (tc: unknown, toolIndex: number) => {
    const tcAny = tc as {
      index: number;
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    };

    // 确保 tool call 状态存在
    while (state.toolCalls.length <= tcAny.index) {
      const fcId = `fc_${generateRandomString(12)}`;
      const outputIdx = toolIndex + state.toolCalls.length + 1; // message 占用 index 0
      state.toolCalls.push({
        id: '',
        name: '',
        arguments: '',
        functionCallItemId: fcId,
        outputIndex: outputIdx,
        started: false,
        done: false,
      });
    }

    const tcEntry = state.toolCalls[tcAny.index];

    // 第一帧：包含 id 和 name → 发出 output_item.added
    if (tcAny.id && !tcEntry.started) {
      tcEntry.id = tcAny.id;
      if (tcAny.function?.name) tcEntry.name = tcAny.function.name;
      tcEntry.started = true;

      writeSSEEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: tcEntry.outputIndex,
        item: {
          id: tcEntry.functionCallItemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: tcEntry.id,
          name: tcEntry.name,
          arguments: '',
        },
      });
    }

    // 收集 arguments
    if (tcAny.function?.arguments) {
      // 如果还没 start（只有 arguments 没有 id），先缓存但不发事件
      if (!tcEntry.started) {
        tcEntry.arguments += tcAny.function.arguments;
        return;
      }

      tcEntry.arguments += tcAny.function.arguments;

      writeSSEEvent(res, 'response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: tcEntry.functionCallItemId,
        output_index: tcEntry.outputIndex,
        delta: tcAny.function.arguments,
      });
    }
  };

  const finishMessage = () => {
    if (!state.messageContentStarted || state.messageDone) return;
    state.messageDone = true;

    // 只有在确实有文本内容时才发送 done 事件
    writeSSEEvent(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      item_id: state.messageItemId,
      output_index: 0,
      content_index: 0,
      text: state.text,
    });
    writeSSEEvent(res, 'response.content_part.done', {
      type: 'response.content_part.done',
      item_id: state.messageItemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: state.text, annotations: [] },
    });
    writeSSEEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: state.messageItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: state.text, annotations: [] }],
      },
    });
  };

  const finishToolCalls = () => {
    for (const tcEntry of state.toolCalls) {
      if (!tcEntry.started || tcEntry.done) continue;
      tcEntry.done = true;

      // 发出 arguments.done 事件
      writeSSEEvent(res, 'response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: tcEntry.functionCallItemId,
        output_index: tcEntry.outputIndex,
        name: tcEntry.name,
        arguments: tcEntry.arguments || '{}',
      });

      // 发出 output_item.done
      writeSSEEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: tcEntry.outputIndex,
        item: {
          id: tcEntry.functionCallItemId,
          type: 'function_call',
          status: 'completed',
          call_id: tcEntry.id,
          name: tcEntry.name,
          arguments: tcEntry.arguments || '{}',
        },
      });
    }
  };

  const completeResponse = () => {
    if (state.completed) return;
    state.completed = true;

    // 1. 完成消息（无内容时注入零宽字符防止 Copilot 空响应报错）
    if (!state.text && state.toolCalls.length === 0) {
      state.text = '\u2060';
      startMessageContent();
    }
    finishMessage();
    // 2. 完成工具调用
    finishToolCalls();

    // 3. 构建 output 数组
    const output: Array<Record<string, unknown>> = [];

    // 添加消息 output
    if (state.text) {
      output.push({
        id: state.messageItemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: state.text, annotations: [] }],
      });
    }

    // 添加工具调用 output
    for (const tcEntry of state.toolCalls) {
      if (!tcEntry.started) continue;
      output.push({
        id: tcEntry.functionCallItemId,
        type: 'function_call',
        status: 'completed',
        call_id: tcEntry.id,
        name: tcEntry.name,
        arguments: tcEntry.arguments || '{}',
      });
    }

    // 4. 计算 usage
    const usage = buildUsage(state.usage, options?.promptTokens, state.text);

    // 5. 追踪 token
    if (state.usage && options?.modelId) {
      trackTokenUsage(options.modelId, state.usage);
    } else if (options?.modelId) {
      trackTokenUsage(options.modelId, {
        prompt_tokens: options.promptTokens || 0,
        completion_tokens: state.text ? Math.ceil(state.text.length / 3) : 0,
        total_tokens: (options.promptTokens || 0) + (state.text ? Math.ceil(state.text.length / 3) : 0),
      });
    }
    trackApiCall(options?.modelId);

    // 6. 发出 response.completed
    writeSSEEvent(res, 'response.completed', {
      type: 'response.completed',
      response: buildResponseBase(state.responseId, state.createdAt, modelName, 'completed', output, usage),
    });

    res.write('data: [DONE]\n\n');
    res.end();
  };

  // ---- 主循环：处理流式 chunk ----
  try {
    for await (const chunk of stream) {
      if (state.completed || res.writableEnded) break;

      if (chunk.usage) state.usage = chunk.usage;
      if (!chunk.choices || !chunk.choices[0]) continue;

      const delta = chunk.choices[0].delta || {};
      const finishReason = chunk.choices[0].finish_reason;

      // 文本内容
      if (typeof delta.content === 'string' && delta.content) {
        startMessageContent();
        state.text += delta.content;
        writeSSEEvent(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: state.messageItemId,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
        });
      }

      // 工具调用
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
          handleToolCallChunk(tc, 0);
        }
      }

      // 流结束
      if (finishReason) {
        completeResponse();
        return;
      }
    }

    // 循环正常结束但未收到 finish_reason
    if (!state.completed) {
      completeResponse();
    }
  } catch (err) {
    console.error('[responses stream from chat] fatal:', err);
    if (!res.writableEnded) {
      // 输出错误
      if (state.messageContentStarted && !state.messageDone) {
        finishMessage();
      }
      writeSSE(res, { type: 'error', error: { message: 'Stream error', type: 'server_error' } });
      res.end();
    }
  }
}

// ========== 原生 Responses API 流代理 ==========

/**
 * 直接代理上游 Responses API 的 SSE 事件。
 *
 * 使用 HTTP fetch 而非 SDK，避免 SDK 版本兼容性问题。
 * 支持自动回退到非流式（当上游不支持流式时）。
 */
export async function processResponsesFetchStream(
  upstreamUrl: string,
  apiKey: string,
  requestBody: Record<string, unknown>,
  res: Response,
  options?: ResponsesStreamOptions,
): Promise<void> {
  const modelName = (requestBody.model as string) || 'unknown';
  let controller = new AbortController();

  setSSEHeaders(res);

  // 发送初始事件
  const responseId = `resp_${generateRandomString(12)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const responseBase = buildResponseBase(responseId, createdAt, modelName, 'in_progress');

  writeSSEEvent(res, 'response.created', { type: 'response.created', response: responseBase });
  writeSSEEvent(res, 'response.in_progress', { type: 'response.in_progress', response: responseBase });

  // 尝试流式请求，失败时回退到非流式
  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...requestBody, stream: true }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!upstreamResponse.ok) {
      // 流式失败，尝试非流式回退
      const errorText = await upstreamResponse.text().catch(() => '');
      console.error(`[responses fetch] upstream error ${upstreamResponse.status}: ${errorText.slice(0, 500)}`);

      // 如果上游不支持流式，回退到非流式
      if (shouldFallbackToNonStream(upstreamResponse.status, errorText)) {
        await fallbackToNonStream(upstreamUrl, apiKey, requestBody, res, modelName, responseId, createdAt, options);
        return;
      }

      // 否则返回错误
      writeSSEEvent(res, 'response.failed', {
        type: 'response.failed',
        response: buildResponseBase(responseId, createdAt, modelName, 'failed'),
        error: { message: `Upstream error: ${upstreamResponse.status}`, type: 'upstream_error' },
      });
      if (!res.writableEnded) res.end();
      return;
    }

    const contentType = upstreamResponse.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('text/event-stream') || !upstreamResponse.body) {
      // 不是 SSE 流，尝试非流式回退
      try {
        const jsonBody = await upstreamResponse.json() as Record<string, unknown>;
        await emitJsonResponse(jsonBody, res, modelName, responseId, createdAt, options);
      } catch {
        writeSSEEvent(res, 'response.failed', {
          type: 'response.failed',
          response: buildResponseBase(responseId, createdAt, modelName, 'failed'),
          error: { message: 'Unexpected response format from upstream', type: 'upstream_error' },
        });
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // 正常处理 SSE 流
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null = null;
    let forwardedEventTypes = new Set<string>();

    while (true) {
      if (res.writableEnded) {
        controller.abort();
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let currentEvent = '';
      let currentData = '';

      for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim();
          continue;
        }

        if (trimmed.startsWith('data:')) {
          currentData = trimmed.slice(5).trim();
        } else if (trimmed === '' && currentData) {
          // 空行 = SSE 事件结束
          const eventType = currentEvent || 'message';
          if (currentData === '[DONE]') {
            // 上游 DONE，但我们可能还需要发 response.completed
            break;
          }

          try {
            const parsedEvent = JSON.parse(currentData) as Record<string, unknown>;

            // 透传转发事件（保留原始格式）
            forwardedEventTypes.add(eventType);

            // 捕获 usage
            if (eventType === 'response.completed' || eventType === 'response.done') {
              const resp = (parsedEvent.response || parsedEvent) as Record<string, unknown>;
              if (resp.usage) {
                usage = resp.usage as { input_tokens?: number; output_tokens?: number; total_tokens?: number };
              }
            }

            writeSSEEvent(res, eventType, parsedEvent);

            if (eventType === 'response.completed' || eventType === 'response.done') {
              // 追踪 token
              if (usage && options?.modelId) {
                trackTokenUsage(options.modelId, {
                  prompt_tokens: usage.input_tokens ?? 0,
                  completion_tokens: usage.output_tokens ?? 0,
                  total_tokens: usage.total_tokens ?? ((usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)),
                });
              }

              res.write('data: [DONE]\n\n');
              res.end();
              return;
            }
          } catch {
            // 解析失败，跳过
          }

          currentEvent = '';
          currentData = '';
        }
      }
    }

    // 流结束但未收到 completed 事件
    if (!res.writableEnded) {
      // 发送缺失的 completed 事件
      writeSSEEvent(res, 'response.completed', {
        type: 'response.completed',
        response: buildResponseBase(responseId, createdAt, modelName, 'completed', [], buildUsage(null, options?.promptTokens)),
      });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (err) {
    console.error('[responses fetch] fatal:', err);
    if (!res.writableEnded) {
      // 错误回退：尝试非流式
      try {
        await fallbackToNonStream(upstreamUrl, apiKey, requestBody, res, modelName, responseId, createdAt, options);
      } catch {
        if (!res.writableEnded) {
          writeSSEEvent(res, 'response.failed', {
            type: 'response.failed',
            response: buildResponseBase(responseId, createdAt, modelName, 'failed'),
            error: { message: (err as Error).message, type: 'server_error' },
          });
          res.end();
        }
      }
    }
  }
}

/**
 * 判断上游错误是否应回退到非流式
 */
function shouldFallbackToNonStream(status: number, errorText: string): boolean {
  if (status >= 500) return true;
  const normalized = errorText.toLowerCase();
  return (
    normalized.includes('stream') &&
    (normalized.includes('unsupported') ||
      normalized.includes('not support') ||
      normalized.includes('not implement'))
  );
}

/**
 * 非流式回退：重新请求 non-streaming 并输出 JSON 响应
 */
async function fallbackToNonStream(
  upstreamUrl: string,
  apiKey: string,
  requestBody: Record<string, unknown>,
  res: Response,
  modelName: string,
  responseId: string,
  createdAt: number,
  options?: ResponsesStreamOptions,
): Promise<void> {
  console.log('[responses fetch] falling back to non-stream');

  const response = await fetch(upstreamUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ ...requestBody, stream: false }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Upstream non-stream error: ${response.status}`);
  }

  const jsonBody = await response.json() as Record<string, unknown>;
  await emitJsonResponse(jsonBody, res, modelName, responseId, createdAt, options);
}

/**
 * 将 JSON 响应体作为 SSE 事件序列输出
 */
async function emitJsonResponse(
  jsonBody: Record<string, unknown>,
  res: Response,
  modelName: string,
  responseId: string,
  createdAt: number,
  options?: ResponsesStreamOptions,
): Promise<void> {
  // 从响应中提取文本
  const outputItems = Array.isArray(jsonBody.output) ? jsonBody.output as Array<Record<string, unknown>> : [];
  let fullText = '';

  for (const item of outputItems) {
    if (item.type === 'message') {
      const contentParts = Array.isArray(item.content) ? item.content as Array<Record<string, unknown>> : [];
      for (const part of contentParts) {
        if (part.type === 'output_text' && part.text) {
          fullText += (part.text as string);
        }
      }
    }
  }

  // 构建 output
  const output: Array<Record<string, unknown>> = [];
  if (fullText) {
    const msgId = `msg_${generateRandomString(12)}`;
    output.push({
      id: msgId,
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: fullText, annotations: [] }],
    });
  }

  // 工具调用
  for (const item of outputItems) {
    if (item.type === 'function_call') {
      output.push({
        id: item.id || `fc_${generateRandomString(12)}`,
        type: 'function_call',
        status: 'completed',
        call_id: item.call_id || item.id || '',
        name: item.name || '',
        arguments: item.arguments || '{}',
      });
    }
  }

  // usage
  const usage = jsonBody.usage as Record<string, unknown> | undefined;
  const mappedUsage = usage
    ? {
        input_tokens: (usage as any).input_tokens ?? (usage as any).prompt_tokens ?? 0,
        output_tokens: (usage as any).output_tokens ?? (usage as any).completion_tokens ?? 0,
        total_tokens: (usage as any).total_tokens ?? 0,
      }
    : buildUsage(null, options?.promptTokens, fullText);

  // 追踪 token
  if (options?.modelId && mappedUsage) {
    trackTokenUsage(options.modelId, {
      prompt_tokens: (mappedUsage as any).input_tokens ?? 0,
      completion_tokens: (mappedUsage as any).output_tokens ?? 0,
      total_tokens: (mappedUsage as any).total_tokens ?? 0,
    });
  }

  // 发出 completed 事件
  writeSSEEvent(res, 'response.completed', {
    type: 'response.completed',
    response: {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      status: 'completed',
      model: modelName,
      output,
      usage: mappedUsage,
      error: null,
      incomplete_details: null,
    },
  });

  res.write('data: [DONE]\n\n');
  res.end();
}

// ========== 非流式响应构建 ==========

/**
 * 从 Chat Completion 响应构建完整的 Responses API 响应。
 *
 * 比原 convertChatCompletionToResponse 更完整：
 * - 添加 status、incomplete_details 字段
 * - output.content.annotations 数组确保存在
 * - 更完整的 usage 映射
 */
export function buildResponsesResponse(
  chatCompletion: Record<string, unknown>,
  requestBody: Record<string, unknown>,
): Record<string, unknown> {
  const choices = (chatCompletion.choices as Array<Record<string, unknown>> | undefined);
  const choice: Record<string, unknown> = (choices?.[0]) || {};
  const message: Record<string, unknown> = (choice.message as Record<string, unknown>) || {};
  const output: Array<Record<string, unknown>> = [];

  // 工具调用
  const toolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      const tcAny = tc as { id?: string; function?: { name?: string; arguments?: string } };
      output.push({
        id: tcAny.id || `fc_${generateRandomString(12)}`,
        type: 'function_call',
        status: 'completed',
        call_id: tcAny.id || `call_${generateRandomString(12)}`,
        name: tcAny.function?.name || '',
        arguments: tcAny.function?.arguments || '{}',
      });
    }
  }

  // 文本内容
  const content = message.content as string | null | undefined;
  if (content) {
    output.push({
      id: `msg_${generateRandomString(12)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: content,
          annotations: [],
        },
      ],
    });
  }

  // usage 映射
  const chatUsage = chatCompletion.usage as
    | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    | undefined;
  const usage = chatUsage
    ? {
        input_tokens: chatUsage.prompt_tokens ?? 0,
        output_tokens: chatUsage.completion_tokens ?? 0,
        total_tokens: chatUsage.total_tokens ?? ((chatUsage.prompt_tokens ?? 0) + (chatUsage.completion_tokens ?? 0)),
      }
    : null;

  // 输出文本拼接
  const outputText = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => ((item.content as Array<Record<string, unknown>>) || []).filter((p) => p.type === 'output_text'))
    .map((p) => p.text as string)
    .join('');

  return {
    id: (chatCompletion.id as string) || `resp_${generateRandomString(12)}`,
    object: 'response',
    created_at: (chatCompletion.created as number) || Math.floor(Date.now() / 1000),
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: requestBody.instructions || null,
    max_output_tokens: requestBody.max_output_tokens || requestBody.max_tokens || null,
    model: (chatCompletion.model as string) || (requestBody.model as string),
    output,
    output_text: outputText,
    parallel_tool_calls: requestBody.parallel_tool_calls ?? true,
    previous_response_id: requestBody.previous_response_id || null,
    reasoning: requestBody.reasoning || null,
    store: requestBody.store ?? false,
    temperature: requestBody.temperature ?? null,
    text: requestBody.text || { format: { type: 'text' } },
    tool_choice: requestBody.tool_choice || 'auto',
    tools: requestBody.tools || [],
    top_p: requestBody.top_p ?? null,
    truncation: requestBody.truncation || 'disabled',
    usage,
  };
}
