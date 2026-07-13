/**
 * Express 桥接层 — 将 Proxy 框架集成到 Express 路由
 *
 * 提供：
 * - SSECallbacks → Express Response 的格式转换器（Chat/Responses/Anthropic SSE）
 * - pickProxy() 根据输入格式和提供商类型选择正确的 Proxy
 * - executeProxy() 便捷调用
 */

import { Response } from 'express';
import type { SSECallbacks, ChatCompletionsProxyInput, ResponsesProxyInput, AnthropicProxyInput, TokenUsage, ToolCallInfo } from './Proxy/common/types';
import BaseProxy from './Proxy/common/BaseProxy';
import ChatCompletionsProxy from './Proxy/ChatCompletionsProxy';
import ResponsesProxy from './Proxy/ResponsesProxy';
import AnthropicProxy from './Proxy/AnthropicProxy';
import ChatCompletionsToResponsesProxy from './Proxy/ChatCompletionsToResponsesProxy';
import ResponsesToChatProxy from './Proxy/ResponsesToChatProxy';
import AnthropicToChatProxy from './Proxy/AnthropicToChatProxy';
import ChatToAnthropicProxy from './Proxy/ChatToAnthropicProxy';
import AnthropicToResponsesProxy from './Proxy/AnthropicToResponsesProxy';
import ResponsesToAnthropicProxy from './Proxy/ResponsesToAnthropicProxy';

// ========== 常量 ==========

const INVISIBLE_SENTINEL = '\u2060';

// ========== SSE 写入器 ==========

/** 写入 SSE data 行 */
function writeSSE(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** 写入命名 SSE 事件 */
function writeSSEEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ========== SSECallbacks 工厂 ==========

/** 工具调用状态跟踪 */
interface PendingToolCall {
  id: string;
  index: number;
  name: string;
  arguments: string;
}

/**
 * 创建 Chat Completions SSE 回调
 *
 * 输出格式：
 *   data: {"choices":[{"delta":{"content":"..."},"index":0}]}
 *   data: {"choices":[{"delta":{"tool_calls":[...]},"index":0}]}
 *   data: [DONE]
 */
export function createChatSSECallbacks(res: Response): SSECallbacks {
  const pendingTools = new Map<number, PendingToolCall>();

  const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
    const chunk: Record<string, unknown> = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: '',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    writeSSE(res, chunk);
  };

  return {
    onContent: (delta: string) => {
      writeChunk({ content: delta });
    },
    onThinking: (delta: string) => {
      writeChunk({ reasoning_content: delta });
    },
    onToolDelta: (delta: string, info) => {
      let pending = pendingTools.get(info.index);
      if (!pending) {
        pending = { id: info.id, index: info.index, name: info.name, arguments: '' };
        pendingTools.set(info.index, pending);
        writeChunk({
          tool_calls: [{
            index: info.index,
            id: info.id,
            type: 'function',
            function: { name: info.name, arguments: '' },
          }],
        });
      }
      if (info.field === 'name' && info.name && info.name !== pending.name) {
        pending.name = info.name;
      } else if (info.field === 'arguments') {
        pending.arguments += delta;
        writeChunk({ tool_calls: [{ index: info.index, function: { arguments: delta } }] });
      }
    },
    onToolCall: (toolCall: ToolCallInfo) => {
      writeChunk({
        tool_calls: [{
          index: 0,
          id: toolCall.id,
          type: 'function',
          function: { name: toolCall.function.name, arguments: toolCall.function.arguments },
        }],
      });
    },
    onUsage: (usage: TokenUsage) => {
      writeChunk({ content: INVISIBLE_SENTINEL }, 'stop');
      writeSSE(res, {
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
        },
      });
    },
    onDone: () => {
      res.write('data: [DONE]\n\n');
    },
    onError: (error: Error) => {
      console.error(`[express-bridge] ChatSSE error:`, error.message);
      console.error(`[express-bridge] ChatSSE details:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
    },
    onConnectionStatus: () => { /* no-op */ },
  };
}

/**
 * 创建 Responses API SSE 回调
 *
 * 输出完整的 Responses API SSE 事件序列：
 *   response.created → response.in_progress
 *   response.output_item.added → response.content_part.added
 *   response.output_text.delta → response.output_text.done
 *   response.content_part.done → response.output_item.done
 *   response.completed
 */
export function createResponsesSSECallbacks(res: Response): SSECallbacks {
  let itemId = `item_${Date.now()}`;
  let contentIndex = 0;
  let hasStarted = false;
  const pendingTools = new Map<number, { id: string; name: string; args: string }>();

  const emitEvent = (type: string, data: Record<string, unknown>): void => {
    writeSSEEvent(res, type, { type, ...data });
  };

  const startResponse = (): void => {
    if (hasStarted) return;
    hasStarted = true;
    const respId = `resp_${Date.now()}`;
    emitEvent('response.created', { id: respId });
    emitEvent('response.in_progress', { id: respId });
    itemId = `item_${Date.now()}`;
    contentIndex = 0;
  };

  return {
    onContent: (delta: string) => {
      startResponse();
      if (contentIndex === 0) {
        emitEvent('response.output_item.added', {
          item_id: itemId,
          item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          output_index: 0,
        });
        emitEvent('response.content_part.added', {
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        });
      }
      emitEvent('response.output_text.delta', {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta,
      });
    },
    onThinking: (delta: string) => {
      startResponse();
      emitEvent('response.reasoning_text.delta', {
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta,
      });
    },
    onToolDelta: (delta: string, info) => {
      startResponse();
      const pending = pendingTools.get(info.index) || { id: info.id, name: '', args: '' };
      if (!pendingTools.has(info.index)) {
        pendingTools.set(info.index, pending);
        emitEvent('response.output_item.added', {
          item_id: info.id,
          item: {
            id: info.id, type: 'function_call', status: 'in_progress',
            call_id: info.id, name: info.name || '', arguments: '',
          },
          output_index: 1,
        });
      }
      if (info.field === 'arguments') {
        pending.args += delta;
        emitEvent('response.function_call_arguments.delta', {
          item_id: info.id,
          output_index: 1,
          delta,
        });
      } else if (info.field === 'name' && info.name) {
        pending.name = info.name;
      }
    },
    onToolCall: (toolCall: ToolCallInfo) => {
      startResponse();
      emitEvent('response.output_item.added', {
        item_id: toolCall.id,
        item: {
          id: toolCall.id, type: 'function_call', status: 'completed',
          call_id: toolCall.id, name: toolCall.function.name, arguments: toolCall.function.arguments,
        },
        output_index: 1,
      });
    },
    onUsage: (usage: TokenUsage) => {
      startResponse();
      if (contentIndex >= 0) {
        emitEvent('response.output_text.done', {
          item_id: itemId, output_index: 0, content_index: 0,
          text: '',
        });
        emitEvent('response.content_part.done', {
          item_id: itemId, output_index: 0, content_index: 0,
          part: { type: 'output_text', text: '' },
        });
        emitEvent('response.output_item.done', {
          item_id: itemId, output_index: 0,
          item: { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
        });
      }
      emitEvent('response.completed', {
        response: {
          status: 'completed',
          usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens },
        },
      });
    },
    onDone: () => {
      if (!hasStarted) startResponse();
      emitEvent('response.completed', {
        response: { status: 'completed', usage: null },
      });
    },
    onError: (error: Error) => {
      console.error(`[express-bridge] ResponsesSSE error:`, error.message);
      console.error(`[express-bridge] ResponsesSSE full error:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
      console.error(`[express-bridge] ResponsesSSE stack:`, error.stack?.split('\n').slice(0, 4).join('\n'));
    },
    onConnectionStatus: () => { /* no-op */ },
  };
}

