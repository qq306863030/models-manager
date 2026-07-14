/**
 * ChatToAnthropicProxy — Chat Completions → Anthropic Messages 转换代理
 *
 * 将 OpenAI Chat Completions 格式的请求转换为 Anthropic Messages API 格式，
 * 发送到上游 /v1/messages 端点，响应通过标准化回调输出。
 */

import BaseProxy from './common/BaseProxy';
import type { ChatCompletionsProxyInput, SSECallbacks } from './common/types';
import { streamWithRetry } from './common/sse-utils';
import { fetchWithRetry } from './common/fetch-with-retry';
import { chatRequestToAnthropicRequest } from './common/convert-utils';

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
        baseUrl: input.config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || 'ChatToAnthropic',
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
      },
      body: { ...input.body },
    };
  }

  protected transformRequest(input: ChatCompletionsProxyInput): Record<string, unknown> {
    // Chat → Anthropic 格式转换
    const anthropicBody = chatRequestToAnthropicRequest(input.body);
    // 强制流式
    anthropicBody.stream = true;
    return anthropicBody;
  }

  protected buildEndpoint(_input: ChatCompletionsProxyInput): string {
    return `${_input.config.baseUrl}/v1/messages`;
  }

  protected async proxy(input: ChatCompletionsProxyInput, body: Record<string, unknown>, endpoint: string): Promise<void> {
    const providerLabel = input.config.providerLabel || 'ChatToAnthropic';

    await streamWithRetry(
      () => fetchWithRetry(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': input.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
        providerLabel,
      }),
      (reader, cbs) => this.parseAnthropicStream(reader, cbs),
      this.callbacks || {},
      { maxRetries: input.config.maxRetries ?? 2, providerLabel },
    );
  }

  /**
   * Anthropic SSE 流解析 — 将上游 Anthropic SSE 事件通过 callbacks 输出
   */
  private async parseAnthropicStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: SSECallbacks,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('event:')) continue;
        if (!trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        try {
          const event = JSON.parse(dataStr);

          switch (event.type) {
            case 'content_block_delta': {
              const delta = event.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                callbacks.onContent?.(delta.text);
              }
              if (delta?.type === 'thinking_delta' && delta.thinking) {
                callbacks.onThinking?.(delta.thinking);
              }
              if (delta?.type === 'input_json_delta' && delta.partial_json) {
                callbacks.onToolDelta?.(delta.partial_json, {
                  id: event.content_block?.id || '',
                  index: event.index || 0,
                  name: event.content_block?.name || '',
                  field: 'arguments',
                });
              }
              break;
            }
            case 'content_block_start': {
              if (event.content_block?.type === 'tool_use') {
                callbacks.onToolDelta?.(event.content_block.name || '', {
                  id: event.content_block.id || '',
                  index: event.index || 0,
                  name: event.content_block.name || '',
                  field: 'name',
                });
              }
              break;
            }
            case 'message_delta': {
              if (event.usage) {
                callbacks.onUsage?.({ prompt_tokens: 0, completion_tokens: event.usage.output_tokens || 0, total_tokens: event.usage.output_tokens || 0 });
              }
              break;
            }
            case 'message_stop':
              callbacks.onDone?.();
              return;
          }
        } catch { /* skip */ }
      }
    }
    callbacks.onDone?.();
  }

  async execute(input: ChatCompletionsProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
