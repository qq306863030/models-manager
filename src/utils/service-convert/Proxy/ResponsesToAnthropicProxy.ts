/**
 * ResponsesToAnthropicProxy — Responses → Anthropic 转换代理
 *
 * 将 Responses API 格式的请求转换为 Anthropic Messages 格式，
 * 发送到上游 /v1/messages 端点。
 */

import BaseProxy from './common/BaseProxy';
import type { ResponsesProxyInput, SSECallbacks } from './common/types';
import {
  responsesRequestToChatRequest,
} from './common/convert-utils';

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
        baseUrl: input.config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || 'ResponsesToAnthropic',
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
    return `${input.config.baseUrl}/v1/messages`;
  }

  protected async proxy(input: ResponsesProxyInput, chatBody: Record<string, unknown>, endpoint: string): Promise<void> {
    this.callbacks?.onConnectionStatus?.({ state: 'connected' });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), input.config.timeoutMs || 300_000);

    const anthropicBody: Record<string, unknown> = {
      model: chatBody.model,
      max_tokens: (chatBody.max_tokens as number) || 4096,
      stream: false,
    };

    if (Array.isArray(chatBody.messages)) {
      const systemMsgs = (chatBody.messages as Array<Record<string, unknown>>).filter((m) => m.role === 'system');
      const nonSystemMsgs = (chatBody.messages as Array<Record<string, unknown>>).filter((m) => m.role !== 'system');
      if (systemMsgs.length > 0) anthropicBody.system = systemMsgs.map((m) => m.content).join('\n\n');
      anthropicBody.messages = nonSystemMsgs.map((m) => ({ role: m.role, content: m.content }));
    }
    if (chatBody.temperature !== undefined) anthropicBody.temperature = chatBody.temperature;
    if (chatBody.top_p !== undefined) anthropicBody.top_p = chatBody.top_p;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': input.config.apiKey as string, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(anthropicBody),
        signal: controller.signal,
      });
      if (!response.ok) { const e = await response.text(); throw new Error(`API error (${response.status}): ${e.slice(0, 200)}`); }
      const anthropicResponse = await response.json() as Record<string, unknown>;
      this.callbacks?.onContent?.(JSON.stringify(anthropicResponse));
      this.callbacks?.onDone?.();
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
