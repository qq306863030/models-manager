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
import type { ChatCompletionsProxyInput, SSECallbacks, TokenUsage } from './common/types';
import { fetchWithRetry } from './common/fetch-with-retry';
import { trackTokenUsage } from '../../tokenTracker';
import { createRequestLog, appendToLog, flushLog, clearLog, type RequestLogBuffer } from '../../debug-logger';

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
        modelId: input.config.modelId,
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
    const logEndpoint = `${providerLabel} ${endpoint}`;
    // 创建内存缓冲区，成功时丢弃，失败时写入文件
    const logBuffer = createRequestLog(logEndpoint);

    // 记录请求体到内存
    appendToLog(logBuffer, 'request', {
      endpoint,
      model: body.model,
      bodyKeys: Object.keys(body),
      body: JSON.stringify(body).slice(0, 5000),
    });

    // fetchWithRetry 默认重试 3 次，间隔 500ms + 响应内容校验
    let upstreamResponse: globalThis.Response;
    try {
      upstreamResponse = await fetchWithRetry(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${input.config.apiKey}`,
        },
        body: JSON.stringify(body),
        timeoutMs: input.config.timeoutMs || DEFAULT_TIMEOUT_MS,
        maxRetries: input.config.maxRetries ?? 3,
        retryIntervalMs: 500,
        providerLabel,
        // 校验响应内容：检查是否有 choices（VS Code 会因空响应报错）
        validateResponse: async (fetchResponse: globalThis.Response) => {
          const contentType = (fetchResponse.headers.get('Content-Type') || '').toLowerCase();

          // 非 SSE（JSON 响应）→ clone 后解析 body 检查
          if (!contentType.includes('text/event-stream')) {
            const cloned = fetchResponse.clone();
            const bodyText = await cloned.text();
            appendToLog(logBuffer, 'upstream', bodyText, 10000);
            let json: Record<string, unknown>;
            try {
              json = JSON.parse(bodyText);
            } catch {
              appendToLog(logBuffer, 'error', { error: 'Non-SSE response invalid JSON', body: bodyText.slice(0, 500) });
              throw new Error(`Response contained no choices (invalid JSON)`);
            }
            const choices = json.choices;
            if (!choices || (Array.isArray(choices) && choices.length === 0)) {
              appendToLog(logBuffer, 'validate', { status: fetchResponse.status, contentType, body: bodyText.slice(0, 2000) });
              throw new Error(`Response contained no choices`);
            }
            return;
          }

          // SSE 响应 → clone 后读取整个响应写入内存
          if (!fetchResponse.body) throw new Error('Response contained no choices (no body)');
          const cloned = fetchResponse.clone();
          const fullReader = cloned.body!.getReader();
          let fullText = '';
          while (true) {
            const { done, value } = await fullReader.read();
            if (done) break;
            fullText += new TextDecoder().decode(value, { stream: true });
          }
          appendToLog(logBuffer, 'upstream', fullText, 10000);

          // 从完整响应中检查是否有 choices
          const allLines = fullText.split('\n');
          let hasChoices = false;
          for (const line of allLines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:') && !trimmed.includes('[DONE]')) {
              const jsonStr = trimmed.slice(5).trim();
              if (!jsonStr) continue;
              try {
                const chunk = JSON.parse(jsonStr) as Record<string, unknown>;
                const choices = chunk.choices;
                if (Array.isArray(choices) && choices.length > 0) {
                  hasChoices = true;
                  break;
                }
              } catch { /* 跳过 */ }
            }
          }
          if (!hasChoices) {
            appendToLog(logBuffer, 'validate', { status: fetchResponse.status, contentType, result: 'no choices' });
            throw new Error('Response contained no choices');
          }
        },
      });
    } catch (err) {
      // fetchWithRetry 失败（含校验失败）→ 落盘记录
      appendToLog(logBuffer, 'error', { error: (err as Error).message, phase: 'fetch/validate' });
      flushLog(logBuffer);
      throw err;
    }

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

    // 将上游响应 body 直接 pipe 到客户端响应，同时异步解析 SSE 中的 usage
    if (upstreamResponse.body) {
      const reader = upstreamResponse.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let capturedUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;
      let chunkIndex = 0;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (clientRes.writableEnded) break;

          chunkIndex++;

          // 直接写入原始字节（透传，不修改）
          clientRes.write(value);

          // 异步解析：解码文本并检查 SSE 中的 usage（不影响透传性能）
          sseBuffer += decoder.decode(value, { stream: true });
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:') || trimmed === 'data: [DONE]') continue;
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;
            try {
              const chunk = JSON.parse(jsonStr) as Record<string, unknown>;
              if (chunk.usage) {
                capturedUsage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
              }
            } catch {
              // 解析失败跳过（不影响透传）
            }
          }
        }
      } catch (err) {
        // 流中断 → 记录日志到内存并落盘，调用 onError
        appendToLog(logBuffer, 'downstream', sseBuffer, 10000);
        appendToLog(logBuffer, 'error', { chunksStreamed: chunkIndex, error: (err as Error).message });
        flushLog(logBuffer);
        if (!clientRes.writableEnded) {
          this.callbacks?.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
        return;
      }

      // 流正常结束 → 记录下游完整响应到内存（不清除，以备后续异常时落盘）
      appendToLog(logBuffer, 'downstream', sseBuffer, 10000);

      // 异步追踪 token（使用捕获的 usage 或估计值）
      if (capturedUsage) {
        trackTokenUsage(input.config.modelId, capturedUsage);
      } else {
        // 上游未返回 usage 时用估计值
        trackTokenUsage(input.config.modelId, {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        });
      }
    }

    // 通知完成（写 [DONE] + res.end()），清除内存日志
    clearLog(logBuffer);
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
