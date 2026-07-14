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
import { parseChatCompletionsStream, streamWithRetry } from './common/sse-utils';
import { fetchWithRetry } from './common/fetch-with-retry';

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
    const providerLabel = input.config.providerLabel || DEFAULT_PROVIDER_LABEL;
    const msgCount = Array.isArray(body.messages) ? body.messages.length : 0;
    const lastMsgRole = Array.isArray(body.messages) && body.messages.length > 0
      ? body.messages[body.messages.length - 1]?.role : '?';

    // ---- 输入日志 ----
    const bodyKeys = Object.keys(body).join(', ');
    const totalMsgChars = Array.isArray(body.messages)
      ? body.messages.reduce((acc: number, m: any) => acc + JSON.stringify(m).length, 0)
      : 0;
    const msgPreviews = Array.isArray(body.messages)
      ? body.messages.map((m: any, i: number) => {
          const role = m.role || '?';
          const content = m.content;
          const preview = typeof content === 'string'
            ? content.slice(0, 60)
            : Array.isArray(content)
              ? `[${content.length} parts]`
              : JSON.stringify(content).slice(0, 60);
          return `  [${i}] role=${role} content_len=${typeof content === 'string' ? content.length : '?'} preview="${preview}"`;
        }).join('\n')
      : '  (no messages)';

    console.log(`\n========== [ChatCompletionsProxy] REQUEST ==========`);
    console.log(`  endpoint=${endpoint}`);
    console.log(`  model=${body.model}`);
    console.log(`  stream=${body.stream}`);
    console.log(`  messages=${msgCount}, total_chars=${totalMsgChars}`);
    console.log(`  max_tokens=${body.max_tokens}, temperature=${body.temperature}, top_p=${body.top_p}`);
    console.log(`  tools=${body.tools ? `yes (${(body.tools as any[]).length} tools)` : 'no'}`);
    console.log(`  tool_choice=${body.tool_choice || 'auto'}`);
    console.log(`  body_keys=[${bodyKeys}]`);
    if (body.system) console.log(`  system="${String(body.system).slice(0, 120)}"`);
    console.log(`Messages:`);
    console.log(msgPreviews);
    console.log(`====================================================`);

    // ---- 输出统计 ----
    let totalContentLen = 0;
    let totalThinkingLen = 0;
    let toolCallCount = 0;
    let lastUsage: any = null;

    // 包装回调添加日志
    const loggingCallbacks: SSECallbacks = {
      ...(this.callbacks || {}),
      onContent: (delta: string) => {
        totalContentLen += delta.length;
        const isFirst = totalContentLen === delta.length;
        console.log(`[ChatCompletionsProxy] <<< SSE onContent  delta_len=${delta.length} total=${totalContentLen}${isFirst ? ' [FIRST]' : ''} preview=${delta.slice(0, 80)}`);
        this.callbacks?.onContent?.(delta);
      },
      onThinking: (delta: string) => {
        totalThinkingLen += delta.length;
        console.log(`[ChatCompletionsProxy] <<< SSE onThinking delta_len=${delta.length} total=${totalThinkingLen}`);
        this.callbacks?.onThinking?.(delta);
      },
      onToolDelta: (delta: string, info) => {
        console.log(`[ChatCompletionsProxy] <<< SSE onToolDelta field=${info.field} index=${info.index} name=${info.name} delta_len=${delta.length}`);
        this.callbacks?.onToolDelta?.(delta, info);
      },
      onToolCall: (toolCall) => {
        toolCallCount++;
        console.log(`[ChatCompletionsProxy] <<< SSE onToolCall  #${toolCallCount} id=${toolCall.id} name=${toolCall.function.name}`);
        this.callbacks?.onToolCall?.(toolCall);
      },
      onUsage: (usage) => {
        lastUsage = usage;
        console.log(`[ChatCompletionsProxy] <<< SSE onUsage  prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`);
        this.callbacks?.onUsage?.(usage);
      },
      onDone: () => {
        console.log(`\n========== [ChatCompletionsProxy] RESPONSE SUMMARY ==========`);
        console.log(`  model=${body.model}`);
        console.log(`  content_chars=${totalContentLen}, thinking_chars=${totalThinkingLen}`);
        console.log(`  tool_calls=${toolCallCount}`);
        if (lastUsage) {
          console.log(`  usage: prompt_tokens=${lastUsage.prompt_tokens}, completion_tokens=${lastUsage.completion_tokens}, total_tokens=${lastUsage.total_tokens}`);
        } else {
          console.log(`  usage: (none)`);
        }
        console.log(`===========================================================`);
        this.callbacks?.onDone?.();
      },
      onError: (error: Error) => {
        console.error(`[ChatCompletionsProxy] <<< SSE onError  ${error.message}`, JSON.stringify(error, Object.getOwnPropertyNames(error)));
        this.callbacks?.onError?.(error);
      },
      onConnectionStatus: (status) => {
        console.log(`[ChatCompletionsProxy] <<< onConnectionStatus  state=${status.state} attempt=${status.attempt}/${status.maxAttempts} msg=${status.message || ''}`);
        this.callbacks?.onConnectionStatus?.(status);
      },
    };

    await streamWithRetry(
      () => {
        console.log(`[ChatCompletionsProxy] >>> fetch start  endpoint=${endpoint}`);
        return fetchWithRetry(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${input.config.apiKey}`,
          },
          body: JSON.stringify(body),
          timeoutMs: input.config.timeoutMs || DEFAULT_TIMEOUT_MS,
          maxRetries: input.config.maxRetries ?? 2,
          providerLabel,
        }).then((response) => {
          console.log(`[ChatCompletionsProxy] <<< fetch done  status=${response.status} ${response.statusText} content-type=${response.headers.get('content-type')}`);
          return response;
        });
      },
      (reader, cbs) => parseChatCompletionsStream(reader, cbs),
      loggingCallbacks,
      { maxRetries: input.config.maxRetries ?? 2, providerLabel },
    );

    console.log(`[ChatCompletionsProxy] <<< proxy done`);
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
