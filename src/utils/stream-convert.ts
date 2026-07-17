/**
 * Stream Convert — 流式 SSE 格式转换核心工具集
 *
 * 处理 Anthropic Messages SSE ↔ OpenAI Chat Completions SSE 之间的双向实时转换，
 * 以及 OpenAI Chat SSE → Responses API SSE 的转换。
 */

import { Response } from 'express';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageStreamEvent } from '@anthropic-ai/sdk/resources/messages/messages';
import {
  generateRandomString,
  convertToAnthropicMessages,
  convertToAnthropicTools,
  REQUEST_TIMEOUT_MS,
  type AIProvider,
  type ChatCallParams,
} from './model-provider';
import { trackTokenUsage, trackApiCall } from './tokenTracker';
import { errorBroadcaster } from './errorBroadcaster';

/** 零宽字符 — 防止 Copilot "Response contained no choices" */
const INVISIBLE_SENTINEL = '\u2060';

// ========== SSE 写入辅助 ==========

/** 写入标准 SSE data 行 */
export function writeSSE(res: Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** 写入命名 SSE 事件（event + data） */
export function writeSSEEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ========== AnthropicStreamConverter 类 ==========

/**
 * Anthropic MessageStreamEvent → OpenAI Chat Completion Chunk 转换器
 *
 * 维护内部状态以正确处理：
 * - content_block_start → 初始 chunk 或 tool_calls 开始
 * - content_block_delta → text_delta / input_json_delta / thinking_delta
 * - content_block_stop → 内容块结束
 * - message_delta → finish_reason + usage
 * - message_start → 首 chunk（角色信息）
 * - 多 tool call 索引跟踪
 */
export class AnthropicStreamConverter {
  private completionId: string;
  private modelName: string = '';
  private toolCallIndex: number = 0;

  /** 跟踪每个内容块的类型和索引 */
  private contentBlocks: Map<number, { type: string; id?: string; name?: string }> = new Map();
  private nextBlockIndex: number = 0;

  /** 文本内容收集（用于估算 token） */
  public textContent: string = '';
  public usage: { input_tokens?: number; output_tokens?: number } | null = null;

  constructor(modelName?: string) {
    this.completionId = `chatcmpl-${generateRandomString(12)}`;
    if (modelName) this.modelName = modelName;
  }

  /** 处理单个 Anthropic 流事件，返回 OpenAI chunk 或 null（跳过） */
  processEvent(event: MessageStreamEvent): Record<string, unknown> | null {
    const eventObj = event as unknown as Record<string, unknown>;

    switch (event.type) {
      // ===== message_start =====
      case 'message_start': {
        // Anthropic 开始事件，返回首 chunk
        const msgEvent = eventObj as {
          message?: { content?: Array<Record<string, unknown>>; model?: string };
        };
        if (msgEvent.message?.model) {
          this.modelName = msgEvent.message.model;
        }
        return {
          id: this.completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.modelName,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: '' },
            finish_reason: null,
          }],
        };
      }

      // ===== content_block_start =====
      case 'content_block_start': {
        const startEvent = eventObj as {
          index: number;
          content_block: { type: string; id?: string; name?: string; text?: string; partial_json?: string };
        };
        const block = startEvent.content_block;
        const index = startEvent.index;

        this.contentBlocks.set(index, { type: block.type, id: block.id, name: block.name });

        if (block.type === 'tool_use') {
          // tool_use 块开始 → 转换成 OpenAI tool_calls delta
          this.toolCallIndex++;
          return {
            id: this.completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.modelName,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: this.toolCallIndex - 1,
                  id: block.id || '',
                  type: 'function',
                  function: {
                    name: block.name || '',
                    arguments: '',
                  },
                }],
              },
              finish_reason: null,
            }],
          };
        }

        if (block.type === 'text' && block.text) {
          // 初始文本内容（极少出现，但支持）
          return {
            id: this.completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.modelName,
            choices: [{
              index: 0,
              delta: { content: block.text },
              finish_reason: null,
            }],
          };
        }

        // thinking / signature 等块 — 跳过
        this.nextBlockIndex++;
        return null;
      }

      // ===== content_block_delta =====
      case 'content_block_delta': {
        const deltaEvent = eventObj as {
          index: number;
          delta: { type: string; text?: string; partial_json?: string };
        };
        const delta = deltaEvent.delta;
        const blockIndex = deltaEvent.index;

        if (delta.type === 'text_delta' && delta.text) {
          this.textContent += delta.text;
          return {
            id: this.completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.modelName,
            choices: [{
              index: 0,
              delta: { content: delta.text },
              finish_reason: null,
            }],
          };
        }

        if (delta.type === 'input_json_delta' && delta.partial_json) {
          // tool_use 的参数流式输出 → OpenAI arguments delta
          const block = this.contentBlocks.get(blockIndex);
          const callIndex = this._getToolCallIndex(blockIndex);
          return {
            id: this.completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: this.modelName,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: callIndex,
                  function: { arguments: delta.partial_json },
                }],
              },
              finish_reason: null,
            }],
          };
        }

        // thinking_delta 等 — 跳过
        return null;
      }

      // ===== content_block_stop =====
      case 'content_block_stop': {
        // Anthropic 内容块结束 — OpenAI 不需要对应事件，仅清理内部状态
        const stopEvent = eventObj as { index: number };
        if (stopEvent.index !== undefined) {
          const block = this.contentBlocks.get(stopEvent.index);
          if (block?.type === 'tool_use') {
            // 可选：在 tool_use 结束时发送空的 tool_calls delta 来标记分段
            const callIndex = this._getToolCallIndex(stopEvent.index);
            return {
              id: this.completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: this.modelName,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: [{
                    index: callIndex,
                    function: { arguments: '' },
                  }],
                },
                finish_reason: null,
              }],
            };
          }
        }
        return null;
      }

      // ===== message_delta =====
      case 'message_delta': {
        const deltaMessage = eventObj as {
          delta: { stop_reason?: string; stop_sequence?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
        };

        if (deltaMessage.usage) {
          this.usage = deltaMessage.usage;
        }

        const finishReason = this._mapStopReason(deltaMessage.delta?.stop_reason);

        return {
          id: this.completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: this.modelName,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: finishReason,
          }],
          usage: deltaMessage.usage
            ? {
                prompt_tokens: deltaMessage.usage.input_tokens ?? 0,
                completion_tokens: deltaMessage.usage.output_tokens ?? 0,
                total_tokens: (deltaMessage.usage.input_tokens ?? 0) + (deltaMessage.usage.output_tokens ?? 0),
              }
            : undefined,
        };
      }

      // ===== message_stop =====
      case 'message_stop': {
        // Anthropic 流结束 — OpenAI 侧不需要额外事件
        return null;
      }

      // ===== ping 等其他事件 =====
      default:
        return null;
    }
  }

  /** 获取此 completion 的 ID */
  getCompletionId(): string {
    return this.completionId;
  }

  private _mapStopReason(stopReason?: string): string | null {
    if (!stopReason) return null;
    switch (stopReason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      case 'content_filtered':
        return 'content_filter';
      default:
        return stopReason;
    }
  }

  /** 根据内容块索引计算 tool call 索引 */
  private _getToolCallIndex(blockIndex: number): number {
    // 按 tool_use 块的出现顺序分配索引
    let callIdx = 0;
    const indices = [...this.contentBlocks.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      if (this.contentBlocks.get(idx)?.type === 'tool_use') {
        if (idx === blockIndex) return callIdx;
        callIdx++;
      }
    }
    return callIdx;
  }
}

