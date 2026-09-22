/**
 * AI 聊天会话持久化路由（跨端同步）
 *
 * 会话原先只存在浏览器 localStorage，导致 PC 端与移动端各自看到各自的数据；
 * 这里按用户维度落库，使同一账号在不同设备上看到同一批会话。
 *
 * - GET    /api/chat/sessions        →  获取当前用户全部会话（按 updated_at 倒序）
 * - GET    /api/chat/sessions/:id    →  获取单个会话
 * - PUT    /api/chat/sessions        →  批量 upsert（首次迁移与跨端合并）
 * - PUT    /api/chat/sessions/:id    →  单条 upsert（前端增量同步主通道）
 * - DELETE /api/chat/sessions/:id    →  删除单个会话
 * - DELETE /api/chat/sessions        →  清空当前用户全部会话
 *
 * 用户身份沿用项目统一约定：X-Username 请求头。
 */

import { Router, Request, Response } from 'express';
import db, {
  listChatSessions,
  getChatSession,
  upsertChatSession,
  deleteChatSession,
  deleteAllChatSessions,
  type ChatSessionRecord,
} from '../config/database';

const router = Router();

/** 单个会话消息体上限（字符数），与 express.json 50mb 限制保持安全距离 */
const MAX_MESSAGES_CHARS = 20 * 1024 * 1024;
/** 单次批量同步的会话数量上限 */
const MAX_BULK_SESSIONS = 500;

/** 根据 X-Username 头查找用户 ID */
function getUserIdFromHeader(req: Request): number | null {
  const username = req.headers['x-username'] as string;
  if (!username) return null;

  const user = db.prepare('SELECT id FROM users WHERE name = ?').get(username) as { id: number } | undefined;
  return user?.id ?? null;
}

function toFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 校验并归一化前端提交的会话数据 */
function normalizeSession(raw: any, forcedId?: string): { value: ChatSessionRecord } | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: '会话数据格式不正确' };
  }

  const id = (forcedId || (typeof raw.id === 'string' ? raw.id : '')).trim();
  if (!id) return { error: '会话 id 不能为空' };
  if (id.length > 128) return { error: '会话 id 过长' };

  const messages = Array.isArray(raw.messages) ? raw.messages : [];
  if (JSON.stringify(messages).length > MAX_MESSAGES_CHARS) {
    return { error: '会话消息体过大' };
  }

  const now = Date.now();
  const updatedAt = toFiniteNumber(raw.updatedAt, now);
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';

  return {
    value: {
      id,
      title: title ? title.slice(0, 200) : '新对话',
      modelName: typeof raw.modelName === 'string' ? raw.modelName : '',
      createdAt: toFiniteNumber(raw.createdAt, updatedAt),
      updatedAt,
      messages,
    },
  };
}

// GET /api/chat/sessions — 获取当前用户全部会话
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }
    res.json({ success: true, data: listChatSessions(userId) });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询会话失败', error });
  }
});

// GET /api/chat/sessions/:id — 获取单个会话
router.get('/:id', (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const session = getChatSession(req.params.id as string, userId);
    if (!session) {
      res.status(404).json({ success: false, message: '会话不存在' });
      return;
    }
    res.json({ success: true, data: session });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询会话失败', error });
  }
});

// PUT /api/chat/sessions — 批量 upsert
router.put('/', (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const rawList = req.body?.sessions;
    if (!Array.isArray(rawList)) {
      res.status(400).json({ success: false, message: 'sessions 必须是数组' });
      return;
    }
    if (rawList.length > MAX_BULK_SESSIONS) {
      res.status(400).json({ success: false, message: `单次最多同步 ${MAX_BULK_SESSIONS} 个会话` });
      return;
    }

    const skipped: string[] = [];
    let saved = 0;
    for (const raw of rawList) {
      const result = normalizeSession(raw);
      if ('error' in result) {
        skipped.push(result.error);
        continue;
      }
      upsertChatSession(userId, result.value);
      saved += 1;
    }

    res.json({ success: true, data: { saved, skipped } });
  } catch (error) {
    res.status(500).json({ success: false, message: '同步会话失败', error });
  }
});

// PUT /api/chat/sessions/:id — 单条 upsert
router.put('/:id', (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const result = normalizeSession(req.body, req.params.id as string);
    if ('error' in result) {
      res.status(400).json({ success: false, message: result.error });
      return;
    }

    upsertChatSession(userId, result.value);
    res.json({ success: true, data: { id: result.value.id, updatedAt: result.value.updatedAt } });
  } catch (error) {
    res.status(500).json({ success: false, message: '保存会话失败', error });
  }
});

// DELETE /api/chat/sessions/:id — 删除单个会话
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const deleted = deleteChatSession(req.params.id as string, userId);
    if (!deleted) {
      res.status(404).json({ success: false, message: '会话不存在' });
      return;
    }
    res.json({ success: true, message: '会话已删除' });
  } catch (error) {
    res.status(500).json({ success: false, message: '删除会话失败', error });
  }
});

// DELETE /api/chat/sessions — 清空当前用户全部会话
router.delete('/', (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const removed = deleteAllChatSessions(userId);
    res.json({ success: true, data: { removed } });
  } catch (error) {
    res.status(500).json({ success: false, message: '清空会话失败', error });
  }
});

export default router;