/**
 * 创建 Anthropic Messages SSE 回调
 *
 * 输出 Anthropic SSE 事件序列：
 *   message_start → content_block_start → content_block_delta
 *   content_block_stop → message_delta → message_stop
 */
export function createAnthropicSSECallbacks(res: Response): SSECallbacks {
  let msgId = `msg_${Date.now()}`;
  let contentBlockIndex = 0;
  let textBlockIndex = -1;
  let hasStarted = false;

  const emitEvent = (type: string, data: Record<string, unknown>): void => {
    writeSSEEvent(res, type, { type, ...data });
  };

  const ensureStarted = (): void => {
    if (hasStarted) return;
    hasStarted = true;
    contentBlockIndex = 0;
    emitEvent('message_start', {
      message: { id: msgId, type: 'message', role: 'assistant', content: [], model: '' },
    });
  };

  return {
    onContent: (delta: string) => {
      ensureStarted();
      if (textBlockIndex < 0) {
        textBlockIndex = contentBlockIndex++;
        emitEvent('content_block_start', {
          index: textBlockIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      emitEvent('content_block_delta', {
        index: textBlockIndex,
        delta: { type: 'text_delta', text: delta },
      });
    },
    onThinking: (delta: string) => {
      ensureStarted();
      const thinkingIdx = contentBlockIndex++;
      emitEvent('content_block_start', {
        index: thinkingIdx,
        content_block: { type: 'thinking', thinking: '' },
      });
      emitEvent('content_block_delta', {
        index: thinkingIdx,
        delta: { type: 'thinking_delta', thinking: delta },
      });
      emitEvent('content_block_stop', { index: thinkingIdx });
    },
    onToolDelta: (delta: string, info) => {
      ensureStarted();
      // 首次遇到 tool → 发送 content_block_start
      // 之后遇到 arguments delta → content_block_delta
      // 简化：直接发送 input_json_delta
      if (info.field === 'name') {
        const toolIdx = contentBlockIndex++;
        emitEvent('content_block_start', {
          index: toolIdx,
          content_block: { type: 'tool_use', id: info.id, name: info.name, input: {} },
        });
      } else if (info.field === 'arguments') {
        // input_json_delta
      }
    },
    onToolCall: (toolCall: ToolCallInfo) => {
      ensureStarted();
      const toolIdx = contentBlockIndex++;
      let input: unknown = {};
      try { input = JSON.parse(toolCall.function.arguments); } catch { input = {}; }
      emitEvent('content_block_start', {
        index: toolIdx,
        content_block: { type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input },
      });
      emitEvent('content_block_stop', { index: toolIdx });
    },
    onUsage: (usage: TokenUsage) => {
      ensureStarted();
      if (textBlockIndex >= 0) {
        emitEvent('content_block_stop', { index: textBlockIndex });
      }
      emitEvent('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
      });
      textBlockIndex = -1;
    },
    onDone: () => {
      if (!hasStarted) ensureStarted();
      if (textBlockIndex >= 0) {
        emitEvent('content_block_stop', { index: textBlockIndex });
      }
      emitEvent('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      emitEvent('message_stop', {});
    },
    onError: (error: Error) => {
      console.error(`[express-bridge] AnthropicSSE error:`, error.message);
      console.error(`[express-bridge] AnthropicSSE details:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
    },
    onConnectionStatus: () => { /* no-op */ },
  };
}

// ========== Proxy 选择器 ==========

/**
 * 输入格式枚举
 */
export type InputFormat = 'chat' | 'responses' | 'anthropic';

/**
 * 提供商类型枚举
 */
export type ProviderType = 'openai-chat' | 'openai-responses' | 'anthropic' | 'unknown';

/**
 * 根据输入格式和提供商类型选择正确的 Proxy
 *
 * Hub-and-spoke 模式：所有转换代理经过 OpenAI Chat 中间格式。
 * 直传代理直接调用各自原生 API。
 *
 * @param inputFormat 客户端请求的格式
 * @param providerType 上游提供商类型
 * @returns 对应的 Proxy 实例
 */
export function pickProxy(
  inputFormat: InputFormat,
  providerType: ProviderType,
): BaseProxy<any, void, Record<string, unknown>> | null {
  if (inputFormat === 'chat' && providerType === 'openai-chat') return new ChatCompletionsProxy();
  if (inputFormat === 'chat' && providerType === 'anthropic') return new ChatToAnthropicProxy();
  if (inputFormat === 'chat' && providerType === 'openai-responses') return new ChatCompletionsToResponsesProxy();

  if (inputFormat === 'responses' && providerType === 'openai-responses') return new ResponsesProxy();
  if (inputFormat === 'responses' && providerType === 'openai-chat') return new ResponsesToChatProxy();
  if (inputFormat === 'responses' && providerType === 'anthropic') return new ResponsesToAnthropicProxy();

  if (inputFormat === 'anthropic' && providerType === 'anthropic') return new AnthropicProxy();
  if (inputFormat === 'anthropic' && providerType === 'openai-chat') return new AnthropicToChatProxy();
  if (inputFormat === 'anthropic' && providerType === 'openai-responses') return new AnthropicToResponsesProxy();

  return null;
}

/**
 * 获取输入格式对应的 SSE 回调工厂
 */
export function createSSECallbacks(inputFormat: InputFormat, res: Response): SSECallbacks {
  switch (inputFormat) {
    case 'chat': return createChatSSECallbacks(res);
    case 'responses': return createResponsesSSECallbacks(res);
    case 'anthropic': return createAnthropicSSECallbacks(res);
  }
}

/**
 * 便捷执行 Proxy 调用
 *
 * @param proxy Proxy 实例
 * @param config 配置（baseUrl, apiKey, providerLabel, timeoutMs）
 * @param body 请求体
 * @param callbacks SSE 回调
 */
export async function executeProxy(
  proxy: BaseProxy<any, void, Record<string, unknown>>,
  config: { baseUrl: string; apiKey: string; providerLabel: string; timeoutMs?: number; maxRetries?: number },
  body: Record<string, unknown>,
  callbacks: SSECallbacks,
): Promise<void> {
  const input: any = {
    config: {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      providerLabel: config.providerLabel || 'Proxy',
      timeoutMs: config.timeoutMs || 300_000,
      maxRetries: config.maxRetries ?? 2,
    },
    body,
  };

  // 根据 proxy 类型调用 execute
  if (proxy instanceof ChatCompletionsProxy || proxy instanceof ChatCompletionsToResponsesProxy || proxy instanceof ChatToAnthropicProxy) {
    await (proxy as any).execute(input, callbacks);
  } else if (proxy instanceof ResponsesProxy || proxy instanceof ResponsesToChatProxy || proxy instanceof ResponsesToAnthropicProxy) {
    await (proxy as any).execute(input, callbacks);
  } else if (proxy instanceof AnthropicProxy || proxy instanceof AnthropicToChatProxy || proxy instanceof AnthropicToResponsesProxy) {
    await (proxy as any).execute(input, callbacks);
  } else {
    await (proxy as any).execute(input, callbacks);
  }
}
