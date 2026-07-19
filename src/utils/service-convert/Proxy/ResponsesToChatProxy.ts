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
import { appendPartialAssistantContent, parseChatCompletionsStream, streamWithRetry } from './common/sse-utils';
import { fetchWithRetry } from './common/fetch-with-retry';

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
    const providerLabel = input.config.providerLabel || 'ResponsesToChat';
    body.stream = true;
    body.stream_options = { include_usage: true };
    let currentBody: Record<string, unknown> = body;

    await streamWithRetry(
      () => fetchWithRetry(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${input.config.apiKey}` },
        body: JSON.stringify(currentBody),
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
        providerLabel,
      }),
      (reader, cbs) => parseChatCompletionsStream(reader, cbs),
      this.callbacks || {},
      {
        maxRetries: input.config.maxRetries ?? 2,
        providerLabel,
        onRetry: ({ emittedText }) => {
          currentBody = appendPartialAssistantContent(currentBody, emittedText);
        },
      },
    );
  }

  async execute(input: ResponsesProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
