/**
 * SSE 流解析工具
 *
 * 提供通用的 SSE 流解析能力，供 ChatCompletionsProxy 和 ResponsesProxy 共用。
 * 支持 Node.js ReadableStream（fetch response.body）的 SSE 解析。
 */

import type { SSECallbacks, ConnectionStatus } from './types';
import { isRetryableError } from './fetch-with-retry';

// ========== SSE 流解析 ==========

/**
 * 解析 SSE 流（适用于 Node.js fetch response.body）
 *
 * 使用方法：
 * ```ts
 * const response = await fetch(url, options);
 * const reader = response.body!.getReader();
 * await parseSSEStream(reader, callbacks, abortSignal);
 * ```
 */
export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SSECallbacks,
  abortSignal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (abortSignal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();

        // 跳过空行和注释行
        if (!trimmed || trimmed.startsWith(':')) continue;

        // 处理 [DONE] 标记
        if (trimmed === 'data: [DONE]') {
          callbacks.onDone?.();
          return;
        }

        // 解析 data: 前缀
        if (!trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);

        try {
          const data = JSON.parse(jsonStr);
          callbacks.onContent?.(JSON.stringify(data)); // 由调用方的具体处理器进一步解析
        } catch {
          // 解析失败跳过，可能是不完整的 JSON
        }
      }
    }

    // 流正常结束
    callbacks.onDone?.();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      callbacks.onDone?.();
      return;
    }
    callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Chat Completions SSE 流解析器
 *
 * 解析 OpenAI Chat Completions 格式的 SSE 流，处理：
 * - 文本内容 delta
 * - 思考/推理内容（reasoning_content）
 * - 工具调用 delta（按 index 累积）
 * - Token 用量统计
 */
export async function parseChatCompletionsStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SSECallbacks,
  abortSignal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  // 工具调用累积状态（按 index 跟踪）
  const pendingToolCalls = new Map<number, {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>();

  try {
    while (true) {
      if (abortSignal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed === 'data: [DONE]') {
          // 流完成 — 输出所有累积的工具调用
          for (const toolCall of pendingToolCalls.values()) {
            callbacks.onToolCall?.(toolCall);
          }
          pendingToolCalls.clear();
          callbacks.onDone?.();
          return;
        }

        if (!trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);

        try {
          const chunk = JSON.parse(jsonStr);
          const choice = chunk.choices?.[0];
          const hasUsage = chunk.usage != null;

          // 先用变量记下 usage，稍后再处理（确保 tool_calls / finish_reason 先处理完）
          let pendingUsage = hasUsage
            ? {
                prompt_tokens: chunk.usage.prompt_tokens ?? 0,
                completion_tokens: chunk.usage.completion_tokens ?? 0,
                total_tokens: chunk.usage.total_tokens ?? 0,
                prompt_cache_hit_tokens: chunk.usage.prompt_cache_hit_tokens,
              }
            : null;

          if (!choice) {
            // 没有 choice（例如单独的 usage chunk），仍然要触发 onUsage
            if (pendingUsage && callbacks.onUsage) {
              callbacks.onUsage(pendingUsage);
              pendingUsage = null;
            }
            continue;
          }

          const delta = choice.delta;

          // 思考/推理内容
          if (delta.reasoning_content) {
            callbacks.onThinking?.(delta.reasoning_content);
          }

          // 文本内容
          if (delta.content) {
            callbacks.onContent?.(delta.content);
          }

          // 工具调用 delta — 按 index 累积
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              let pending = pendingToolCalls.get(tc.index);
              if (!pending && tc.id) {
                pending = {
                  id: tc.id,
                  type: 'function',
                  function: { name: '', arguments: '' },
                };
                pendingToolCalls.set(tc.index, pending);
              }
              if (pending) {
                if (tc.function?.name) {
                  pending.function.name += tc.function.name;
                  callbacks.onToolDelta?.(tc.function.name, {
                    id: pending.id,
                    index: tc.index,
                    name: pending.function.name,
                    field: 'name',
                  });
                }
                if (tc.function?.arguments) {
                  pending.function.arguments += tc.function.arguments;
                  callbacks.onToolDelta?.(tc.function.arguments, {
                    id: pending.id,
                    index: tc.index,
                    name: pending.function.name,
                    field: 'arguments',
                  });
                }
              }
            }
          }

          // finish_reason — 输出已完成的工具调用
          if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
            for (const toolCall of pendingToolCalls.values()) {
              callbacks.onToolCall?.(toolCall);
            }
            pendingToolCalls.clear();
          }

          // Token 用量 — 最后处理（确保 tool_calls / finish_reason 已先发完）
          if (pendingUsage && callbacks.onUsage) {
            callbacks.onUsage(pendingUsage);
          }
        } catch {
          // JSON 解析失败跳过
        }
      }
    }

    callbacks.onDone?.();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      callbacks.onDone?.();
      return;
    }
    callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * Responses API SSE 流解析器
 *
 * 解析 OpenAI Responses 格式的 SSE 流，处理：
 * - response.output_text.delta（文本 delta）
 * - response.reasoning_text.delta（推理 delta）
 * - response.function_call_arguments.delta/done（工具调用）
 * - response.completed（完成事件 + usage）
 * - response.failed（失败事件）
 */
