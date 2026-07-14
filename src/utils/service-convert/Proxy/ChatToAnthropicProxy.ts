/**
 * ChatToAnthropicProxy — Chat Completions → Anthropic Messages 转换代理
 *
 * Hub-and-spoke 模式：所有格式转换经过 OpenAI Chat 作为中间格式。
 * Chat 格式直接调用 /chat/completions，响应通过标准化回调输出。
 * 响应格式转换在 transformResponse 中处理（非流式）。
 */

import BaseProxy from './common/BaseProxy';
import type { ChatCompletionsProxyInput, SSECallbacks } from './common/types';
import { parseChatCompletionsStream, streamWithRetry } from './common/sse-utils';
import { fetchWithRetry } from './common/fetch-with-retry';

export default class ChatToAnthropicProxy extends BaseProxy<ChatCompletionsProxyInput, void, Record<string, unknown>> {
  private callbacks?: SSECallbacks;

  setCallbacks(callbacks: SSECallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  protected validate(input: ChatCompletionsProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('ChatToAnthropicProxy: baseUrl required');
    if (!input.config?.apiKey) throw new Error('ChatToAnthropicProxy: apiKey required');
    if (!input.body?.model) throw new Error('ChatToAnthropicProxy: model required');
  }

  protected optimizeInput(input: ChatCompletionsProxyInput): ChatCompletionsProxyInput {
    return {
      ...input,
      config: {
        baseUrl: input.config.baseUrl.replace(/\/+$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || 'ChatToAnthropic',
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
    const providerLabel = input.config.providerLabel || 'ChatToAnthropic';

    await streamWithRetry(
      () => fetchWithRetry(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${input.config.apiKey}` },
        body: JSON.stringify(body),
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
        providerLabel,
      }),
      (reader, cbs) => parseChatCompletionsStream(reader, cbs),
      this.callbacks || {},
      { maxRetries: input.config.maxRetries ?? 2, providerLabel },
    );
  }

  async execute(input: ChatCompletionsProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
