/**
 * ResponsesToChatProxy — Responses → Chat Completions 转换代理
 *
 * 将 Responses API 格式的请求转换为 Chat Completions 格式，
 * 发送到上游 /chat/completions 端点，再将响应转换回 Responses 格式。
 */

import BaseProxy from './common/BaseProxy';
import type { ResponsesProxyInput, SSECallbacks } from './common/types';
import {
  responsesRequestToChatRequest,
} from './common/convert-utils';
import { parseChatCompletionsStream } from './common/sse-utils';

export default class ResponsesToChatProxy extends BaseProxy<ResponsesProxyInput, void, Record<string, unknown>> {
  private callbacks?: SSECallbacks;

  setCallbacks(callbacks: SSECallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  protected validate(input: ResponsesProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('ResponsesToChatProxy: baseUrl required');
    if (!input.config?.apiKey) throw new Error('ResponsesToChatProxy: apiKey required');
    if (!input.body?.model) throw new Error('ResponsesToChatProxy: model required');
  }

  protected optimizeInput(input: ResponsesProxyInput): ResponsesProxyInput {
    return {
      ...input,
      config: {
        baseUrl: input.config.baseUrl.replace(/\/+$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || 'ResponsesToChat',
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
      },
      body: { ...input.body, stream: input.body.stream !== false },
    };
  }

  protected transformRequest(input: ResponsesProxyInput): Record<string, unknown> {
    return responsesRequestToChatRequest(input.body);
  }

  protected buildEndpoint(input: ResponsesProxyInput): string {
    return `${input.config.baseUrl}/chat/completions`;
  }

  protected async proxy(input: ResponsesProxyInput, body: Record<string, unknown>, endpoint: string): Promise<void> {
    this.callbacks?.onConnectionStatus?.({ state: 'connected' });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), input.config.timeoutMs || 300_000);
    body.stream = true;
    body.stream_options = { include_usage: true };

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
    } finally { clearTimeout(timeoutId); }
  }

  async execute(input: ResponsesProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
