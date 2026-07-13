/**
 * ResponsesToAnthropicProxy — Responses → Anthropic 转换代理
 *
 * Hub-and-spoke 模式：所有格式转换经过 OpenAI Chat 作为中间格式。
 * Responses 请求先转为 Chat 格式，调用 /chat/completions，
 * 响应通过标准化回调输出。
 */

import BaseProxy from './common/BaseProxy';
import type { ResponsesProxyInput, SSECallbacks } from './common/types';
import { responsesRequestToChatRequest } from './common/convert-utils';
import { parseChatCompletionsStream } from './common/sse-utils';

export default class ResponsesToAnthropicProxy extends BaseProxy<ResponsesProxyInput, void, Record<string, unknown>> {
  private callbacks?: SSECallbacks;

  setCallbacks(callbacks: SSECallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  protected validate(input: ResponsesProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('ResponsesToAnthropicProxy: baseUrl required');
    if (!input.config?.apiKey) throw new Error('ResponsesToAnthropicProxy: apiKey required');
    if (!input.body?.model) throw new Error('ResponsesToAnthropicProxy: model required');
  }

  protected optimizeInput(input: ResponsesProxyInput): ResponsesProxyInput {
    return {
      ...input,
      config: {
        baseUrl: input.config.baseUrl.replace(/\/+$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || 'ResponsesToAnthropic',
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
      },
      body: { ...input.body },
    };
  }

  protected transformRequest(input: ResponsesProxyInput): Record<string, unknown> {
    // Responses → Chat（中间格式）
    const chatBody = responsesRequestToChatRequest(input.body);
    chatBody.stream = chatBody.stream !== false;
    chatBody.stream_options = { include_usage: true };
    return chatBody;
  }

  protected buildEndpoint(_input: ResponsesProxyInput): string {
    return `${_input.config.baseUrl}/chat/completions`;
  }

  protected async proxy(input: ResponsesProxyInput, body: Record<string, unknown>, endpoint: string): Promise<void> {
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

  async execute(input: ResponsesProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