// ========== 流式处理函数 ==========

/**
 * 直接处理 OpenAI Chat SSE 流
 * 转发原始 ChatCompletionChunk，收集 usage 和 token 统计
 */
export async function processChatStream(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  res: Response,
  modelName: string,
  options?: { modelId?: number; promptTokens?: number },
): Promise<void> {
  const completionId = `chatcmpl-${generateRandomString(12)}`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let usage: OpenAI.CompletionUsage | null = null;
  let textContent = '';

  try {
    for await (const chunk of stream) {
      if (res.writableEnded) break;

      if (chunk.usage) usage = chunk.usage;

      if (chunk.choices && chunk.choices[0]) {
        textContent += chunk.choices[0].delta?.content || '';

        writeSSE(res, {
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: chunk.choices,
        });
      }
    }

    // 无可见输出时注入零宽字符，防止 Copilot 报 "no choices"
    if (!textContent) {
      writeSSE(res, {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{ index: 0, delta: { content: INVISIBLE_SENTINEL }, finish_reason: null }],
      });
      textContent = INVISIBLE_SENTINEL;
    }

    // 发送 usage
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
      trackTokenUsage(options?.modelId, usage);
    } else if (options?.modelId && textContent.length > 0) {
      const estimatedOutputTokens = Math.ceil(textContent.length / 3);
      const estimatedUsage = {
        prompt_tokens: options.promptTokens || 0,
        completion_tokens: estimatedOutputTokens,
        total_tokens: (options.promptTokens || 0) + estimatedOutputTokens,
      };
      trackTokenUsage(options.modelId, estimatedUsage);
    }
    trackApiCall(options?.modelId);

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error && err.name === 'TimeoutError' ? 'timeout_error' : 'chat_stream_error';
    console.error('[chat stream] fatal:', err);
    errorBroadcaster.emitError(options?.modelId ?? 0, modelName, errorType, errMsg);
    if (!res.writableEnded) {
      // 流已开始则写入错误事件后关闭，否则直接 end
      try { writeSSE(res, { error: { message: errMsg, type: errorType } }); } catch { /* ignore */ }
      res.end();
    }
  }
}

