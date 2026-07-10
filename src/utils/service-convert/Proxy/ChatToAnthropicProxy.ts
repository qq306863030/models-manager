/**
 * ChatToAnthropicProxy — Chat Completions → Anthropic Messages 转换代理
 *
 * 将 Chat Completions 格式的请求转换为 Anthropic Messages 格式，
 * 发送到上游 /v1/messages 端点，解析 Anthropic SSE 流并输出。
 */

import BaseProxy from './common/BaseProxy';
import type { ChatCompletionsProxyInput, SSECallbacks } from './common/types';
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
      body: { ...input.body, stream: input.body.stream !== false, max_tokens: input.body.max_tokens || 4096 },
    };
  }

  protected transformRequest(input: ChatCompletionsProxyInput): Record<string, unknown> {
    return chatRequestToAnthropicRequest(input.body);
  }

  protected buildEndpoint(input: ChatCompletionsProxyInput): string {
    return `${input.config.baseUrl}/v1/messages`;
  }

  protected async proxy(input: ChatCompletionsProxyInput, anthropicBody: Record<string, unknown>, endpoint: string): Promise<void> {
    this.callbacks?.onConnectionStatus?.({ state: 'connected' });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), input.config.timeoutMs || 300_000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': input.config.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(anthropicBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;
        try { const e = JSON.parse(errorText); errorMessage = e.error?.message || e.message || errorText; }
        catch { errorMessage = errorText; }
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
              const event = JSON.parse(dataStr) as Record<string, unknown>;
              const type = event.type as string;

              switch (type) {
                case 'content_block_delta': {
                  const delta = event.delta as Record<string, unknown> | undefined;
                  if (delta?.type === 'text_delta' && delta.text) this.callbacks?.onContent?.(delta.text as string);
                  if (delta?.type === 'thinking_delta' && delta.thinking) this.callbacks?.onThinking?.(delta.thinking as string);
                  if (delta?.type === 'input_json_delta' && delta.partial_json) {
                    this.callbacks?.onToolDelta?.(delta.partial_json as string, {
                      id: ((event.content_block as Record<string, unknown>)?.id as string) || '',
                      index: (event.index as number) || 0,
                      name: ((event.content_block as Record<string, unknown>)?.name as string) || '',
                      field: 'arguments',
                    });
                  }
                  break;
                }
                case 'content_block_start': {
                  const cb = event.content_block as Record<string, unknown> | undefined;
                  if (cb?.type === 'tool_use') {
                    this.callbacks?.onToolDelta?.(cb.name as string, {
                      id: cb.id as string, index: (event.index as number) || 0, name: cb.name as string, field: 'name',
                    });
                  }
                  break;
                }
                case 'message_delta': {
                  const usage = event.usage as Record<string, unknown> | undefined;
                  if (usage) this.callbacks?.onUsage?.({ prompt_tokens: (usage.input_tokens as number) || 0, completion_tokens: (usage.output_tokens as number) || 0, total_tokens: ((usage.input_tokens as number) || 0) + ((usage.output_tokens as number) || 0) });
                  break;
                }
                case 'message_stop': this.callbacks?.onDone?.(); return;
                case 'error': {
                  const err = event.error as Record<string, unknown> || event.message as Record<string, unknown>;
                  this.callbacks?.onError?.(new Error((err?.message as string) || 'Anthropic API error'));
                  return;
                }
              }
            } catch { /* skip */ }
          }
        }
        this.callbacks?.onDone?.();
      } finally { reader.releaseLock(); }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') { this.callbacks?.onDone?.(); return; }
      this.callbacks?.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally { clearTimeout(timeoutId); }
  }

  async execute(input: ChatCompletionsProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
