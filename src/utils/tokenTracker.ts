/**
 * Token 统计追踪器
 *
 * 使用内存队列批量写入 SQLite，解决高并发下的写入压力。
 * SQLite 在 WAL 模式下可支持较好的并发读，写操作由 better-sqlite3
 * 内置 mutex 序列化，但仍建议通过队列批量聚合减少事务数量。
 *
 * 统计粒度：model_id × date（每天每个模型一行）
 * 字段：in_token, out_token, total_token
 */

import db from '../config/database';

interface TokenRecord {
  modelId: number;
  inToken: number;
  outToken: number;
  totalToken: number;
  count: number;
}

interface QueueItem {
  record: TokenRecord;
  resolve: () => void;
  reject: (err: unknown) => void;
}

// 内存队列
const queue: QueueItem[] = [];
let isProcessing = false;
let flushTimer: NodeJS.Timeout | null = null;

// 最大批量大小
const BATCH_SIZE = 50;
// 最大等待时间（ms）
const FLUSH_INTERVAL = 500;

// 获取今天的日期字符串 YYYY-MM-DD
function getTodayStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 将单条 token 记录加入队列
function enqueue(record: TokenRecord): Promise<void> {
  return new Promise((resolve, reject) => {
    queue.push({ record, resolve, reject })
    scheduleFlush()
  })
}

// 定时或满批 flush
function scheduleFlush(): void {
  if (flushTimer) return

  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_INTERVAL)
}

// 从队列消费并写入数据库
async function flush(): Promise<void> {
  if (isProcessing) return
  isProcessing = true

  let currentQueue: QueueItem[] = []

  try {
    // 取出当前队列（快照）
    currentQueue = queue.splice(0, BATCH_SIZE)

    if (currentQueue.length === 0) {
      isProcessing = false
      return
    }


    // 聚合：modelId × date → 累加 token
    const agg = new Map<string, TokenRecord>()
    for (const { record } of currentQueue) {
      const today = getTodayStr()
      const key = `${record.modelId}__${today}`
      const existing = agg.get(key)
      if (existing) {
        existing.inToken += record.inToken
        existing.outToken += record.outToken
        existing.totalToken += record.totalToken
        existing.count += record.count
      } else {
        agg.set(key, { ...record })
      }
    }

    const today = getTodayStr()

    // 原子 upsert：先尝试 UPDATE（affected rows > 0 则跳过 INSERT）
    const updateStmt = db.prepare(`
      UPDATE token_stats
      SET in_token = in_token + ?, out_token = out_token + ?, total_token = total_token + ?, call_count = call_count + ?
      WHERE model_id = ? AND stat_date = ?
    `)
    const insertStmt = db.prepare(`
      INSERT INTO token_stats (model_id, stat_date, in_token, out_token, total_token, call_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    const upsertMany = db.transaction((records: TokenRecord[]) => {
      for (const r of records) {
        const updateResult = updateStmt.run(r.inToken, r.outToken, r.totalToken, r.count, r.modelId, today)
        if (updateResult.changes === 0) {
          insertStmt.run(r.modelId, today, r.inToken, r.outToken, r.totalToken, r.count)
        }
      }
    })

    upsertMany(Array.from(agg.values()))


    // 唤醒所有等待者
    for (const item of currentQueue) {
      item.resolve()
    }
  } catch (err) {
    // 失败时把所有等待的 reject 掉
    for (const item of currentQueue) {
      item.reject(err)
    }
  } finally {
    isProcessing = false
    // 如果队列还有剩余，继续处理
    if (queue.length > 0) {
      scheduleFlush()
    }
  }
}

/**
 * 追踪一次请求的 token 使用量（异步，不阻塞响应）
 * @param modelId   模型数据库 ID
 * @param usage     OpenAI 格式的 usage 对象: { prompt_tokens, completion_tokens, total_tokens }
 */
export function trackTokenUsage(
  modelId: number | undefined,
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null,
): void {
  if (!usage || !modelId) {
    return;
  }

  const inToken = usage.prompt_tokens ?? 0
  const outToken = usage.completion_tokens ?? 0
  const totalToken = usage.total_tokens ?? inToken + outToken

  // 不追踪无效数据
  if (inToken === 0 && outToken === 0) return

  enqueue({ modelId, inToken, outToken, totalToken, count: 1 }).catch((err) => {
    console.error('[tokenTracker] Failed to track tokens:', err)
  })
}

/**
 * 解析 SSE 流式响应中的最后一帧 usage
 * 在流结束后调用，提取累积的 token 计数
 */
export function extractUsageFromSSE(sseText: string): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null {
  let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null
  const lines = sseText.split(/\r?\n/)
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try {
      const chunk = JSON.parse(data)
      if (chunk.usage) {
        usage = chunk.usage
      }
    } catch {
      // ignore
    }
  }
  return usage
}