/**
 * Anthropic 流 → OpenAI Chat SSE 转换 + 写入
 */
export async function processAnthropicStream(
  provider: AIProvider,
  params: ChatCallParams,
  res: Response,
  options?: { modelId?: number; promptTokens?: number },
): Promise<void> {
  const client = provider.client as Anthropic;

  const anthropicParams = convertToAnthropicMessages(
    params.messages as unknown as any[],
    params.system,
  );

  const stream = await client.messages.stream(
    {
      model: provider.modelName,
      max_tokens: params.maxOutputTokens,
      messages: anthropicParams.messages,
      system: anthropicParams.system,
      temperature: params.temperature,
      tools: params.tools ? convertToAnthropicTools(params.tools as unknown as any[]) : undefined,
    },
    // 流式请求不设超时，防止生成中途被断开
  );

  const converter = new AnthropicStreamConverter(provider.modelName);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  try {
    for await (const event of stream as unknown as AsyncIterable<MessageStreamEvent>) {
      if (res.writableEnded) break;

      const chunk = converter.processEvent(event);
      if (chunk) {
        writeSSE(res, chunk);
      }
    }

    // 无可见输出时注入零宽字符，防止 Copilot 报 "no choices"
    if (!converter.textContent) {
      writeSSE(res, {
        id: converter.getCompletionId(),
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: provider.modelName,
        choices: [{ index: 0, delta: { content: INVISIBLE_SENTINEL }, finish_reason: null }],
      });
      converter.textContent = INVISIBLE_SENTINEL;
    }

    // 记录 token 统计
    if (converter.usage && options?.modelId) {
      trackTokenUsage(options.modelId, {
        prompt_tokens: converter.usage.input_tokens ?? 0,
        completion_tokens: converter.usage.output_tokens ?? 0,
        total_tokens: (converter.usage.input_tokens ?? 0) + (converter.usage.output_tokens ?? 0),
      });
    } else if (options?.modelId && converter.textContent.length > 0) {
      const estimatedOutputTokens = Math.ceil(converter.textContent.length / 3);
      trackTokenUsage(options.modelId, {
        prompt_tokens: options.promptTokens || 0,
        completion_tokens: estimatedOutputTokens,
        total_tokens: (options.promptTokens || 0) + estimatedOutputTokens,
      });
    }
    trackApiCall(options?.modelId);

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error && err.name === 'TimeoutError' ? 'timeout_error' : 'anthropic_stream_error';
    console.error('[anthropic stream] fatal:', err);
    errorBroadcaster.emitError(options?.modelId ?? 0, provider.modelName, errorType, errMsg);
    if (!res.writableEnded) {
      try { writeSSE(res, { error: { message: errMsg, type: errorType } }); } catch { /* ignore */ }
      res.end();
    }
  }
}

