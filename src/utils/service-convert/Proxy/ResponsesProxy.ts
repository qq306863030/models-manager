/**
 * ResponsesProxy — Responses API 代理
 *
 * 纯代理转发，不涉及 API 类型转换。
 * 将 Responses 格式的请求转发到上游 /responses 端点，
 * 解析 SSE 流并提供标准回调接口。
 *
 * 特性：
 * - SSE 流式解析（文本 delta、推理 delta、工具调用 delta/done）
 * - response.completed / response.failed 事件处理
 * - 请求超时保护
 * - Token 用量追踪
 */

import BaseProxy from './common/BaseProxy';
import type {
  ResponsesProxyInput,
  ResponsesRequestBody,
  SSECallbacks,
} from './common/types';
import { appendPartialAssistantContent, parseResponsesStream, streamWithRetry } from './common/sse-utils';
import { fetchWithRetry } from './common/fetch-with-retry';

// ========== 默认值 ==========

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_PROVIDER_LABEL = 'Responses';
const DEFAULT_ENDPOINT = '/responses';

export default class ResponsesProxy extends BaseProxy<ResponsesProxyInput, void, ResponsesRequestBody> {
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
  protected validate(input: ResponsesProxyInput): void {
    if (!input.config?.baseUrl) throw new Error('ResponsesProxy: baseUrl is required');
    if (!input.config?.apiKey) throw new Error('ResponsesProxy: apiKey is required');
    if (!input.body?.model) throw new Error('ResponsesProxy: model is required');
    if (!input.body?.input) throw new Error('ResponsesProxy: input is required');
  }

  /**
   * 输入优化：确保必要字段、设置默认值
   */
  protected optimizeInput(input: ResponsesProxyInput): ResponsesProxyInput {
    const { config, body } = input;

    const optimizedConfig = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      providerLabel: config.providerLabel || DEFAULT_PROVIDER_LABEL,
      timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxRetries: config.maxRetries ?? 2,
    };

    const optimizedBody: ResponsesRequestBody = {
      ...body,
      stream: body.stream !== false,
    };

    return { config: optimizedConfig, body: optimizedBody };
  }

  /**
   * 请求格式转换：纯代理模式，直接返回 body
   */
  protected transformRequest(input: ResponsesProxyInput): ResponsesRequestBody {
    return { ...input.body };
  }

  /**
   * 构建端点 URL
   */
  protected buildEndpoint(input: ResponsesProxyInput): string {
    return `${input.config.baseUrl}${DEFAULT_ENDPOINT}`;
  }

  /**
   * 代理转发 + SSE 流解析
   */
  protected async proxy(
    input: ResponsesProxyInput,
    body: ResponsesRequestBody,
    endpoint: string,
  ): Promise<void> {
    const providerLabel = input.config.providerLabel || DEFAULT_PROVIDER_LABEL;

    // 先获取响应，检查是否为 SSE 流
    const initialResponse = await fetchWithRetry(endpoint, {
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

    if (!initialResponse.ok) {
      const errorText = await initialResponse.text();
      let errorMessage: string;
      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorText;
      } catch {
        errorMessage = errorText;
      }
      throw new Error(`${providerLabel} API error (${initialResponse.status}): ${errorMessage}`);
    }

    // 非 SSE 时走 JSON 兜底
    const contentType = initialResponse.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('text/event-stream')) {
      const responseJson = await initialResponse.json() as Record<string, unknown>;
      this.emitJsonResponse(responseJson);
      return;
    }

    // SSE 流 — 使用 streamWithRetry 支持流中断自动重试，并把已输出内容带入下一次请求
    let initialUsed = false;
    let currentBody: ResponsesRequestBody = body;
    await streamWithRetry(
      async () => {
        if (!initialUsed) {
          initialUsed = true;
          return initialResponse;
        }
        // 重试时重新请求
        return fetchWithRetry(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${input.config.apiKey}`,
          },
          body: JSON.stringify(currentBody),
          timeoutMs: input.config.timeoutMs || DEFAULT_TIMEOUT_MS,
          maxRetries: 0, // 由 streamWithRetry 控制重试
          providerLabel,
        });
      },
      (reader, cbs) => parseResponsesStream(reader, cbs),
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

  // ========== 内部辅助 ==========

  private emitJsonResponse(responseJson: Record<string, unknown>): void {
    const outputItems = Array.isArray(responseJson.output)
      ? responseJson.output as Array<Record<string, unknown>>
      : [];

    for (const item of outputItems) {
      const itemType = typeof item.type === 'string' ? item.type : '';

      if (itemType === 'message') {
        const contentParts = Array.isArray(item.content)
          ? item.content as Array<Record<string, unknown>>
          : [];
        for (const part of contentParts) {
          const partType = typeof part.type === 'string' ? part.type : '';
          if ((partType === 'output_text' || partType === 'refusal') && typeof part.text === 'string') {
            this.callbacks?.onContent?.(part.text);
          }
          if ((partType === 'reasoning_text' || partType === 'summary_text') && typeof part.text === 'string') {
            this.callbacks?.onThinking?.(part.text);
          }
        }
      }

      if (itemType === 'function_call') {
        const callId = typeof item.call_id === 'string' ? item.call_id : '';
        const name = typeof item.name === 'string' ? item.name : '';
        const args = typeof item.arguments === 'string' ? item.arguments : '{}';
        this.callbacks?.onToolCall?.({ id: callId, type: 'function', function: { name, arguments: args } });
      }

      if (itemType === 'reasoning') {
        const summaries = Array.isArray(item.summary)
          ? item.summary as Array<Record<string, unknown>>
          : [];
        for (const summary of summaries) {
          if (typeof summary.text === 'string') {
            this.callbacks?.onThinking?.(summary.text);
          }
        }
      }
    }

    const usage = responseJson.usage as Record<string, unknown> | undefined;
    if (usage && this.callbacks?.onUsage) {
      this.callbacks.onUsage({
        prompt_tokens: Number(usage.input_tokens ?? 0),
        completion_tokens: Number(usage.output_tokens ?? 0),
        total_tokens: Number(usage.total_tokens ?? 0),
      });
    }
  }

  // ========== 便捷方法 ==========

  /**
   * 直接执行代理（带 SSE 回调）
   */
  async execute(input: ResponsesProxyInput, callbacks?: SSECallbacks): Promise<void> {
    if (callbacks) this.setCallbacks(callbacks);
    this.callbacks?.onConnectionStatus?.({ state: 'clear' });
    await this.convert(input);
  }

  /**
   * 非流式请求 — 返回完整的 JSON 响应
   */
  async executeNonStreaming(input: ResponsesProxyInput): Promise<Record<string, unknown>> {
    const nonStreamInput = {
      ...input,
      body: { ...input.body, stream: false },
    };

    const optimized = this.optimizeInput(nonStreamInput);
    const endpoint = this.buildEndpoint(optimized);

    const response = await fetchWithRetry(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${optimized.config.apiKey}`,
      },
      body: JSON.stringify(this.transformRequest(optimized)),
      timeoutMs: optimized.config.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxRetries: optimized.config.maxRetries ?? 2,
      providerLabel: optimized.config.providerLabel || DEFAULT_PROVIDER_LABEL,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API error (${response.status}): ${errorText.slice(0, 200)}`);
    }

    return await response.json() as Record<string, unknown>;
  }
}
