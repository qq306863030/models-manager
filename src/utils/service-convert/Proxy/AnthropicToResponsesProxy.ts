/**
 * AnthropicToResponsesProxy — Anthropic → Responses 转换代理
 *
 * Hub-and-spoke 模式：所有格式转换经过 OpenAI Chat 作为中间格式。
 * Anthropic 请求先转为 Chat 格式，调用 /chat/completions，
 * 响应通过标准化回调输出。
 */

import BaseProxy from './common/BaseProxy';
import type { AnthropicProxyInput, SSECallbacks } from './common/types';
import { anthropicRequestToChatRequest } from './common/convert-utils';
import { parseChatCompletionsStream } from './common/sse-utils';

function logImageBlocks(prefix: string, messages: Array<Record<string, unknown>> | undefined): void {
  if (!Array.isArray(messages)) { console.log(`[AnthropicToResponses] ${prefix} messages is not an array:`, typeof messages); return; }
  let imgCount = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'image') {
          imgCount++;
          const src = block.source as Record<string, unknown> | undefined;
          const srcType = src?.type as string || 'unknown';
          const mediaType = src?.media_type as string || 'unknown';
          const dataLen = typeof src?.data === 'string' ? (src.data as string).length : 0;
          const url = src?.url as string || '';
          console.log(`[AnthropicToResponses] ${prefix} IMAGE[${imgCount}] type=${srcType} media_type=${mediaType} data_len=${dataLen} url_preview=${url.slice(0, 80)}`);
        } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const c of block.content as Array<Record<string, unknown>>) {
            if (c.type === 'image') {
              imgCount++;
              const src = c.source as Record<string, unknown> | undefined;
              console.log(`[AnthropicToResponses] ${prefix} IMAGE_IN_TOOL_RESULT[${imgCount}] type=${src?.type} media_type=${src?.media_type} data_len=${typeof src?.data === 'string' ? (src.data as string).length : 0}`);
            }
          }
        }
      }
    }
  }
  console.log(`[AnthropicToResponses] ${prefix} total image blocks found: ${imgCount}`);
}

function logChatImages(prefix: string, body: Record<string, unknown>): void {
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(messages)) { console.log(`[AnthropicToResponses] ${prefix} messages is not an array`); return; }
  let imgCount = 0;
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === 'string') continue;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'image_url') {
          imgCount++;
          const url = ((part.image_url as Record<string, unknown> | undefined)?.url as string) || '';
          console.log(`[AnthropicToResponses] ${prefix} IMAGE_URL[${imgCount}] url_preview=${url.slice(0, 100)}`);
        }
      }
    }
  }
  console.log(`[AnthropicToResponses] ${prefix} total image_url parts: ${imgCount}`);
}

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
    console.log(`[AnthropicToResponses] ===== INCOMING REQUEST =====`);
    console.log(`[AnthropicToResponses] model=${input.body?.model} total_messages=${Array.isArray(input.body?.messages) ? input.body.messages.length : 0}`);
    logImageBlocks('Anthropic input', input.body?.messages as Array<Record<string, unknown>> | undefined);
    return {
      ...input,
      config: {
        baseUrl: input.config.baseUrl.replace(/\/+$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || 'AnthropicToResponses',
        timeoutMs: input.config.timeoutMs || 300_000,
        maxRetries: input.config.maxRetries ?? 2,
      },
      body: { ...input.body },
    };
  }

  protected transformRequest(input: AnthropicProxyInput): Record<string, unknown> {
    // Anthropic → Chat（中间格式）
    const chatBody = anthropicRequestToChatRequest(input.body, true);
    chatBody.stream = chatBody.stream !== false;
    chatBody.stream_options = { include_usage: true };
    console.log(`[AnthropicToResponses] ===== AFTER CONVERSION TO CHAT =====`);
    console.log(`[AnthropicToResponses] model=${chatBody.model} total_messages=${Array.isArray(chatBody.messages) ? chatBody.messages.length : 0} stream=${chatBody.stream}`);
    logChatImages('Chat body', chatBody);
    return chatBody;
  }

  protected buildEndpoint(_input: AnthropicProxyInput): string {
    return `${_input.config.baseUrl}/chat/completions`;
  }

  protected async proxy(input: AnthropicProxyInput, body: Record<string, unknown>, endpoint: string): Promise<void> {
    console.log(`[AnthropicToResponses] ===== SENDING TO /chat/completions =====`);
    console.log(`[AnthropicToResponses] endpoint=${endpoint}`);
    if (!Array.isArray(body.messages)) {
      console.log(`[AnthropicToResponses] ERROR: body.messages is not an array!`);
    } else {
      const lastMsg = body.messages[body.messages.length - 1];
      console.log(`[AnthropicToResponses] messages_count=${body.messages.length} last_msg_role=${lastMsg?.role}`);
    }

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
      console.log(`[AnthropicToResponses] response_status=${response.status} ${response.statusText}`);
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`[AnthropicToResponses] ERROR_BODY=${errorText.slice(0, 500)}`);
        throw new Error(`API error (${response.status}): ${errorText.slice(0, 200)}`);
      }
      if (!response.body) throw new Error('No response body received');
      console.log(`[AnthropicToResponses] ===== STREAM STARTED =====`);
      this.callbacks?.onConnectionStatus?.({ state: 'streaming' });
      const reader = response.body.getReader();
      try {
        await parseChatCompletionsStream(reader, {
          onContent: (d) => {
            console.log(`[AnthropicToResponses] SSE onContent delta_len=${d.length} preview=${d.slice(0, 100)}`);
            this.callbacks?.onContent?.(d);
          },
          onThinking: (d) => {
            console.log(`[AnthropicToResponses] SSE onThinking delta_len=${d.length}`);
            this.callbacks?.onThinking?.(d);
          },
          onToolCall: (t) => {
            console.log(`[AnthropicToResponses] SSE onToolCall id=${t.id} name=${t.function.name}`);
            this.callbacks?.onToolCall?.(t);
          },
          onUsage: (u) => {
            console.log(`[AnthropicToResponses] SSE onUsage prompt_tokens=${u.prompt_tokens} completion_tokens=${u.completion_tokens}`);
            this.callbacks?.onUsage?.(u);
          },
          onDone: () => {
            console.log(`[AnthropicToResponses] ===== STREAM DONE =====`);
            this.callbacks?.onDone?.();
          },
          onError: (e) => {
            console.log(`[AnthropicToResponses] SSE onError: ${e.message}`);
            this.callbacks?.onError?.(e);
          },
        });
      } finally { reader.releaseLock(); }
    } catch (error) {
      console.log(`[AnthropicToResponses] ERROR: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.name === 'AbortError') { console.log(`[AnthropicToResponses] ABORTED`); this.callbacks?.onDone?.(); return; }
      this.callbacks?.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally { clearTimeout(timeoutId); }
  }

  async execute(input: AnthropicProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    await this.convert(input);
  }
}
