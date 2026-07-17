/**
 * Debug 日志工具 — 请求/响应数据先写入内存，仅在请求报错时落盘
 *
 * 日志文件命名：logs/YYYY-MM-DD-HH.log
 * 避免正常请求产生大量磁盘 I/O，只有异常请求才记录完整输入输出。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/** 统一日志目录 */
function getLogDir(): string {
  return path.join(os.homedir(), '.models-manager', 'logs');
}
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

// ========== 请求级别日志缓冲区 ==========

export interface RequestLogBuffer {
  /** 请求端点标识 */
  endpoint: string;
  /** 日志条目列表 */
  entries: Array<{ time: string; direction: string; data: string }>;
  /** 是否已写入磁盘 */
  flushed: boolean;
}

/**
 * 创建请求级别的日志缓冲区
 * 数据先写入内存，请求成功时丢弃，请求失败时落盘
 */
export function createRequestLog(endpoint: string): RequestLogBuffer {
  return { endpoint, entries: [], flushed: false };
}

/**
 * 向缓冲区追加一条日志
 */
export function appendToLog(
  buffer: RequestLogBuffer,
  direction: string,
  data: unknown,
  maxLen: number = 10000,
): void {
  const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const truncated = dataStr.length > maxLen
    ? dataStr.slice(0, maxLen) + `\n... [truncated ${dataStr.length - maxLen} chars]`
    : dataStr;
  buffer.entries.push({ time: getLogTime(), direction: direction.toUpperCase(), data: truncated });
}

/**
 * 将缓冲区内容写入磁盘（日志文件），并标记为已刷写
 * 仅在请求报错时调用
 */
export function flushLog(buffer: RequestLogBuffer): void {
  if (buffer.flushed || buffer.entries.length === 0) return;
  buffer.flushed = true;

  try {
    const logDir = getLogDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const filename = `${getLogTimestamp()}.log`;
    const filepath = path.join(logDir, filename);

    const lines = buffer.entries.map(e =>
      `[${e.time}] [${e.direction}] ${buffer.endpoint}\n${e.data}`
    ).join('\n\n');

    fs.appendFile(filepath, lines + '\n\n', (err) => {
      if (err) console.error(`[debug-logger] write failed:`, err.message);
    });
  } catch (err) {
    // 日志本身失败不影响主流程
  }
}

/**
 * 丢弃缓冲区内容（请求成功时调用）
 */
export function clearLog(buffer: RequestLogBuffer): void {
  buffer.entries = [];
  buffer.flushed = false;
}

// ========== 兼容旧接口：直接写磁盘（保留备用） ==========

export function writeDebugLog(
  endpoint: string,
  direction: 'upstream' | 'downstream' | 'error' | 'validate' | 'request' | 'response',
  data: unknown,
): void {
  try {
    const logDir = getLogDir();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const filename = `${getLogTimestamp()}.log`;
    const filepath = path.join(logDir, filename);

    const time = getLogTime();
    const dataStr = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    const line = `[${time}] [${direction.toUpperCase()}] ${endpoint}\n${dataStr}\n\n`;

    fs.appendFile(filepath, line, (err) => {
      if (err) {
        console.error(`[debug-logger] write failed:`, err.message);
      }
    });
  } catch (err) {
    // 日志本身失败不影响主流程
  }
}

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