/**
 * OpenAI Responses SDK 流 → Responses API SSE 事件
 *
 * 处理原生 Responses API 的 stream，直接转发 Response Stream Events
 */
export async function processOpenAIResponsesStream(
  provider: AIProvider,
  params: ChatCallParams,
  _originalBody: Record<string, unknown>,
  res: Response,
  options?: { modelId?: number },
): Promise<void> {
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

  const stream = await client.responses.create(
    {
      model: provider.modelName,
      input: responseInput as unknown as any,
      max_output_tokens: params.maxOutputTokens,
      temperature: params.temperature,
      tools: tools as unknown as any,
      stream: true,
    },
    // 流式请求不设超时，防止生成中途被断开
  );

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
    response: {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      status: 'in_progress',
      model: provider.modelName,
      output: [],
      error: null,
    },
  });

  try {
    for await (const event of stream as unknown as AsyncIterable<Record<string, unknown>>) {
      if (completed || res.writableEnded) break;

      if (event.type === 'response.output_text.delta') {
        const delta = (event as unknown as { delta: string }).delta;
        text += delta;
        writeSSEEvent(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: (event as unknown as { item_id: string }).item_id,
          output_index: (event as unknown as { output_index: number }).output_index,
          content_index: (event as unknown as { content_index: number }).content_index,
          delta,
        });
      } else if (event.type === 'response.completed') {
        completed = true;
        const completedEvent = event as unknown as {
          response?: { id: string };
          usage?: { input_tokens: number; output_tokens: number };
        };
        if (completedEvent.usage && options?.modelId) {
          trackTokenUsage(options.modelId, {
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
            status: 'completed',
            model: provider.modelName,
            output: [
              {
                id: completedEvent.response?.id,
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text }],
              },
            ],
            usage: completedEvent.usage,
            error: null,
          },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errorType = err instanceof Error && err.name === 'TimeoutError' ? 'timeout_error' : 'responses_stream_error';
    console.error('[responses stream] fatal:', err);
    errorBroadcaster.emitError(options?.modelId ?? 0, provider.modelName, errorType, errMsg);
    if (!res.writableEnded) res.end();
  }
}

/**
 * OpenAI Chat SSE → Responses API SSE 转换
 *
 * 将 Chat Completions 流式 chunk 转换为 Responses API 的 SSE 事件序列。
 * 修复了原实现中 tool_calls 被跳过的 TODO。
 */