export async function parseResponsesStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: SSECallbacks,
  abortSignal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';

  // 工具调用累积状态
  const pendingToolCalls = new Map<number, {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>();
  const emittedToolCallKeys = new Set<string>();

  // 文本/推理去重 key
  const emittedTextKeys = new Set<string>();
  const emittedReasoningKeys = new Set<string>();

  try {
    while (true) {
      if (abortSignal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':') || !trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();

        if (data === '[DONE]') {
          // 流完成 — 输出剩余工具调用
          for (const toolCall of pendingToolCalls.values()) {
            if (!emittedToolCallKeys.has(toolCall.id)) {
              callbacks.onToolCall?.(toolCall);
              emittedToolCallKeys.add(toolCall.id);
            }
          }
          pendingToolCalls.clear();
          callbacks.onDone?.();
          return;
        }

        try {
          const event = JSON.parse(data) as Record<string, unknown>;
          const type = typeof event.type === 'string' ? event.type : '';

          switch (type) {
            // ===== 文本 delta =====
            case 'response.output_text.delta':
            case 'response.refusal.delta': {
              const delta = typeof event.delta === 'string' ? event.delta : '';
              if (delta) {
                const itemId = typeof event.item_id === 'string' ? event.item_id : 'item';
                const contentIndex = typeof event.content_index === 'number' ? event.content_index : 0;
                const textKey = `${itemId}:${contentIndex}`;
                if (!emittedTextKeys.has(textKey)) {
                  emittedTextKeys.add(textKey);
                }
                callbacks.onContent?.(delta);
              }
              break;
            }

            // ===== 推理 delta =====
            case 'response.reasoning_text.delta':
            case 'response.reasoning_summary_text.delta': {
              const delta = typeof event.delta === 'string' ? event.delta : '';
              if (delta) {
                const itemId = typeof event.item_id === 'string' ? event.item_id : 'reasoning';
                const contentIndex = typeof event.content_index === 'number'
                  ? event.content_index
                  : typeof event.summary_index === 'number'
                    ? event.summary_index
                    : 0;
                const reasoningKey = `${itemId}:${contentIndex}`;
                if (!emittedReasoningKeys.has(reasoningKey)) {
                  emittedReasoningKeys.add(reasoningKey);
                }
                callbacks.onThinking?.(delta);
              }
              break;
            }

            // ===== 工具调用 delta/done =====
            case 'response.function_call_arguments.delta':
            case 'response.function_call_arguments.done': {
              const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;
              let pending = pendingToolCalls.get(outputIndex);
              if (!pending) {
                pending = {
                  id: typeof event.item_id === 'string' ? event.item_id : `call_${outputIndex}`,
                  type: 'function',
                  function: { name: '', arguments: '' },
                };
                pendingToolCalls.set(outputIndex, pending);
              }
              if (typeof event.name === 'string' && !pending.function.name) {
                pending.function.name = event.name;
              }
              if (type === 'response.function_call_arguments.delta' && typeof event.delta === 'string') {
                pending.function.arguments += event.delta;
              }
              if (type === 'response.function_call_arguments.done' && typeof event.arguments === 'string') {
                pending.function.arguments = event.arguments;
              }
              // done 事件时输出完整工具调用
              if (type === 'response.function_call_arguments.done' && !emittedToolCallKeys.has(pending.id)) {
                callbacks.onToolCall?.(pending);
                emittedToolCallKeys.add(pending.id);
                pendingToolCalls.delete(outputIndex);
              }
              break;
            }

            // ===== 完成事件 =====
            case 'response.completed': {
              const responseObject = event.response as Record<string, unknown> | undefined;
              const usage = responseObject?.usage as Record<string, unknown> | undefined;
              if (usage && callbacks.onUsage) {
                callbacks.onUsage({
                  prompt_tokens: Number(usage.input_tokens ?? 0),
                  completion_tokens: Number(usage.output_tokens ?? 0),
                  total_tokens: Number(usage.total_tokens ?? 0),
                });
              }
              break;
            }

            // ===== 失败事件 =====
            case 'response.failed': {
              const responseObject = event.response as Record<string, unknown> | undefined;
              const error = responseObject?.error as Record<string, unknown> | undefined;
              const message = typeof error?.message === 'string' ? error.message : 'Responses API request failed';
              callbacks.onError?.(new Error(message));
              break;
            }
          }
        } catch {
          // JSON 解析失败跳过
        }
      }
    }

    callbacks.onDone?.();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      callbacks.onDone?.();
      return;
    }
    callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
  }
}

