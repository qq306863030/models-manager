/**
 * Agent 记忆路由
 *
 * 提供 agent_memory_user、agent_memory_skills 和 agent_memory_docs 三张表的 CRUD 接口，按用户隔离数据。
 * - GET    /api/agent-memory/:type          →  获取当前用户的列表
 * - GET    /api/agent-memory/:type/:id      →  获取单条
 * - POST   /api/agent-memory/:type          →  新增
 * - PUT    /api/agent-memory/:type/:id      →  更新
 * - DELETE /api/agent-memory/:type/:id      →  删除
 *
 * :type 取值为 user、skills 或 docs
 */

import { Router, Request, Response } from 'express';
import {
  getAgentMemoryUserList,
  getAgentMemoryUserById,
  createAgentMemoryUser,
  updateAgentMemoryUser,
  deleteAgentMemoryUser,
  getAgentMemorySkillsList,
  getAgentMemorySkillsById,
  createAgentMemorySkills,
  updateAgentMemorySkills,
  deleteAgentMemorySkills,
  getAgentMemoryDocsList,
  getAgentMemoryDocsById,
  createAgentMemoryDocs,
  updateAgentMemoryDocs,
  deleteAgentMemoryDocs,
} from '../config/database';

const router = Router();

type TableType = 'user' | 'skills' | 'docs';

/** 校验 type 参数 */
function isValidType(type: string): type is TableType {
  return type === 'user' || type === 'skills' || type === 'docs';
}

/** 根据 X-Username 头查找用户 ID */
function getUserIdFromHeader(req: Request): number | null {
  const username = req.headers['x-username'] as string;
  if (!username) return null;

  const db = require('../config/database').default;
  const user = db.prepare('SELECT id FROM users WHERE name = ?').get(username) as { id: number } | undefined;
  return user?.id ?? null;
}

// GET /api/agent-memory/:type — 获取当前用户的列表
router.get('/:type', (req: Request, res: Response) => {
  try {
    const type = req.params.type as string;
    if (!isValidType(type)) {
      res.status(400).json({ success: false, message: 'type 必须是 user、skills 或 docs' });
      return;
    }

    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const list = type === 'user' ? getAgentMemoryUserList(userId)
      : type === 'skills' ? getAgentMemorySkillsList(userId)
      : getAgentMemoryDocsList(userId);
    res.json({ success: true, data: list });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// GET /api/agent-memory/:type/:id — 获取单条
router.get('/:type/:id', (req: Request, res: Response) => {
  try {
    const type = req.params.type as string;
    const id = req.params.id as string;
    if (!isValidType(type)) {
      res.status(400).json({ success: false, message: 'type 必须是 user、skills 或 docs' });
      return;
    }

    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const recordId = parseInt(id, 10);
    if (isNaN(recordId)) {
      res.status(400).json({ success: false, message: 'id 必须是整数' });
      return;
    }

    const record = type === 'user' ? getAgentMemoryUserById(recordId, userId)
      : type === 'skills' ? getAgentMemorySkillsById(recordId, userId)
      : getAgentMemoryDocsById(recordId, userId);
    if (!record) {
      res.status(404).json({ success: false, message: '记录不存在' });
      return;
    }

    res.json({ success: true, data: record });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// POST /api/agent-memory/:type — 新增
router.post('/:type', (req: Request, res: Response) => {
  try {
    const type = req.params.type as string;
    if (!isValidType(type)) {
      res.status(400).json({ success: false, message: 'type 必须是 user、skills 或 docs' });
      return;
    }

    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const { description, content } = req.body;
    const result = type === 'user'
      ? createAgentMemoryUser(description ?? null, content ?? null, userId)
      : type === 'skills'
        ? createAgentMemorySkills(description ?? null, content ?? null, userId)
        : createAgentMemoryDocs(description ?? null, content ?? null, userId);

    res.status(201).json({ success: true, message: '创建成功', data: result });
  } catch (error) {
    res.status(500).json({ success: false, message: '创建失败', error });
  }
});

// PUT /api/agent-memory/:type/:id — 更新
router.put('/:type/:id', (req: Request, res: Response) => {
  try {
    const type = req.params.type as string;
    const id = req.params.id as string;
    if (!isValidType(type)) {
      res.status(400).json({ success: false, message: 'type 必须是 user、skills 或 docs' });
      return;
    }

    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const recordId = parseInt(id, 10);
    if (isNaN(recordId)) {
      res.status(400).json({ success: false, message: 'id 必须是整数' });
      return;
    }

    const { description, content } = req.body;
    const updated = type === 'user'
      ? updateAgentMemoryUser(recordId, description ?? null, content ?? null, userId)
      : type === 'skills'
        ? updateAgentMemorySkills(recordId, description ?? null, content ?? null, userId)
        : updateAgentMemoryDocs(recordId, description ?? null, content ?? null, userId);

    if (!updated) {
      res.status(404).json({ success: false, message: '记录不存在' });
      return;
    }

    res.json({ success: true, message: '更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: '更新失败', error });
  }
});

// DELETE /api/agent-memory/:type/:id — 删除
router.delete('/:type/:id', (req: Request, res: Response) => {
  try {
    const type = req.params.type as string;
    const id = req.params.id as string;
    if (!isValidType(type)) {
      res.status(400).json({ success: false, message: 'type 必须是 user、skills 或 docs' });
      return;
    }

    const userId = getUserIdFromHeader(req);
    if (!userId) {
      res.status(401).json({ success: false, message: '用户未登录或用户不存在' });
      return;
    }

    const recordId = parseInt(id, 10);
    if (isNaN(recordId)) {
      res.status(400).json({ success: false, message: 'id 必须是整数' });
      return;
    }

    const deleted = type === 'user'
      ? deleteAgentMemoryUser(recordId, userId)
      : type === 'skills'
        ? deleteAgentMemorySkills(recordId, userId)
        : deleteAgentMemoryDocs(recordId, userId);

    if (!deleted) {
      res.status(404).json({ success: false, message: '记录不存在' });
      return;
    }

    res.json({ success: true, message: '删除成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: '删除失败', error });
  }
});

export default router;
