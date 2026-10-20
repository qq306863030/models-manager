/**
 * 日志自动清理 — 仅保留最近 N 天（默认 3 天）的日志文件
 *
 * 清理目录：~/.models-manager/logs
 * 清理对象：*.log（含 backend-out-YYYY-MM-DD.log / backend-error-YYYY-MM-DD.log /
 *          YYYY-MM-DD-HH.log 这类按日期命名的文件）
 * 过期判定：优先从文件名解析日期；解析不到时退化为文件 mtime。
 *
 * 可通过环境变量 LOG_RETENTION_DAYS 调整保留天数（最小 1 天）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { formatDate } from './timezone';

/** 统一日志目录（与 debug-logger、app.ts 共用） */
export const LOG_DIR = path.join(os.homedir(), '.models-manager', 'logs');

/** 默认保留天数 */
export const DEFAULT_RETENTION_DAYS = 3;

/** 定时清理间隔：6 小时（日志按天切分，无需更频繁） */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface CleanupResult {
  /** 扫描到的日志文件数 */
  scanned: number;
  /** 实际删除的文件数 */
  deleted: number;
  /** 释放的磁盘空间（字节） */
  freedBytes: number;
  /** 生效的保留天数 */
  retentionDays: number;
  /** 删除失败的文件（多为被占用） */
  failed: string[];
}

/** 读取保留天数配置 */
function getRetentionDays(): number {
  const raw = Number(process.env.LOG_RETENTION_DAYS);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return DEFAULT_RETENTION_DAYS;
}

/** 生成需要保留的日期集合（今天往前共 retentionDays 天） */
function buildKeepDates(retentionDays: number): Set<string> {
  const keep = new Set<string>();
  const now = new Date();
  for (let i = 0; i < retentionDays; i++) {
    keep.add(formatDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keep;
}

/** 从文件名中提取 YYYY-MM-DD；没有则返回 null */
function extractDateFromName(file: string): string | null {
  const m = file.match(/(\d{4}-\d{2}-\d{2})/);
  if (!m) return null;
  // 校验是否为合法日期（排除 2026-99-99 这类误匹配）
  const d = new Date(`${m[1]}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : m[1];
}

/**
 * 清理过期日志
 * @param retentionDays 保留天数，默认取 LOG_RETENTION_DAYS 或 3
 * @param dir 日志目录，默认 LOG_DIR
 */
export async function cleanupOldLogs(
  retentionDays: number = getRetentionDays(),
  dir: string = LOG_DIR,
): Promise<CleanupResult> {
  const result: CleanupResult = { scanned: 0, deleted: 0, freedBytes: 0, retentionDays, failed: [] };

  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    // 目录不存在，无需清理
    return result;
  }

  const keepDates = buildKeepDates(retentionDays);

  for (const file of files) {
    if (!file.toLowerCase().endsWith('.log')) continue;

    const filePath = path.join(dir, file);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    result.scanned++;

    // 优先用文件名里的日期，其次用 mtime
    const dateStr = extractDateFromName(file) ?? formatDate(stat.mtime);
    if (keepDates.has(dateStr)) continue;

    try {
      await fs.promises.unlink(filePath);
      result.deleted++;
      result.freedBytes += stat.size;
    } catch {
      // Windows 下文件被占用会 EPERM/EBUSY，下个周期再试
      result.failed.push(file);
    }
  }

  return result;
}

let scheduled = false;

/**
 * 启动日志清理调度：启动即清理一次，之后每 6 小时清理一次
 * 重复调用无副作用
 */
export function initLogCleanup(): void {
  if (scheduled) return;
  scheduled = true;

  const run = () => {
    cleanupOldLogs()
      .then((r) => {
        if (r.deleted > 0 || r.failed.length > 0) {
          const mb = (r.freedBytes / 1024 / 1024).toFixed(2);
          console.log(
            `[log-cleaner] 清理完成：保留 ${r.retentionDays} 天，删除 ${r.deleted}/${r.scanned} 个文件，释放 ${mb} MB` +
              (r.failed.length ? `，${r.failed.length} 个文件被占用跳过` : ''),
          );
        }
      })
      .catch(() => {
        // 清理失败不影响主流程
      });
  };

  run();
  setInterval(run, CLEANUP_INTERVAL_MS).unref();
}
