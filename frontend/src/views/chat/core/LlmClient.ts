/**
 * LlmClient.ts
 *
 * 负责与后端 /v1/chat/completions 代理进行 SSE 流式通信，
 * 解析 Markdown 增量、reasoning_content 思考过程、以及 tool_calls 分片拼接。
 */

export interface ILlmToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type TMessageContent =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

export interface ILlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: TMessageContent;
  tool_calls?: ILlmToolCall[];
  tool_call_id?: string;
}

export interface ILlmToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface IStreamHandlers {
  onDelta: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolCalls?: (calls: ILlmToolCall[]) => void;
  onDone: (finishReason: string) => void;
  onError: (message: string) => void;
}

export interface IStreamOptions {
  tools?: ILlmToolSchema[];
  maxTokens?: number;
  temperature?: number;
}

interface IStreamToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface IStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: IStreamToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
}

interface IFrameResult {
  content?: string;
  reasoning?: string;
  toolCallDeltas?: IStreamToolCallDelta[];
  finishReason?: string;
  done?: boolean;
}

export class LlmClient {
  private static instance: LlmClient | null = null;
  private proxyPath = '/v1/chat/completions';

  static getInstance(): LlmClient {
    if (!LlmClient.instance) {
      LlmClient.instance = new LlmClient();
    }
    return LlmClient.instance;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream, application/json',
    };

    const token = localStorage.getItem('auth_token');
    const username = localStorage.getItem('auth_username');
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    if (username) {
      headers['X-Username'] = username;
    }

