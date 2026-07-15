/**
 * ChatPassthroughProxy — Chat Completions 纯透传代理
 *
 * 与 ChatCompletionsProxy 不同，本代理**不修改任何请求/响应数据**：
 * - 不强制 stream=true
 * - 不注入 stream_options
 * - 不设置默认 max_tokens
 * - 不解析 SSE 内容，不重组 chunk 结构
 *
 * 仅做两件事：
 * 1. 将客户端原始请求体原样转发到上游 /chat/completions
 * 2. 通过 fetchWithRetry 实现自动错误重试（50x / 超时 / 连接错误）
 *
 * 响应直接以原始字节流写回客户端，保持上游返回的 SSE/JSON 格式完全一致。
 */

import { Response } from 'express';
import BaseProxy from './common/BaseProxy';
import type { ChatCompletionsProxyInput, SSECallbacks } from './common/types';
import { fetchWithRetry } from './common/fetch-with-retry';

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_PROVIDER_LABEL = 'ChatPassthrough';
const DEFAULT_ENDPOINT = '/chat/completions';

export default class ChatPassthroughProxy extends BaseProxy<ChatCompletionsProxyInput, void, ChatCompletionsProxyInput['body']> {
  private callbacks?: SSECallbacks;
  private clientRes?: Response;

  setCallbacks(callbacks: SSECallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  setClientResponse(res: Response): this {
    this.clientRes = res;
    return this;
  }

  protected validate(input: ChatCompletionsProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('ChatPassthroughProxy: baseUrl is required');
    if (!input.config?.apiKey) throw new Error('ChatPassthroughProxy: apiKey is required');
    if (!input.body?.model) throw new Error('ChatPassthroughProxy: model is required');
  }

  protected optimizeInput(input: ChatCompletionsProxyInput): ChatCompletionsProxyInput {
    return {
      config: {
        baseUrl: input.config.baseUrl.replace(/\/+$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || DEFAULT_PROVIDER_LABEL,
        timeoutMs: input.config.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxRetries: input.config.maxRetries ?? 2,
      },
      body: input.body,
    };
  }

  protected transformRequest(input: ChatCompletionsProxyInput): ChatCompletionsProxyInput['body'] {
    // 纯透传：不对 body 做任何修改
    return input.body;
  }

  protected buildEndpoint(input: ChatCompletionsProxyInput): string {
    return `${input.config.baseUrl}${DEFAULT_ENDPOINT}`;
  }

  protected async proxy(
    input: ChatCompletionsProxyInput,
    body: ChatCompletionsProxyInput['body'],
    endpoint: string,
  ): Promise<void> {
    const providerLabel = input.config.providerLabel || DEFAULT_PROVIDER_LABEL;

    const upstreamResponse = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${input.config.apiKey}`,
      },
      body: JSON.stringify(body),
      timeoutMs: input.config.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxRetries: input.config.maxRetries ?? 2,
      providerLabel,
    });

    // 将上游响应的 header 复制到客户端响应
    const clientRes = this.clientRes;
    if (!clientRes) throw new Error('ChatPassthroughProxy: client response not set');

    if (!clientRes.headersSent) {
      clientRes.setHeader('Content-Type', upstreamResponse.headers.get('Content-Type') || 'application/json');
      const cacheControl = upstreamResponse.headers.get('Cache-Control');
      if (cacheControl) clientRes.setHeader('Cache-Control', cacheControl);
      const connection = upstreamResponse.headers.get('Connection');
      if (connection) clientRes.setHeader('Connection', connection);
      clientRes.flushHeaders();
    }

    // 将上游响应 body 直接 pipe 到客户端响应
    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (clientRes.writableEnded) break;
          // 直接写入原始字节
          clientRes.write(value);
        }
      } catch (err) {
        // 流中断时尝试发送错误
        if (!clientRes.writableEnded) {
          this.callbacks?.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    // 通知完成
    this.callbacks?.onDone?.();
  }

  /**
   * 执行透传代理
   */
  async execute(input: ChatCompletionsProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    this.callbacks?.onConnectionStatus?.({ state: 'clear' });
    await this.convert(input);
  }
}