// ========== HTTP 请求辅助 ==========

/** SSE 流式 HTTP POST 请求 */
export async function fetchSSEPost(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage: string;
    try {
      const errorJson = JSON.parse(errorText);
      errorMessage = errorJson.error?.message || errorJson.message || errorText;
    } catch {
      errorMessage = errorText;
    }
    throw new Error(`API error (${response.status}): ${errorMessage}`);
  }

  return response;
}

// ========== 流式重试 ==========

/** streamWithRetry 配置 */
export interface StreamRetryOptions {
  /** 最大重试次数（默认 2） */
  maxRetries?: number;
  /** 提供商标签（用于日志） */
  providerLabel?: string;
  /** 重试间隔毫秒数（默认 800） */
  retryIntervalMs?: number;
  /** 当流中断并准备重试时，附带本次已经输出的内容文本 */
  onRetry?: (context: { attempt: number; emittedText: string }) => Promise<void> | void;
}

/**
 * 将已输出的 assistant 文本追加到下次重试请求中，避免流断开后上下文丢失。
 */
export function appendPartialAssistantContent<T extends Record<string, unknown>>(payload: T, partialText: string): T {
  const text = partialText?.trim();
  if (!text) return payload;

  const nextPayload = JSON.parse(JSON.stringify(payload)) as T;

  const messages = (nextPayload as Record<string, unknown>).messages;
  if (Array.isArray(messages)) {
    const nextMessages = messages as Array<Record<string, unknown>>;
    const lastMessage = nextMessages[nextMessages.length - 1] as Record<string, unknown> | undefined;
    if (!lastMessage) return nextPayload;
    const lastRole = typeof lastMessage.role === 'string' ? lastMessage.role : '';

    if (lastRole === 'assistant') {
      const currentContent = lastMessage.content;
      if (typeof currentContent === 'string') {
        lastMessage.content = `${currentContent}${text}`;
      } else if (Array.isArray(currentContent)) {
        lastMessage.content = [
          ...(currentContent as Array<Record<string, unknown>>),
          { type: 'text', text },
        ];
      } else {
        lastMessage.content = text;
      }
    } else {
      nextMessages.push({ role: 'assistant', content: text });
    }
    return nextPayload;
  }

  const input = (nextPayload as Record<string, unknown>).input;
  if (Array.isArray(input)) {
    const nextInput = input as Array<Record<string, unknown>>;
    const lastItem = nextInput[nextInput.length - 1] as Record<string, unknown> | undefined;
    if (!lastItem) return nextPayload;
    const lastRole = typeof lastItem.role === 'string' ? lastItem.role : '';

    if (lastRole === 'assistant') {
      const currentContent = lastItem.content;
      if (Array.isArray(currentContent)) {
        lastItem.content = [
          ...(currentContent as Array<Record<string, unknown>>),
          { type: 'output_text', text },
        ];
      } else {
        lastItem.content = [{ type: 'output_text', text }];
      }
    } else {
      nextInput.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    }
    return nextPayload;
  }

  return payload;
}