    return headers;
  }

  /**
   * 发起流式对话
   * @returns 中止函数（用于"停止生成"）
   */
  async streamChat(
    modelName: string,
    messages: ILlmMessage[],
    handlers: IStreamHandlers,
    options: IStreamOptions = {}
  ): Promise<() => void> {
    const controller = new AbortController();

    if (!modelName) {
      handlers.onError('请先选择有效的模型');
      return () => controller.abort();
    }

    const body: Record<string, unknown> = {
      model: modelName,
      messages,
      stream: true,
      max_tokens: options.maxTokens ?? 8192,
    };

    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = 'auto';
    }

    const username = localStorage.getItem('auth_username');
    // 统一请求 /v1/chat/completions，后端会自动从 X-Username 请求头关联当前用户
    const endpoint = this.proxyPath;

    void (async () => {
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          const rawText = await response.text().catch(() => '');
          let errMsg = `上游响应错误 (${response.status})`;
          try {
            const errObj = JSON.parse(rawText);
            errMsg = errObj?.error?.message || errObj?.message || rawText || errMsg;
          } catch {}
          handlers.onError(errMsg);
          return;
        }

        if (!response.body) {
          handlers.onError('上游未返回流式响应体');
          return;
        }

        await this.consumeStream(response.body, handlers);
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          handlers.onDone('aborted');
          return;
        }
        handlers.onError(`网络请求异常：${(error as Error).message}`);
      }
    })();

    return () => controller.abort();
  }

  /** 消费 SSE 流并按帧回调 */
  private async consumeStream(
    body: ReadableStream<Uint8Array>,
    handlers: IStreamHandlers
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    const toolCallMap = new Map<number, ILlmToolCall>();

    let buffer = '';
    let finishReason = 'stop';
    let done = false;
    let inThinkTag = false;

    try {
      while (!done) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;

        buffer += decoder.decode(value, { stream: true });

        // 查找帧边界（兼容 \r\n\r\n 与 \n\n）
        while (true) {
          const idxCRLF = buffer.indexOf('\r\n\r\n');
          const idxLF = buffer.indexOf('\n\n');
          let boundary = -1;
          let delimiterLen = 2;

          if (idxCRLF !== -1 && (idxLF === -1 || idxCRLF < idxLF)) {
            boundary = idxCRLF;
            delimiterLen = 4;
          } else if (idxLF !== -1) {
            boundary = idxLF;
            delimiterLen = 2;
          }

          if (boundary === -1) break;

          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + delimiterLen);

          const result = this.parseFrame(frame);
          if (result) {
            // 处理显式思考字段
            if (result.reasoning) {
              handlers.onReasoning?.(result.reasoning);
            }

            // 处理正文 content（兼顾处理内嵌的 <think>...</think> 标签）
            if (result.content) {
              let text = result.content;
              while (text.length > 0) {
                if (!inThinkTag) {
                  const thinkStartIdx = text.indexOf('<think>');
                  if (thinkStartIdx !== -1) {
                    if (thinkStartIdx > 0) {
                      handlers.onDelta(text.slice(0, thinkStartIdx));
                    }
                    inThinkTag = true;
                    text = text.slice(thinkStartIdx + 7);
                  } else {
                    handlers.onDelta(text);
                    text = '';
                  }
                } else {
                  const thinkEndIdx = text.indexOf('</think>');
                  if (thinkEndIdx !== -1) {
                    if (thinkEndIdx > 0) {
                      handlers.onReasoning?.(text.slice(0, thinkEndIdx));
                    }
                    inThinkTag = false;
                    text = text.slice(thinkEndIdx + 8);
                  } else {
                    handlers.onReasoning?.(text);
                    text = '';
                  }
                }
              }
            }

            if (result.toolCallDeltas) this.accumulateToolCalls(toolCallMap, result.toolCallDeltas);
            if (result.finishReason) finishReason = result.finishReason;
            if (result.done) {
              done = true;
              break;
            }
          }

          boundary = buffer.indexOf('\n\n');
        }
      }

      if (toolCallMap.size > 0) {
        const calls = Array.from(toolCallMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([, call]) => call);
        handlers.onToolCalls?.(calls);
      }

      handlers.onDone(finishReason);
    } finally {
      reader.releaseLock();
    }
  }

  /** 解析单个 SSE 帧 */
  private parseFrame(frame: string): IFrameResult | null {
    for (const line of frame.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;

      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      if (payload === '[DONE]') return { done: true };

      try {
        const chunk = JSON.parse(payload) as Record<string, any>;
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = (choice.delta || choice.message || {}) as Record<string, any>;
        const result: IFrameResult = {};

        // 正文 content
        if (typeof delta.content === 'string') {
          result.content = delta.content;
        }

        // 思考过程 reasoning (兼容各大厂商字段命名规范，包括驼峰、顶层及 choice 级别)
        let reasoningDelta = '';
        if (typeof delta.reasoning_content === 'string') reasoningDelta = delta.reasoning_content;
        else if (typeof delta.reasoningContent === 'string') reasoningDelta = delta.reasoningContent;
        else if (typeof delta.reasoning === 'string') reasoningDelta = delta.reasoning;
        else if (typeof delta.thought === 'string') reasoningDelta = delta.thought;
        else if (typeof delta.thinking === 'string') reasoningDelta = delta.thinking;
        else if (typeof delta.thought_content === 'string') reasoningDelta = delta.thought_content;
        else if (typeof choice.reasoning_content === 'string') reasoningDelta = choice.reasoning_content;
        else if (typeof choice.reasoning === 'string') reasoningDelta = choice.reasoning;
        else if (typeof choice.thought === 'string') reasoningDelta = choice.thought;
        else if (typeof choice.thinking === 'string') reasoningDelta = choice.thinking;
        else if (typeof chunk.reasoning_content === 'string') reasoningDelta = chunk.reasoning_content;
        else if (typeof chunk.reasoning === 'string') reasoningDelta = chunk.reasoning;

        if (reasoningDelta) {
          result.reasoning = reasoningDelta;
        }

        if (delta.tool_calls?.length) result.toolCallDeltas = delta.tool_calls;
        if (choice.finish_reason) result.finishReason = choice.finish_reason;

        if (result.content || result.reasoning || result.toolCallDeltas || result.finishReason) {
          return result;
        }
      } catch {}
    }
    return null;
  }

  /** 按 index 拼接工具调用增量分片 */
  private accumulateToolCalls(
    map: Map<number, ILlmToolCall>,
    deltas: IStreamToolCallDelta[]
  ): void {
    deltas.forEach((delta, order) => {
      const index = typeof delta.index === 'number' ? delta.index : order;
      const current =
        map.get(index) ??
        ({
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        } as ILlmToolCall);

      if (delta.id) current.id = delta.id;
      if (delta.function?.name) current.function.name += delta.function.name;
      if (delta.function?.arguments) current.function.arguments += delta.function.arguments;

      map.set(index, current);
    });
  }
}

export default LlmClient;
