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
import ChatPassthroughProxy from './Proxy/ChatPassthroughProxy';
import { trackTokenUsage } from '../tokenTracker';

// ========== SSE 写入器 ==========

/** 写入 SSE data 行 */
function writeSSE(res: Response, data: unknown): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** 写入命名 SSE 事件 */
function writeSSEEvent(res: Response, event: string, data: unknown): void {
  if (res.writableEnded) return;
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
export function createChatSSECallbacks(res: Response, options?: { modelId?: number; promptTokens?: number; modelName?: string }): SSECallbacks {
  const pendingTools = new Map<number, PendingToolCall>();
  /** 响应级别固定的 ID，所有 chunk 共用同一 id */
  const responseId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const modelName = options?.modelName || '';
  /** 是否已通过 onToolCall 标记有工具调用（用于 finish_reason） */
  let hasEmittedToolCall = false;
  /** 是否已发送 finish_reason chunk（避免重复） */
  let hasSentFinish = false;
  /** 是否已跟踪过 token（避免重复） */
  let hasTrackedTokens = false;
  /** 是否已发送 role="assistant" 初始化 chunk */
  let hasSentRole = false;

  /** 首次输出时发送 role:"assistant" 初始化 chunk（OpenAI 标准格式要求） */
  const ensureRole = (): void => {
    if (hasSentRole) return;
    hasSentRole = true;
    writeChunk({ role: 'assistant', content: '' });
  };

  const writeChunk = (delta: Record<string, unknown>, finishReason: string | null = null): void => {
    // 首次写 chunk 前确保 role 已发
    ensureRole();
    const chunk: Record<string, unknown> = {
      id: responseId,
      object: 'chat.completion.chunk',
      created: createdAt,
      model: modelName,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    writeSSE(res, chunk);
  };

  /** 发送 finish_reason chunk（仅一次） */
  const sendFinish = (reason: string): void => {
    if (hasSentFinish) return;
    hasSentFinish = true;
    writeChunk({}, reason);
  };

  /** 跟踪 token（异步队列 + 去重） */
  const trackUsage = (usage: TokenUsage): void => {
    if (hasTrackedTokens || !options?.modelId) return;
    hasTrackedTokens = true;
    trackTokenUsage(options.modelId, usage);
    // trackApiCall 由路由处理器统一调用，避免重复
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
    onToolCall: () => {
      // 工具调用已通过 onToolDelta 增量流式完毕（name + arguments 逐段发送）。
      // onToolCall 只是 finish_reason 后刷新剩余的工具调用，此时参数已完整累积。
      // 注意：不要再写带完整 arguments 的 chunk，否则 LangChain 客户端会
      // 把完整参数叠加到已累积的增量参数上，导致 JSON 重复解析失败。
      hasEmittedToolCall = true;
    },
    onUsage: (usage: TokenUsage) => {
      // 跟踪 token（异步队列）
      trackUsage(usage);

      // 1. 先发 finish_reason chunk（空 delta + 正确的原因）
      sendFinish(hasEmittedToolCall ? 'tool_calls' : 'stop');
      // 2. 再发 usage chunk（标准 OpenAI 格式：choices 为空数组）
      writeSSE(res, {
        id: responseId,
        object: 'chat.completion.chunk',
        created: createdAt,
        model: modelName,
        choices: [],
        usage: {
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
        },
      });
    },
    onDone: () => {
      if (!hasSentFinish) {
        sendFinish(hasEmittedToolCall ? 'tool_calls' : 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    },
    onError: (error: Error) => {
      console.error(`[express-bridge] ChatSSE error:`, error.message);
      console.error(`[express-bridge] ChatSSE details:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ code: 'stream_error', message: error.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch { /* 响应可能已结束 */ }
    },
    onConnectionStatus: () => { /* no-op */ },
  };
}

/**
 * 创建 Responses API SSE 回调
 *
 * 参考 cc-switch (farion1231/cc-switch) 的 ChatToResponsesState 状态机模式，
 * 将 Chat Completions SSE 回调转换为 OpenAI Responses API 命名事件序列：
 *
 *   生命周期：
 *   - 文本:   response.created → output_item.added → content_part.added → output_text.delta → output_text.done → content_part.done → output_item.done
 *   - 推理:   response.created → output_item.added (reasoning) → reasoning_summary_part.added → reasoning_summary_text.delta → ...done
 *   - 工具:   response.created → output_item.added (function_call) → function_call_arguments.delta → ...done → output_item.done
 *   - 完成:   response.completed → [DONE]
 *
 * 关键设计（对齐 cc-switch ChatToResponsesState）：
 *   - 每个输出类型有独立的状态机（reasoning / text / tools），各自管理 added→done 生命周期
 *   - 推理和文本作为独立的 output item（reasoning → output_index 0, message → output_index 1）
 *   - 工具调用通过 onToolDelta 增量添加，onToolCall 完成时发 done + output_item.done
 *   - response.completed 只发一次（onUsage 或 onDone 先到先得）
 */
export function createResponsesSSECallbacks(res: Response, options?: { modelId?: number; modelName?: string }): SSECallbacks {
  // ========== 响应级状态 ==========
  const responseId = `resp_${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = Math.floor(Date.now() / 1000);
  const modelName = options?.modelName || '';
  let hasStarted = false;
  let hasCompleted = false;
  let nextOutputIndex = 0;

  // ========== 文本项状态 ==========
  let textAdded = false;
  let textDone = false;
  let textOutputIndex = -1;
  let textItemId = '';
  let textContent = '';

  // ========== 推理项状态 ==========
  let reasoningAdded = false;
  let reasoningDone = false;
  let reasoningOutputIndex = -1;
  let reasoningItemId = '';
  let reasoningContent = '';

  // ========== 工具调用状态（按 index） ==========
  interface PendingTool {
    id: string;
    name: string;
    args: string;
    outputIndex: number;
    itemId: string;
    added: boolean;
    done: boolean;
  }
  const pendingTools = new Map<number, PendingTool>();

  // ========== 已完成的 output items（用于 response.completed 中的 output 字段） ==========
  const outputItems: Array<Record<string, unknown>> = [];

  // ========== 辅助函数 ==========

  const emitEvent = (type: string, data: Record<string, unknown>): void => {
    writeSSEEvent(res, type, { type, ...data });
  };

  const ensureStarted = (): void => {
    if (hasStarted) return;
    hasStarted = true;
    emitEvent('response.created', { id: responseId });
    emitEvent('response.in_progress', { id: responseId });
  };

  /** 确保推理项已创建（首次 onThinking 时触发） */
  const ensureReasoningAdded = (): void => {
    if (reasoningAdded) return;
    reasoningAdded = true;
    reasoningOutputIndex = nextOutputIndex++;
    reasoningItemId = `rs_${responseId}`;
    emitEvent('response.output_item.added', {
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      item: { id: reasoningItemId, type: 'reasoning', summary: [] },
    });
    emitEvent('response.reasoning_summary_part.added', {
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: '' },
    });
  };

  /** 确保文本项已创建（首次 onContent 时触发） */
  const ensureTextAdded = (): void => {
    if (textAdded) return;
    textAdded = true;
    textOutputIndex = nextOutputIndex++;
    textItemId = `${responseId}_msg`;
    emitEvent('response.output_item.added', {
      item_id: textItemId,
      output_index: textOutputIndex,
      item: { id: textItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    });
    emitEvent('response.content_part.added', {
      item_id: textItemId,
      output_index: textOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    });
  };

  /** 关闭推理项（发出 done 事件 + 记录到 output） */
  const finalizeReasoning = (): void => {
    if (!reasoningAdded || reasoningDone) return;
    reasoningDone = true;
    emitEvent('response.reasoning_summary_text.done', {
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      summary_index: 0,
      text: reasoningContent,
    });
    emitEvent('response.reasoning_summary_part.done', {
      item_id: reasoningItemId,
      output_index: reasoningOutputIndex,
      summary_index: 0,
      part: { type: 'summary_text', text: reasoningContent },
    });
    const reasoningItem = {
      id: reasoningItemId,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoningContent }],
    };
    outputItems.push(reasoningItem);
    emitEvent('response.output_item.done', {
      output_index: reasoningOutputIndex,
      item: reasoningItem,
    });
  };

  /** 关闭文本项（发出 done 事件） */
  const finalizeText = (): void => {
    if (!textAdded || textDone) return;
    textDone = true;
    emitEvent('response.output_text.done', {
      item_id: textItemId,
      output_index: textOutputIndex,
      content_index: 0,
      text: textContent,
    });
    emitEvent('response.content_part.done', {
      item_id: textItemId,
      output_index: textOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: textContent },
    });
    const messageItem = {
      id: textItemId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textContent }],
    };
    outputItems.push(messageItem);
    emitEvent('response.output_item.done', {
      output_index: textOutputIndex,
      item: messageItem,
    });
  };

  /** 关闭所有未关闭的工具项 */
  const finalizeTools = (): void => {
    for (const [, tool] of pendingTools) {
      if (tool.done) continue;
      if (!tool.added) {
        continue;
      }
      tool.done = true;
      emitEvent('response.function_call_arguments.done', {
        item_id: tool.itemId,
        output_index: tool.outputIndex,
        arguments: tool.args,
      });
      const toolItem = {
        id: tool.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: tool.id,
        name: tool.name,
        arguments: tool.args,
      };
      outputItems.push(toolItem);
      emitEvent('response.output_item.done', {
        output_index: tool.outputIndex,
        item: toolItem,
      });
    }
  };

  /** 发送 response.completed（仅一次） */
  const emitCompleted = (usage?: TokenUsage): void => {
    if (hasCompleted) return;
    hasCompleted = true;

    // 关闭所有未关闭的项
    if (reasoningAdded && !reasoningDone) finalizeReasoning();
    if (textAdded && !textDone) finalizeText();
    finalizeTools();

    // 注意：response.completed 事件必须包含完整的 response 字段集
    // （含 id / object / created_at / model / output），否则 Codex CLI 等
    // Responses API 客户端会解析失败并报 "missing field `id`"。
    // 参考 cc-switch 的 sse::response_completed / base_response。
    emitEvent('response.completed', {
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'completed',
        model: modelName,
        output: outputItems,
        usage: usage
          ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens }
          : null,
      },
    });
  };

  // ========== 回调实现 ==========

  return {
    /** 文本内容 delta — 创建 message output item + content part + output_text.delta */
    onContent: (delta: string) => {
      ensureStarted();
      // 如果推理项仍在打开中，先关闭它（推理在文本之前）
      if (reasoningAdded && !reasoningDone) {
        finalizeReasoning();
      }
      ensureTextAdded();
      textContent += delta;
      emitEvent('response.output_text.delta', {
        item_id: textItemId,
        output_index: textOutputIndex,
        content_index: 0,
        delta,
      });
    },

    /** 推理/思考 delta — 创建 reasoning output item + summary delta */
    onThinking: (delta: string) => {
      ensureStarted();
      ensureReasoningAdded();
      reasoningContent += delta;
      emitEvent('response.reasoning_summary_text.delta', {
        item_id: reasoningItemId,
        output_index: reasoningOutputIndex,
        summary_index: 0,
        delta,
      });
    },

    /** 工具调用增量 — 创建 function_call item + 增量参数 */
    onToolDelta: (delta: string, info) => {
      ensureStarted();
      // 工具出现时，关闭仍在打开的推理项
      if (reasoningAdded && !reasoningDone) {
        finalizeReasoning();
      }

      let pending = pendingTools.get(info.index);
      if (!pending) {
        const outputIndex = nextOutputIndex++;
        pending = {
          id: info.id,
          name: info.name || '',
          args: '',
          outputIndex,
          itemId: info.id,
          added: false,
          done: false,
        };
        pendingTools.set(info.index, pending);
      }

      // 更新状态
      if (info.field === 'name' && info.name) {
        pending.name = info.name;
      }
      if (info.field === 'arguments') {
        pending.args += delta;
      }

      // 首次创建时发送 output_item.added（注意：name 可能还没到，用已有信息）
      if (!pending.added) {
        pending.added = true;
        emitEvent('response.output_item.added', {
          item_id: pending.itemId,
          output_index: pending.outputIndex,
          item: {
            id: pending.itemId,
            type: 'function_call',
            status: 'in_progress',
            call_id: pending.id,
            name: pending.name || info.name || '',
            arguments: '',
          },
        });
      }

      // 增量参数
      if (info.field === 'arguments') {
        emitEvent('response.function_call_arguments.delta', {
          item_id: pending.itemId,
          output_index: pending.outputIndex,
          delta,
        });
      }
    },

    /** 完整工具调用（complete）— 关闭工具项并发出 done */
    onToolCall: (toolCall: ToolCallInfo) => {
      ensureStarted();
      // 工具完成时，关闭仍在打开的推理项
      if (reasoningAdded && !reasoningDone) {
        finalizeReasoning();
      }

      // 看看是否已有通过 onToolDelta 跟踪的同名工具
      let found = false;
      for (const [, pending] of pendingTools) {
        if (pending.id === toolCall.id && pending.added && !pending.done) {
          found = true;
          pending.done = true;
          pending.args = toolCall.function.arguments;
          if (toolCall.function.name) pending.name = toolCall.function.name;
          emitEvent('response.function_call_arguments.done', {
            item_id: pending.itemId,
            output_index: pending.outputIndex,
            arguments: toolCall.function.arguments,
          });
          const toolItem = {
            id: pending.itemId,
            type: 'function_call',
            status: 'completed',
            call_id: pending.id,
            name: pending.name,
            arguments: toolCall.function.arguments,
          };
          outputItems.push(toolItem);
          emitEvent('response.output_item.done', {
            output_index: pending.outputIndex,
            item: toolItem,
          });
          break;
        }
      }

      if (!found) {
        // 非流式/完整到达的工具调用（onToolDelta 未触发过）
        const outputIndex = nextOutputIndex++;
        const toolItem = {
          id: toolCall.id,
          type: 'function_call',
          status: 'completed',
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        };
        outputItems.push(toolItem);
        emitEvent('response.output_item.added', {
          item_id: toolCall.id,
          output_index: outputIndex,
          item: toolItem,
        });
        emitEvent('response.function_call_arguments.done', {
          item_id: toolCall.id,
          output_index: outputIndex,
          arguments: toolCall.function.arguments,
        });
        emitEvent('response.output_item.done', {
          output_index: outputIndex,
          item: toolItem,
        });
      }
    },

    /** Token 用量 — 关闭所有项 + response.completed（与 onDone 互斥触发） */
    onUsage: (usage: TokenUsage) => {
      ensureStarted();
      emitCompleted(usage);
    },

    /** 流完成 — 如果 onUsage 未触发过，在此完成（兜底） */
    onDone: () => {
      if (!hasStarted) ensureStarted();
      if (!hasCompleted) {
        emitCompleted();
      }
      res.write('data: [DONE]\n\n');
      res.end();
    },

    /** 错误处理 */
    onError: (error: Error) => {
      console.error(`[express-bridge] ResponsesSSE error:`, error.message);
      console.error(`[express-bridge] ResponsesSSE full error:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
      console.error(`[express-bridge] ResponsesSSE stack:`, error.stack?.split('\n').slice(0, 4).join('\n'));
      try {
        writeSSEEvent(res, 'response.failed', {
          response: {
            id: responseId,
            object: 'response',
            created_at: createdAt,
            status: 'failed',
            model: modelName,
            error: { code: 'stream_error', message: error.message },
          },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      } catch { /* 响应可能已结束 */ }
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
  let thinkingBlockIndex = -1;
  const toolBlockIndices = new Map<number, number>();
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
      if (thinkingBlockIndex < 0) {
        thinkingBlockIndex = contentBlockIndex++;
        emitEvent('content_block_start', {
          index: thinkingBlockIndex,
          content_block: { type: 'thinking', thinking: '' },
        });
      }
      emitEvent('content_block_delta', {
        index: thinkingBlockIndex,
        delta: { type: 'thinking_delta', thinking: delta },
      });
    },
    onToolDelta: (delta: string, info) => {
      ensureStarted();
      if (info.field === 'name') {
        const toolIdx = contentBlockIndex++;
        toolBlockIndices.set(info.index, toolIdx);
        emitEvent('content_block_start', {
          index: toolIdx,
          content_block: { type: 'tool_use', id: info.id, name: info.name, input: {} },
        });
      } else if (info.field === 'arguments') {
        const toolIdx = toolBlockIndices.get(info.index);
        if (toolIdx !== undefined) {
          emitEvent('content_block_delta', {
            index: toolIdx,
            delta: { type: 'input_json_delta', partial_json: delta },
          });
        }
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
      if (thinkingBlockIndex >= 0) {
        emitEvent('content_block_stop', { index: thinkingBlockIndex });
        thinkingBlockIndex = -1;
      }
      if (textBlockIndex >= 0) {
        emitEvent('content_block_stop', { index: textBlockIndex });
        textBlockIndex = -1;
      }
      for (const [, idx] of toolBlockIndices) {
        emitEvent('content_block_stop', { index: idx });
      }
      toolBlockIndices.clear();
      emitEvent('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
      });
    },
    onDone: () => {
      if (!hasStarted) ensureStarted();
      if (thinkingBlockIndex >= 0) {
        emitEvent('content_block_stop', { index: thinkingBlockIndex });
        thinkingBlockIndex = -1;
      }
      if (textBlockIndex >= 0) {
        emitEvent('content_block_stop', { index: textBlockIndex });
        textBlockIndex = -1;
      }
      for (const [, idx] of toolBlockIndices) {
        emitEvent('content_block_stop', { index: idx });
      }
      toolBlockIndices.clear();
      emitEvent('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      });
      emitEvent('message_stop', {});
      res.write('data: [DONE]\n\n');
      res.end();
    },
    onError: (error: Error) => {
      console.error(`[express-bridge] AnthropicSSE error:`, error.message);
      console.error(`[express-bridge] AnthropicSSE details:`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
      try {
        writeSSEEvent(res, 'error', { code: 'stream_error', message: error.message });
        writeSSEEvent(res, 'message_stop', {});
        res.write('data: [DONE]\n\n');
        res.end();
      } catch { /* 响应可能已结束 */ }
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
  if (inputFormat === 'chat' && providerType === 'openai-chat') return new ChatPassthroughProxy();
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
export function createSSECallbacks(inputFormat: InputFormat, res: Response, options?: { modelId?: number; promptTokens?: number; modelName?: string }): SSECallbacks {
  switch (inputFormat) {
    case 'chat': return createChatSSECallbacks(res, options);
    case 'responses': return createResponsesSSECallbacks(res, options);
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
 * @param clientRes 客户端响应对象（透传代理需要）
 */
export async function executeProxy(
  proxy: BaseProxy<any, void, Record<string, unknown>>,
  config: { baseUrl: string; apiKey: string; providerLabel: string; timeoutMs?: number; maxRetries?: number; modelId?: number },
  body: Record<string, unknown>,
  callbacks: SSECallbacks,
  clientRes?: Response,
): Promise<void> {
  const input: any = {
    config: {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      modelId: config.modelId,
      providerLabel: config.providerLabel || 'Proxy',
      timeoutMs: config.timeoutMs || 300_000,
      maxRetries: config.maxRetries ?? 2,
    },
    body,
  };

  // 根据 proxy 类型调用 execute
  if (proxy instanceof ChatPassthroughProxy) {
    // 纯透传代理：需要将客户端 Response 传入，以便直接 pipe 上游响应
    if (clientRes) {
      proxy.setClientResponse(clientRes);
    }
    await proxy.execute(input, callbacks);
  } else if (proxy instanceof ChatCompletionsProxy || proxy instanceof ChatCompletionsToResponsesProxy || proxy instanceof ChatToAnthropicProxy) {
    await (proxy as any).execute(input, callbacks);
  } else if (proxy instanceof ResponsesProxy || proxy instanceof ResponsesToChatProxy || proxy instanceof ResponsesToAnthropicProxy) {
    await (proxy as any).execute(input, callbacks);
  } else if (proxy instanceof AnthropicProxy || proxy instanceof AnthropicToChatProxy || proxy instanceof AnthropicToResponsesProxy) {
    await (proxy as any).execute(input, callbacks);
  } else {
    await (proxy as any).execute(input, callbacks);
  }
}
