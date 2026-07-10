/**
 * AnthropicProxy — Anthropic Messages API 纯代理
 *
 * 纯代理转发，不涉及 API 类型转换。
 * 将 Anthropic Messages 格式的请求转发到上游 /v1/messages 端点。
 *
 * 特性：
 * - Anthropic SSE 流式解析
 * - 请求超时保护
 * - Token 用量追踪
 */

import BaseProxy from './common/BaseProxy';
import type { AnthropicProxyInput, AnthropicRequestBody, SSECallbacks } from './common/types';

export default class AnthropicProxy extends BaseProxy<AnthropicProxyInput, void, AnthropicRequestBody> {
  private callbacks?: SSECallbacks;

  setCallbacks(callbacks: SSECallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  protected validate(input: AnthropicProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('AnthropicProxy: baseUrl required');
    if (!input.config?.apiKey) throw new Error('AnthropicProxy: apiKey required');
    if (!input.body?.model) throw new Error('AnthropicProxy: model required');
    if (!input.body?.max_tokens) throw new Error('AnthropicProxy: max_tokens required');
  }

  protected optimizeInput(input: AnthropicProxyInput): AnthropicProxyInput {
    return {
      ...input,
      config: {
        baseUrl: input.config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || 'Anthropic',
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
      },
      body: { ...input.body },
    };
  }

  protected transformRequest(input: AnthropicProxyInput): AnthropicRequestBody {
    return { ...input.body };
  }

  protected buildEndpoint(input: AnthropicProxyInput): string {
    return `${input.config.baseUrl}/v1/messages`;
  }

  /**
   * Anthropic API 代理 — 支持流式和非流式
   */
  protected async proxy(
    input: AnthropicProxyInput,
    body: AnthropicRequestBody,
    endpoint: string,
  ): Promise<void> {
    this.callbacks?.onConnectionStatus?.({ state: 'connected' });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), input.config.timeoutMs || 300_000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': input.config.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message || errorText;
        } catch {
          errorMessage = errorText;
        }
        throw new Error(`Anthropic API error (${response.status}): ${errorMessage}`);
      }

      if (!response.body) throw new Error('No response body received');

      this.callbacks?.onConnectionStatus?.({ state: 'streaming' });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          if (controller.signal.aborted) break;
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
                    this.callbacks?.onContent?.(delta.text);
                  }
                  if (delta?.type === 'thinking_delta' && delta.thinking) {
                    this.callbacks?.onThinking?.(delta.thinking);
                  }
                  if (delta?.type === 'input_json_delta' && delta.partial_json) {
                    this.callbacks?.onToolDelta?.(delta.partial_json, {
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
                    this.callbacks?.onToolDelta?.(event.content_block.name || '', {
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
                    this.callbacks?.onUsage?.({ prompt_tokens: 0, completion_tokens: event.usage.output_tokens || 0, total_tokens: event.usage.output_tokens || 0 });
                  }
                  break;
                }
                case 'message_stop':
                  this.callbacks?.onDone?.();
                  return;
              }
            } catch { /* skip */ }
          }
        }
        this.callbacks?.onDone?.();
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.callbacks?.onDone?.();
        return;
      }
      this.callbacks?.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async execute(input: AnthropicProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
