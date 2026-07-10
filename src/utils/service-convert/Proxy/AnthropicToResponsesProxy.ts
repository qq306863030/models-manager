/**
 * AnthropicToResponsesProxy — Anthropic → Responses 转换代理
 *
 * 将 Anthropic Messages API 格式的请求转换为 Responses 格式，
 * 发送到上游 /responses 端点。
 *
 * 参考 cc-switch：anthropic_to_responses + responses_to_anthropic
 */

import BaseProxy from './common/BaseProxy';
import type { AnthropicProxyInput, SSECallbacks } from './common/types';
import {
  anthropicRequestToResponsesRequest,
} from './common/convert-utils';
import { parseResponsesStream } from './common/sse-utils';

export default class AnthropicToResponsesProxy extends BaseProxy<AnthropicProxyInput, void, Record<string, unknown>> {
  private callbacks?: SSECallbacks;

  setCallbacks(callbacks: SSECallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  protected validate(input: AnthropicProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('AnthropicToResponsesProxy: baseUrl required');
    if (!input.config?.apiKey) throw new Error('AnthropicToResponsesProxy: apiKey required');
    if (!input.body?.model) throw new Error('AnthropicToResponsesProxy: model required');
  }

  protected optimizeInput(input: AnthropicProxyInput): AnthropicProxyInput {
    return {
      ...input,
      config: {
        baseUrl: input.config.baseUrl.replace(/\/+$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || 'AnthropicToResponses',
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
      },
      body: { ...input.body, max_tokens: input.body.max_tokens || 4096 },
    };
  }

  protected transformRequest(input: AnthropicProxyInput): Record<string, unknown> {
    return anthropicRequestToResponsesRequest(input.body);
  }

  protected buildEndpoint(input: AnthropicProxyInput): string {
    return `${input.config.baseUrl}/responses`;
  }

  protected async proxy(
    input: AnthropicProxyInput,
    body: Record<string, unknown>,
    endpoint: string,
  ): Promise<void> {
    this.callbacks?.onConnectionStatus?.({ state: 'connected' });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), input.config.timeoutMs || 300_000);
    body.stream = true;

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
        await parseResponsesStream(reader, {
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

  async execute(input: AnthropicProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
