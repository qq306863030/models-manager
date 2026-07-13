/**
 * ChatCompletionsProxy — Chat Completions API 代理
 *
 * 纯代理转发，不涉及 API 类型转换。
 * 将 Chat Completions 格式的请求转发到上游 /chat/completions 端点，
 * 解析 SSE 流并提供标准回调接口。
 *
 * 特性：
 * - SSE 流式解析（文本、思考、工具调用）
 * - 请求超时保护
 * - 工具调用 delta 累积
 * - Token 用量追踪
 */

import BaseProxy from './common/BaseProxy';
import type {
  ChatCompletionsProxyInput,
  ChatCompletionsRequestBody,
  SSECallbacks,
} from './common/types';
import { parseChatCompletionsStream } from './common/sse-utils';

// ========== 默认值 ==========

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_PROVIDER_LABEL = 'ChatCompletions';
const DEFAULT_ENDPOINT = '/chat/completions';
const DEFAULT_MAX_TOKENS = 4096;

export default class ChatCompletionsProxy extends BaseProxy<ChatCompletionsProxyInput, void, ChatCompletionsRequestBody> {
  private callbacks?: SSECallbacks;

  // ========== 回调设置 ==========

  setCallbacks(callbacks: SSECallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  // ========== BaseProxy 生命周期 ==========

  /**
   * 输入校验
   */
  protected validate(input: ChatCompletionsProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('ChatCompletionsProxy: baseUrl is required');
    if (!input.config?.apiKey) throw new Error('ChatCompletionsProxy: apiKey is required');
    if (!input.body?.model) throw new Error('ChatCompletionsProxy: model is required');
  }

  /**
   * 输入优化：确保必要字段、设置默认值
   */
  protected optimizeInput(input: ChatCompletionsProxyInput): ChatCompletionsProxyInput {
    const { config, body } = input;

    const optimizedConfig = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      providerLabel: config.providerLabel || DEFAULT_PROVIDER_LABEL,
      timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? 2,
    };

    const optimizedBody: ChatCompletionsRequestBody = {
      ...body,
      stream: body.stream !== false,
      stream_options: { include_usage: true },
      max_tokens: body.max_tokens || DEFAULT_MAX_TOKENS,
    };

    return { config: optimizedConfig, body: optimizedBody };
  }

  /**
   * 请求格式转换：纯代理模式，直接返回 body
   */
  protected transformRequest(input: ChatCompletionsProxyInput): ChatCompletionsRequestBody {
    return { ...input.body };
  }

  /**
   * 构建端点 URL
   */
  protected buildEndpoint(input: ChatCompletionsProxyInput): string {
    return `${input.config.baseUrl}${DEFAULT_ENDPOINT}`;
  }

  /**
   * 代理转发 + SSE 流解析
   */
  protected async proxy(
    input: ChatCompletionsProxyInput,
    body: ChatCompletionsRequestBody,
    endpoint: string,
  ): Promise<void> {
    this.callbacks?.onConnectionStatus?.({ state: 'connected' });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), input.config.timeoutMs || DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${input.config.apiKey}`,
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
        throw new Error(`${input.config.providerLabel} API error (${response.status}): ${errorMessage}`);
      }

      if (!response.body) {
        throw new Error('No response body received');
      }

      this.callbacks?.onConnectionStatus?.({ state: 'streaming' });

      const reader = response.body.getReader();
      try {
        await parseChatCompletionsStream(reader, this.callbacks || {});
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.callbacks?.onDone?.();
        return;
      }
      this.callbacks?.onError?.(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ========== 便捷方法 ==========

  /**
   * 直接执行代理（带 SSE 回调）
   */
  async execute(input: ChatCompletionsProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    this.callbacks?.onConnectionStatus?.({ state: 'clear' });
    await this.convert(input);
  }

  /**
   * 非流式请求 — 返回完整的 JSON 响应
   */
  async executeNonStreaming(input: ChatCompletionsProxyInput): Promise<Record<string, unknown>> {
    const nonStreamInput = {
      ...input,
      body: { ...input.body, stream: false, stream_options: undefined },
    };

    const optimized = this.optimizeInput(nonStreamInput);
    const endpoint = this.buildEndpoint(optimized);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), optimized.config.timeoutMs || DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${optimized.config.apiKey}`,
        },
        body: JSON.stringify(this.transformRequest(optimized)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error (${response.status}): ${errorText.slice(0, 200)}`);
      }

      return await response.json() as Record<string, unknown>;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
