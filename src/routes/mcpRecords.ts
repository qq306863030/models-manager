/**
 * MCP 记录路由
 *
 * 每个用户存储一份 MCP JSON 配置，用于记录 MCP 工具/服务信息。
 * - GET  /api/mcp-records  →  获取当前用户的记录
 * - POST /api/mcp-records  →  保存/更新当前用户的记录
 */

import { Router, Request, Response } from 'express';
import { getMcpRecord, upsertMcpRecord } from '../config/database';

const router = Router();

/** 根据 X-Username 头查找用户 ID */
function getUserIdFromHeader(req: Request): number | null {
  const username = req.headers['x-username'] as string;
  if (!username) return null;

  // 从 users 表查询
  const db = require('../config/database').default;
  const user = db.prepare('SELECT id FROM users WHERE name = ?').get(username) as { id: number } | undefined;
  return user?.id ?? null;
}

// GET /api/mcp-records — 获取当前用户的 MCP 记录
router.get('/', (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const record = getMcpRecord(userId);
    res.json({ success: true, data: record || null });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// POST /api/mcp-records — 保存/更新当前用户的 MCP 记录
router.post('/', (req: Request, res: Response) => {
  try {
    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const { content } = req.body;

    if (typeof content !== 'string') {
      res.status(400).json({ success: false, message: 'content 必须是字符串' });
      return;
    }

    // 验证 JSON 合法性
    try {
      const parsed = JSON.parse(content);
      // 格式化后再存储
      const formatted = JSON.stringify(parsed, null, 2);
      upsertMcpRecord(userId, formatted);
      res.json({ success: true, message: '保存成功', data: { content: formatted } });
    } catch {
      res.status(400).json({ success: false, message: '内容不是有效的 JSON 格式，请检查后再提交' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '保存失败', error });
  }
});

export default router;
