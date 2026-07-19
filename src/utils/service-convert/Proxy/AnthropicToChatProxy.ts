/**
 * AnthropicToChatProxy — Anthropic → Chat Completions 转换代理
 *
 * 将 Anthropic Messages API 格式的请求转换为 Chat Completions 格式，
 * 发送到上游 /chat/completions 端点，再将响应转换回 Anthropic 格式。
 *
 * 参考 cc-switch：anthropic_to_openai_with_reasoning_content + openai_to_anthropic
 */

import BaseProxy from './common/BaseProxy';
import type { AnthropicProxyInput, SSECallbacks } from './common/types';
import {
  anthropicRequestToChatRequest,
} from './common/convert-utils';
import { appendPartialAssistantContent, parseChatCompletionsStream, streamWithRetry } from './common/sse-utils';
import { fetchWithRetry } from './common/fetch-with-retry';

export default class AnthropicToChatProxy extends BaseProxy<AnthropicProxyInput, void, Record<string, unknown>> {
  private callbacks?: SSECallbacks;

  setCallbacks(callbacks: SSECallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  protected validate(input: AnthropicProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('AnthropicToChatProxy: baseUrl required');
    if (!input.config?.apiKey) throw new Error('AnthropicToChatProxy: apiKey required');
    if (!input.body?.model) throw new Error('AnthropicToChatProxy: model required');
  }

  protected optimizeInput(input: AnthropicProxyInput): AnthropicProxyInput {
    return {
      ...input,
      config: {
        baseUrl: input.config.baseUrl.replace(/\/+$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || 'AnthropicToChat',
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
      },
      body: { ...input.body, max_tokens: input.body.max_tokens || 4096 },
    };
  }

  protected transformRequest(input: AnthropicProxyInput): Record<string, unknown> {
    return anthropicRequestToChatRequest(input.body, true);
  }

  protected buildEndpoint(input: AnthropicProxyInput): string {
    return `${input.config.baseUrl}/chat/completions`;
  }

  protected async proxy(
    input: AnthropicProxyInput,
    body: Record<string, unknown>,
    endpoint: string,
  ): Promise<void> {
    const providerLabel = input.config.providerLabel || 'AnthropicToChat';
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

  async execute(input: AnthropicProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
