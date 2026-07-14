/**
 * fetchWithRetry — 带自动重试的 fetch 封装
 *
 * 遇到 50x 上游错误或请求超时（Abort/Timeout/ECONNRESET 等）时，
 * 自动每隔 intervalMs 重试，最多 maxRetries 次。
 * 4xx 等客户端错误不会重试。
 */

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INTERVAL_MS = 500;

/** 判断错误是否可重试（50x 上游错误、请求超时、或上游网关故障） */
export function isRetryableError(err: unknown): boolean {
  const status = (err as any).status || (err as any).statusCode || 0;
  const errName = (err as Error)?.name || '';
  const errMsg = (err as Error)?.message || '';

  // 50x 上游错误
  if (status >= 500 && status < 600) return true;

  // 请求超时（AbortError / TimeoutError / ECONNRESET / ETIMEDOUT）
  if (/TimeoutError|AbortError|ETIMEDOUT|ECONNRESET|ECONNREFUSED|SocketError/i.test(errName)) return true;
  if (/timeout|terminated|aborted|timed out|other side closed/i.test(errMsg)) return true;

  // 上游网关故障：某些 API 网关在上游服务不可用时返回400而非5xx
  if (/Upstream request failed|Internal server error|gateway.*error|upstream.*error|provider.*error/i.test(errMsg)) return true;

  return false;
}

export interface FetchWithRetryOptions extends RequestInit {
  /** 请求超时毫秒数（每个 attempt 独立计时） */
  timeoutMs?: number;
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
  /** 重试间隔毫秒数（默认 500） */
  retryIntervalMs?: number;
  /** 日志标签 */
  providerLabel?: string;
}

/**
 * 带自动重试的 fetch
 *
 * 每个 attempt 独立创建 AbortController 并设置超时。
 * 遇到可重试错误时等待 retryIntervalMs 后重试。
 */
export async function fetchWithRetry(
  endpoint: string,
  options: FetchWithRetryOptions,
): Promise<Response> {
  const {
    timeoutMs = 300_000,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryIntervalMs = DEFAULT_INTERVAL_MS,
    providerLabel = 'Upstream',
    ...fetchOptions
  } = options;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        ...fetchOptions,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.error?.message || errorJson.message || errorText;
        } catch {
          errorMessage = errorText;
        }
        const err = new Error(`${providerLabel} API error (${response.status}): ${errorMessage}`);
        (err as any).status = response.status;
        throw err;
      }

      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;

      if (attempt < maxRetries && isRetryableError(err)) {
        const status = (err as any).status || (err as any).statusCode || '-';
        const errMsg = (err as Error).message;
        console.warn(`[fetchWithRetry] ${providerLabel} attempt ${attempt + 1}/${maxRetries + 1} failed [${status}]: ${errMsg}, retrying in ${retryIntervalMs}ms...`);
        await new Promise((r) => setTimeout(r, retryIntervalMs));
        continue;
      }

      throw err;
    }
  }

  throw lastErr;
}
