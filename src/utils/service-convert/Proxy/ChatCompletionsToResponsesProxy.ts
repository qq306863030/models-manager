/**
 * ChatCompletionsToResponsesProxy — Chat Completions → Responses 转换代理
 *
 * Hub-and-spoke 模式：所有格式转换经过 OpenAI Chat 作为中间格式。
 * Chat 格式直接调用 /chat/completions，响应通过标准化回调输出。
 * 响应格式转换在 transformResponse 中处理（非流式）。
 */

import BaseProxy from './common/BaseProxy';
import type { ChatCompletionsProxyInput, SSECallbacks } from './common/types';
import { parseChatCompletionsStream } from './common/sse-utils';

export default class ChatCompletionsToResponsesProxy extends BaseProxy<ChatCompletionsProxyInput, void, Record<string, unknown>> {
  private callbacks?: SSECallbacks;

  setCallbacks(callbacks: SSECallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  protected validate(input: ChatCompletionsProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('ChatCompletionsToResponsesProxy: baseUrl required');
    if (!input.config?.apiKey) throw new Error('ChatCompletionsToResponsesProxy: apiKey required');
    if (!input.body?.model) throw new Error('ChatCompletionsToResponsesProxy: model required');
  }

  protected optimizeInput(input: ChatCompletionsProxyInput): ChatCompletionsProxyInput {
    return {
      ...input,
      config: {
        baseUrl: input.config.baseUrl.replace(/\/+$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || 'ChatToResponses',
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
      },
      body: { ...input.body },
    };
  }

  protected transformRequest(input: ChatCompletionsProxyInput): Record<string, unknown> {
    // Chat 已经是中间格式，不需要转换
    return { ...input.body, stream: input.body.stream !== false, stream_options: { include_usage: true }, max_tokens: input.body.max_tokens || 4096 };
  }

  protected buildEndpoint(_input: ChatCompletionsProxyInput): string {
    return `${_input.config.baseUrl}/chat/completions`;
  }

  protected async proxy(input: ChatCompletionsProxyInput, body: Record<string, unknown>, endpoint: string): Promise<void> {
    this.callbacks?.onConnectionStatus?.({ state: 'connected' });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), input.config.timeoutMs || 300_000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${input.config.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) { const e = await response.text(); throw new Error(`API error (${response.status}): ${e.slice(0, 200)}`); }
      if (!response.body) throw new Error('No response body received');
      this.callbacks?.onConnectionStatus?.({ state: 'streaming' });
      const reader = response.body.getReader();
      try {
        await parseChatCompletionsStream(reader, {
          onContent: (d) => this.callbacks?.onContent?.(d),
          onThinking: (d) => this.callbacks?.onThinking?.(d),
          onToolCall: (t) => this.callbacks?.onToolCall?.(t),
          onUsage: (u) => this.callbacks?.onUsage?.(u),
          onDone: () => this.callbacks?.onDone?.(),
          onError: (e) => this.callbacks?.onError?.(e),
        });
      } finally { reader.releaseLock(); }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') { this.callbacks?.onDone?.(); return; }
      this.callbacks?.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally { clearTimeout(timeoutId); }
  }

  async execute(input: ChatCompletionsProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