export async function streamChatAsResponses(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  res: Response,
  modelName: string,
  options?: { modelId?: number; promptTokens?: number },
): Promise<void> {
  const responseId = `resp_${generateRandomString(12)}`;
  const messageItemId = `msg_${generateRandomString(12)}`;
  const createdAt = Math.floor(Date.now() / 1000);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let text = '';
  let messageStarted = false;
  let messageDone = false;
  let completed = false;
  let usage: OpenAI.CompletionUsage | null = null;

  // 跟踪 tool_calls 状态
  interface ToolCallEntry {
    id: string;
    name: string;
    arguments: string;
    functionCallItemId: string;
    started: boolean;
    done: boolean;
  }
  let toolCalls: ToolCallEntry[] = [];

  const responseBase = (status: 'in_progress' | 'completed' = 'in_progress') => {
    const base = {
      id: responseId,
      object: 'response',
      created_at: createdAt,
      status,
      error: null,
      incomplete_details: null,
      model: modelName,
      output: [],
    };
    if (status === 'completed') {
      const output: Array<Record<string, unknown>> = [];

      // 添加 tool calls 到 output
      for (const tc of toolCalls) {
        if (tc.started) {
          output.push({
            id: tc.functionCallItemId,
            type: 'function_call',
            status: 'completed',
            call_id: tc.id,
            name: tc.name,
            arguments: tc.arguments || '{}',
          });
        }
      }

      // 添加消息到 output
      if (text) {
        output.push({
          id: messageItemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        });
      }

      return {
        ...base,
        output,
        output_text: text,
        usage: usage
          ? {
              input_tokens: usage.prompt_tokens,
              output_tokens: usage.completion_tokens,
              total_tokens: usage.total_tokens,
            }
          : {
              input_tokens: options?.promptTokens || 0,
              output_tokens: Math.ceil(text.length / 3),
              total_tokens: (options?.promptTokens || 0) + Math.ceil(text.length / 3),
            },
      };
    }
    return base;
  };

  // 发送初始事件
  writeSSEEvent(res, 'response.created', {
    type: 'response.created',
    response: responseBase('in_progress'),
  });
  writeSSEEvent(res, 'response.in_progress', {
    type: 'response.in_progress',
    response: responseBase('in_progress'),
  });

  const startMessage = () => {
    if (messageStarted) return;
    messageStarted = true;

    writeSSEEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: messageItemId,
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: [],
      },
    });
    writeSSEEvent(res, 'response.content_part.added', {
      type: 'response.content_part.added',
      item_id: messageItemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  const startFunctionCall = (tc: ToolCallEntry) => {
    if (tc.started) return;
    tc.started = true;

    writeSSEEvent(res, 'response.output_item.added', {
      type: 'response.output_item.added',
      output_index: toolCalls.indexOf(tc) + 1,
      item: {
        id: tc.functionCallItemId,
        type: 'function_call',
        status: 'in_progress',
        call_id: tc.id,
        name: tc.name,
        arguments: '',
      },
    });
  };

  const finishMessage = () => {
    if (!messageStarted || messageDone) return;
    messageDone = true;

    writeSSEEvent(res, 'response.output_text.done', {
      type: 'response.output_text.done',
      item_id: messageItemId,
      output_index: 0,
      content_index: 0,
      text,
    });
    writeSSEEvent(res, 'response.content_part.done', {
      type: 'response.content_part.done',
      item_id: messageItemId,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text, annotations: [] },
    });
    writeSSEEvent(res, 'response.output_item.done', {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: messageItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      },
    });
  };

  const completeResponse = () => {
    if (completed) return;
    completed = true;
    finishMessage();

    if (usage && options?.modelId) {
      trackTokenUsage(options.modelId, usage);
    } else if (options?.modelId) {
      trackTokenUsage(options.modelId, {
        prompt_tokens: options.promptTokens || 0,
        completion_tokens: Math.ceil(text.length / 3),
        total_tokens: (options.promptTokens || 0) + Math.ceil(text.length / 3),
      });
    }

    writeSSEEvent(res, 'response.completed', {
      type: 'response.completed',
      response: responseBase('completed'),
    });
    res.write('data: [DONE]\n\n');
    res.end();
  };

  try {
    for await (const chunk of stream) {
      if (completed || res.writableEnded) break;

      if (chunk.usage) usage = chunk.usage;

      if (!chunk.choices || !chunk.choices[0]) continue;

      const delta = chunk.choices[0].delta || {};
      const finishReason = chunk.choices[0].finish_reason;

      // 处理文本内容
      if (typeof delta.content === 'string' && delta.content) {
        startMessage();
        text += delta.content;
        writeSSEEvent(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: messageItemId,
          output_index: 0,
          content_index: 0,
          delta: delta.content,
        });
      }

      // 处理 tool_calls（修复 TODO）
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
          const tcAny = tc as unknown as {
            index: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          };

          // 确保 tool call 条目存在
          while (toolCalls.length <= tcAny.index) {
            const fcId = `fc_${generateRandomString(12)}`;
            toolCalls.push({
              id: '',
              name: '',
              arguments: '',
              functionCallItemId: fcId,
              started: false,
              done: false,
            });
          }

          const tcEntry = toolCalls[tcAny.index];

          // 第一帧：包含 id 和 name
          if (tcAny.id) {
            tcEntry.id = tcAny.id;
          }
          if (tcAny.function?.name) {
            tcEntry.name = tcAny.function.name;
          }

          // 收集 arguments
          if (tcAny.function?.arguments) {
            tcEntry.arguments += tcAny.function.arguments;
          }

          // 开始 function call item（有 id 的时候才发出事件）
          if (tcEntry.id && !tcEntry.started) {
            startFunctionCall(tcEntry);
          }

          // 更新 arguments delta 事件
          if (tcAny.function?.arguments && tcEntry.started) {
            writeSSEEvent(res, 'response.output_item.delta', {
              type: 'response.output_item.delta',
              item_id: tcEntry.functionCallItemId,
              output_index: toolCalls.indexOf(tcEntry) + 1,
              delta: {
                arguments: tcAny.function.arguments,
              },
            });
          }
        }
      }

      // 处理完成
      if (finishReason) {
        completeResponse();
        return;
      }
    }

    // 循环正常结束但未收到 finish_reason
    if (!completed) {
      completeResponse();
    }
  } catch (err) {
    console.error('[responses stream from chat] fatal:', err);
    if (!res.writableEnded) res.end();
  }
}

