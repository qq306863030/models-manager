/**
 * ChatCompletionsToResponsesProxy — Chat Completions → Responses 流式转换代理
 *
 * Hub-and-spoke 模式：Chat 是中间格式。本代理接收 Chat 格式输入，调用上游
 * /chat/completions，将返回的 Chat SSE 流通过标准化回调输出。当与
 * `createResponsesSSECallbacks` 配合使用时，将 Chat SSE 转换为 Responses API
 * 命名事件序列。
 *
 * 参考 cc-switch (farion1231/cc-switch) `streaming_codex_chat.rs` 的
 * ChatToResponsesState 状态机设计，确保推理/文本/工具调用的生命周期完整。
 *
 * 特性：
 * - SSE 流式解析（文本、思考、工具调用）
 * - 请求超时保护
 * - 工具调用 delta 累积
 * - Token 用量追踪
 * - 自动重试（故障转移时保留已发出内容）
 */

import BaseProxy from './common/BaseProxy';
import type { ChatCompletionsProxyInput, SSECallbacks } from './common/types';
import { appendPartialAssistantContent, parseChatCompletionsStream, streamWithRetry } from './common/sse-utils';
import { fetchWithRetry } from './common/fetch-with-retry';

// ========== 默认值 ==========

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_PROVIDER_LABEL = 'ChatToResponses';
const DEFAULT_ENDPOINT = '/chat/completions';
const DEFAULT_MAX_TOKENS = 4096;

export default class ChatCompletionsToResponsesProxy extends BaseProxy<ChatCompletionsProxyInput, void, Record<string, unknown>> {
  private callbacks?: SSECallbacks;

  // ========== 回调设置 ==========

  setCallbacks(callbacks: SSECallbacks): this {
    this.callbacks = callbacks;
    return this;
  }

  // ========== BaseProxy 生命周期 ==========

  protected validate(input: ChatCompletionsProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('ChatCompletionsToResponsesProxy: baseUrl required');
    if (!input.config?.apiKey) throw new Error('ChatCompletionsToResponsesProxy: apiKey required');
    if (!input.body?.model) throw new Error('ChatCompletionsToResponsesProxy: model required');
  }

  protected optimizeInput(input: ChatCompletionsProxyInput): ChatCompletionsProxyInput {
    return {
      ...input,
      config: {
        baseUrl: input.config.baseUrl.replace(/\/+$/, ''),
        apiKey: input.config.apiKey,
        providerLabel: input.config.providerLabel || DEFAULT_PROVIDER_LABEL,
        timeoutMs: input.config.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxRetries: input.config.maxRetries ?? 2,
      },
      body: { ...input.body },
    };
  }

  protected transformRequest(input: ChatCompletionsProxyInput): Record<string, unknown> {
    // Chat 是中间格式 — 直接转发给上游 Chat API，确保 stream 和 usage 追踪开启
    return {
      ...input.body,
      stream: input.body.stream !== false,
      stream_options: { include_usage: true },
      max_tokens: input.body.max_tokens || DEFAULT_MAX_TOKENS,
    };
  }

  protected buildEndpoint(_input: ChatCompletionsProxyInput): string {
    return `${_input.config.baseUrl}${DEFAULT_ENDPOINT}`;
  }

  protected async proxy(
    input: ChatCompletionsProxyInput,
    body: Record<string, unknown>,
    endpoint: string,
  ): Promise<void> {
    const providerLabel = input.config.providerLabel || DEFAULT_PROVIDER_LABEL;
    let currentBody: Record<string, unknown> = body;

    await streamWithRetry(
      () => fetchWithRetry(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${input.config.apiKey}`,
        },
        body: JSON.stringify(currentBody),
        timeoutMs: input.config.timeoutMs || DEFAULT_TIMEOUT_MS,
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

  // ========== 便捷方法 ==========

  async execute(input: ChatCompletionsProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    this.callbacks?.onConnectionStatus?.({ state: 'clear' });
    await this.convert(input);
  }
}