/**
 * 带自动重试的 fetch + SSE 流解析
 *
 * 封装整个 fetch → stream parse 生命周期，当 SSE 流在传输过程中
 * 被中断（对端关闭 socket / terminated）时，自动重试整个请求。
 *
 * 重试条件：
 * - 错误可重试（连接超时、50x、terminated、SocketError 等）
 * - 如果本次流已经输出了内容，会把这些内容带到下一次重试请求中，尽量让上游继续生成剩余内容。
 *
 * @param fetcher  返回 Response 的函数（可使用 fetchWithRetry）
 * @param parser   流解析函数（如 parseChatCompletionsStream / parseResponsesStream）
 * @param callbacks SSE 回调
 * @param options  重试配置
 */
export async function streamWithRetry(
  fetcher: () => Promise<Response>,
  parser: (reader: ReadableStreamDefaultReader<Uint8Array>, callbacks: SSECallbacks) => Promise<void>,
  callbacks: SSECallbacks,
  options?: StreamRetryOptions,
): Promise<void> {
  const maxRetries = options?.maxRetries ?? 2;
  const providerLabel = options?.providerLabel || 'Upstream';
  const retryIntervalMs = options?.retryIntervalMs ?? 800;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let emittedTextSinceLastAttempt = '';
    let streamError: Error | null = null;

    // 包装回调，追踪是否已向客户端发送内容
    const trackingCallbacks: SSECallbacks = {
      ...callbacks,
      onContent: (d) => {
        emittedTextSinceLastAttempt += d;
        callbacks.onContent?.(d);
      },
      onThinking: (d) => {
        emittedTextSinceLastAttempt += d;
        callbacks.onThinking?.(d);
      },
      onToolDelta: (d, info) => { callbacks.onToolDelta?.(d, info); },
      onToolCall: (t) => { callbacks.onToolCall?.(t); },
      // 拦截 onError：解析器内部 catch 后不会 re-throw，需要在此捕获以便重试
      onError: (e) => { streamError = e; },
    };

    try {
      if (attempt > 0) {
        console.warn(`[${providerLabel}] reconnecting (attempt ${attempt + 1}/${maxRetries + 1})...`);
      }
      callbacks.onConnectionStatus?.({ state: 'connected', attempt: attempt + 1, maxAttempts: maxRetries + 1 });

      const response = await fetcher();

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message || errorText;
        } catch {
          errorMessage = errorText;
        }
        const err = new Error(`${providerLabel} API error (${response.status}): ${errorMessage}`);
        (err as any).status = response.status;
        throw err;
      }

      if (!response.body) {
        throw new Error('No response body received');
      }

      callbacks.onConnectionStatus?.({ state: 'streaming', attempt: attempt + 1, maxAttempts: maxRetries + 1 });

      const reader = response.body.getReader();
      try {
        await parser(reader, trackingCallbacks);
      } finally {
        reader.releaseLock();
      }

      // 解析器内部 catch 后不 re-throw，检查是否有流错误
      if (streamError) {
        throw streamError;
      }

      return; // 成功完成
    } catch (error) {
      // 可重试：错误可重试即可重试，重试前把本次已输出内容附加到下次请求
      if (attempt < maxRetries && isRetryableError(error)) {
        const errMsg = error instanceof Error ? error.message : String(error);
        const emittedPreview = emittedTextSinceLastAttempt ? ` (replaying ${emittedTextSinceLastAttempt.length} chars)` : '';
        console.warn(`[${providerLabel}] stream interrupted, retrying (${attempt + 1}/${maxRetries})${emittedPreview}: ${errMsg}`);
        await options?.onRetry?.({ attempt: attempt + 1, emittedText: emittedTextSinceLastAttempt });
        callbacks.onConnectionStatus?.({
          state: 'error',
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          message: `连接中断，正在重试并携带已输出内容 (${attempt + 1}/${maxRetries})...`,
        });
        await new Promise((r) => setTimeout(r, retryIntervalMs));
        continue;
      }

      throw error;
    }
  }
}