// ========== Chat SSE → Anthropic SSE 流式转换 ==========

/**
 * OpenAI Chat SSE → Anthropic Messages SSE 转换
 *
 * 将 Chat Completions 流式 chunk 实时转换为 Anthropic SSE 事件序列，
 * 供 /v1/messages?stream=true 端点使用。
 *
 * Anthropic SSE 事件序列：
 *   message_start → content_block_start (text) → content_block_delta (text_delta)
 *   → content_block_start (tool_use) → content_block_delta (input_json_delta)
 *   → content_block_stop → message_delta (stop_reason + usage) → message_stop
 */
export async function streamChatAsAnthropicSSE(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  res: Response,
  modelName: string,
  promptTokens = 0,
  modelId?: number,
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const messageId = `msg_${generateRandomString(24)}`;
  let textContent = '';
  let usage: OpenAI.CompletionUsage | null = null;
  let completed = false;

  // 内容块状态跟踪
  let textBlockIndex = -1;        // text 块索引（第一个）
  let nextContentBlockIndex = 0;  // 下一个可用索引
  const toolBlockIndices: Map<number, number> = new Map(); // tool call index → content block index
  const toolIdToIndex: Map<string, number> = new Map();    // tool call id → tool call index
  let startedBlocks: Set<number> = new Set();
  let toolCallStreamStarted = false;

  const emitMessageStart = () => {
    writeSSEEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: modelName,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };

  const emitTextBlockStart = () => {
    textBlockIndex = nextContentBlockIndex++;
    startedBlocks.add(textBlockIndex);
    writeSSEEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: textBlockIndex,
      content_block: { type: 'text', text: '' },
    });
  };

  const emitTextBlockDelta = (text: string) => {
    if (textBlockIndex < 0) emitTextBlockStart();
    writeSSEEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: textBlockIndex,
      delta: { type: 'text_delta', text },
    });
  };

  const emitToolBlockStart = (toolCallIndex: number, id: string, name: string) => {
    const blockIndex = nextContentBlockIndex++;
    toolBlockIndices.set(toolCallIndex, blockIndex);
    startedBlocks.add(blockIndex);
    writeSSEEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: { type: 'tool_use', id, name, input: {} },
    });
  };

  const emitToolInputDelta = (toolCallIndex: number, partialJson: string) => {
    const blockIndex = toolBlockIndices.get(toolCallIndex);
    if (blockIndex === undefined) return;
    writeSSEEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: partialJson },
    });
  };

  const emitMessageDelta = (stopReason: string | null) => {
    writeSSEEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: usage
        ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens }
        : { input_tokens: promptTokens, output_tokens: Math.ceil(textContent.length / 3) },
    });
  };

  const emitMessageStop = () => {
    writeSSEEvent(res, 'message_stop', { type: 'message_stop' });
  };

  const finishAllBlocks = () => {
    const sortedBlocks = [...startedBlocks].sort((a, b) => a - b);
    for (const idx of sortedBlocks) {
      writeSSEEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index: idx,
      });
    }
    startedBlocks.clear();
  };

  // 发送 message_start
  emitMessageStart();

  try {
    for await (const chunk of stream) {
      if (completed || res.writableEnded) break;

      if (chunk.usage) usage = chunk.usage;

      if (!chunk.choices || !chunk.choices[0]) continue;

      const delta = chunk.choices[0].delta || {};
      const finishReason = chunk.choices[0].finish_reason;

      // 文本 delta → content_block_delta (text_delta)
      if (typeof delta.content === 'string' && delta.content) {
        textContent += delta.content;
        emitTextBlockDelta(delta.content);
      }

      // tool_calls delta → content_block_start (tool_use) + content_block_delta (input_json_delta)
      if (delta.tool_calls && delta.tool_calls.length > 0) {
        for (const tc of delta.tool_calls) {
          const tcAny = tc as unknown as {
            index: number;
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          };
          const fun = tcAny.function || {};

          // 记录工具调用 ID 映射
          if (tcAny.id) {
            toolIdToIndex.set(tcAny.id, tcAny.index);
          }

          // 第一帧（含 id）：发送 content_block_start for tool_use
          if (tcAny.id && fun.name) {
            toolCallStreamStarted = true;
            emitToolBlockStart(tcAny.index, tcAny.id, fun.name);
          }

          // arguments delta → input_json_delta
          if (fun.arguments) {
            emitToolInputDelta(tcAny.index, fun.arguments);
          }
        }
      }

      // finish_reason → message_delta + content_block_stop + message_stop
      if (finishReason) {
        // 无可见输出时注入零宽字符作为文本块
        if (!textContent && textBlockIndex < 0) {
          emitTextBlockDelta(INVISIBLE_SENTINEL);
          textContent = INVISIBLE_SENTINEL;
        }

        const mappedStopReason = (() => {
          switch (finishReason) {
            case 'stop': return 'end_turn';
            case 'length': return 'max_tokens';
            case 'tool_calls': return 'tool_use';
            case 'content_filter': return 'content_filtered';
            default: return finishReason;
          }
        })();

        // 关闭所有已开始的内容块
        finishAllBlocks();

        // 发送 message_delta（含 usage）
        emitMessageDelta(mappedStopReason);

        // 发送 message_stop
        emitMessageStop();

        // 记录 token 统计
        if (usage && modelId) {
          trackTokenUsage(modelId, usage);
        } else if (modelId) {
          trackTokenUsage(modelId, {
            prompt_tokens: promptTokens,
            completion_tokens: Math.ceil(textContent.length / 3),
            total_tokens: promptTokens + Math.ceil(textContent.length / 3),
          });
        }
        trackApiCall(modelId);

        res.write('data: [DONE]\n\n');
        res.end();
        completed = true;
        return;
      }
    }

    // 流结束但未收到 finish_reason
    if (!completed) {
      // 无可见输出时注入零宽字符
      if (!textContent && textBlockIndex < 0) {
        emitTextBlockDelta(INVISIBLE_SENTINEL);
        textContent = INVISIBLE_SENTINEL;
      }
      finishAllBlocks();
      emitMessageDelta('end_turn');
      emitMessageStop();
      if (modelId) {
        trackTokenUsage(modelId, {
          prompt_tokens: promptTokens,
          completion_tokens: Math.ceil(textContent.length / 3),
          total_tokens: promptTokens + Math.ceil(textContent.length / 3),
        });
        trackApiCall(modelId);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    }
  } catch (err) {
    console.error('[chat→anthropic sse] fatal:', err);
    if (!res.writableEnded) {
      try { writeSSEEvent(res, 'error', { type: 'error', error: { type: 'server_error', message: (err as Error).message } }); } catch { /* ignore */ }
      res.end();
    }
  }
}
