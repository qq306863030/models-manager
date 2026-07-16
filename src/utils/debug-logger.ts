/**
 * Debug 日志工具 — 将上游/下游响应数据写入时间戳日志文件
 *
 * 日志文件命名：logs/YYYY-MM-DD-HH.log
 * 用于调试"no choices"等偶发问题，避免 console.log 被轮转日志淹没。
 */

import * as fs from 'fs';
import * as path from 'path';

// 动态导入 dayjs（未在 package.json 中声明，作为 transitive dep 存在）
let dayjs: any = null;
try {
  dayjs = require('dayjs');
} catch {
  // dayjs 不可用时降级到 Date
}

/** 获取当前小时级时间戳（用于日志文件名） */
function getLogTimestamp(): string {
  if (dayjs) {
    return dayjs().format('YYYY-MM-DD-HH');
  }
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  return `${y}-${m}-${d}-${h}`;
}

/** 获取可读时间戳（用于日志内容行） */
function getLogTime(): string {
  if (dayjs) {
    return dayjs().format('YYYY-MM-DD HH:mm:ss.SSS');
  }
  return new Date().toISOString();
}

/** 日志级别 */
type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

/**
 * 写入调试日志
 *
 * @param endpoint 请求端点标识（用于区分不同上游）
 * @param direction 'upstream' | 'downstream'
 * @param data      日志数据（对象会被 JSON 序列化）
 */
export function writeDebugLog(
  endpoint: string,
  direction: 'upstream' | 'downstream' | 'error' | 'validate' | 'request' | 'response',
  data: unknown,
): void {
  try {
    const logDir = path.resolve(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const filename = `${getLogTimestamp()}.log`;
    const filepath = path.join(logDir, filename);

    const time = getLogTime();
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const line = `[${time}] [${direction.toUpperCase()}] ${endpoint}\n${dataStr}\n\n`;

    // 追加写入，不阻塞主流程
    fs.appendFile(filepath, line, (err) => {
      if (err) {
        console.error(`[debug-logger] write failed:`, err.message);
      }
    });
  } catch (err) {
    // 日志本身失败不影响主流程
  }
}

/**
 * 写入 SSE 调试日志（限制最大长度，避免日志文件过大）
 */
export function writeSSEDebugLog(
  endpoint: string,
  direction: 'upstream' | 'downstream' | 'error' | 'validate' | 'request' | 'response',
  text: string,
  maxLen: number = 2000,
): void {
  const truncated = text.length > maxLen
    ? text.slice(0, maxLen) + `\n... [truncated ${text.length - maxLen} chars]`
    : text;
  writeDebugLog(endpoint, direction, truncated);
}
