/**
 * opencode.ai 适配工具
 *
 * opencode 官方要求（其 API 才能正常工作）：
 * 1. 发送典型的编程 Agent 流量
 * 2. 使用自身专属的 user agent 标识（例如 my-coding-agent/1.0），
 *    而不是通用的 SDK 或 HTTP 库名称（如 node-fetch、openai-node、axios 等）
 * 3. 为每段对话在 x-opencode-session 请求头中发送稳定的会话 ID，
 *    以便其优化路由和提示词缓存
 *
 * 实现策略：
 * - user agent 标识固定写死为专属标识 `models-manager-agent/1.0`（不使用随机字符）
 * - 基于稳定的会话种子（客户端会话头 / requestId）生成稳定的会话 ID，
 *   相同种子永远映射到同一会话，避免每请求随机导致缓存失效
 */

import { randomBytes } from 'crypto';

/** 是否命中 opencode.ai 域名（含子域） */
export function isOpencodeUrl(url: string): boolean {
  if (!url) return false;
  return /^https?:\/\/([a-z0-9-]+\.)*opencode\.ai([:/]|$)/i.test(url);
}

// ========== User-Agent ==========

/** 自身专属的固定 User-Agent 标识（写死，不使用随机字符） */
const OPENCODE_USER_AGENT = 'models-manager-agent/1.0';

/**
 * 获取发送到 opencode.ai 的 User-Agent。
 * 固定标识，所有请求保持一致。
 */
export function getOpencodeUserAgent(): string {
  return OPENCODE_USER_AGENT;
}

/** 默认 UA（非 opencode 域使用，避免泄漏自身身份到其它上游） */
export function getDefaultUserAgent(): string {
  return `models-manager/${process.env.npm_package_version || '1.0.0'}`;
}

// ========== 会话 ID ==========

const SESSION_CACHE_MAX = 1000;

/** 会话缓存：稳定种子 → 稳定会话 UUID */
const sessionCache = new Map<string, string>();

/** 生成 UUID（兼容 Node 14+ 无 crypto.randomUUID 的场景） */
function newUuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 从会话种子解析出稳定的 opencode 会话 ID。
 *
 * @param seed 稳定的会话种子（例如客户端传入的会话头、conversation id）。
 *             传 null/undefined 时返回每次随机的临时会话（仅用于无法识别会话的场景）。
 * @returns 稳定的会话 UUID
 */
export function resolveOpencodeSessionId(seed?: string | null): string {
  if (!seed) return newUuid();

  const cached = sessionCache.get(seed);
  if (cached) return cached;

  const id = newUuid();
  // LRU 简单淘汰
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    const firstKey = sessionCache.keys().next().value;
    if (firstKey !== undefined) sessionCache.delete(firstKey);
  }
  sessionCache.set(seed, id);
  return id;
}

// ========== 会话种子提取（用于 Express 请求） ==========

/**
 * 从入站请求头中提取"会话种子"。
 *
 * 优先级：x-opencode-session > x-conversation-id > x-session-id > x-thread-id > client-request-id/x-request-id。
 * 前 4 项是显式会话标识；后 2 项是请求级标识 —— 当客户端每个请求都发新的
 * client-request-id 时，只能保证"重试/同请求内"稳定，无法保证跨请求稳定，
 * 此时上游仍会收到合法的会话 ID（格式满足要求，但命中缓存的收益有限）。
 */
export function extractConversationSeed(headers: Record<string, unknown>): string | undefined {
  const get = (k: string): string | undefined => {
    const v = headers[k];
    if (Array.isArray(v)) return v[0];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
  };

  return (
    get('x-opencode-session') ||
    get('x-conversation-id') ||
    get('x-session-id') ||
    get('x-thread-id') ||
    get('client-request-id') ||
    get('x-request-id') ||
    undefined
  );
}

/**
 * 构建发送到 opencode.ai 上游所需的额外请求头。
 *
 * @param seed 会话种子（可选，传稳定种子可获得稳定会话 ID）
 */
export function buildOpencodeHeaders(seed?: string | null): Record<string, string> {
  return {
    'User-Agent': getOpencodeUserAgent(),
    'x-opencode-session': resolveOpencodeSessionId(seed),
  };
}
