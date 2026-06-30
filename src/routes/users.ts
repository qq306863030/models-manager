import { Router, Request, Response } from 'express';
import db from '../config/database';
import crypto from 'crypto';

const router = Router();

// 密码哈希
function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// ========== 认证中间件 ==========
// 从 X-Username 头获取当前用户名，并验证角色
function getCurrentUsername(req: Request): string | null {
  const username = req.headers['x-username'] as string | undefined;
  return username || null;
}

function getUserRole(username: string): string | null {
  const user = db.prepare('SELECT role FROM users WHERE name = ?').get(username) as { role: string } | undefined;
  return user?.role || null;
}

function isSuperAdmin(username: string): boolean {
  return getUserRole(username) === 'super_admin';
}

function isAdmin(username: string): boolean {
  const role = getUserRole(username);
  return role === 'admin' || role === 'super_admin';
}

// 获取所有用户（不显示 super_admin）
router.get('/', (req: Request, res: Response) => {
  try {
    const username = getCurrentUsername(req);
    if (!username || !isAdmin(username)) {
      res.status(403).json({ success: false, message: '无权限' });
      return;
    }

    // 不显示 super_admin
    const users = db.prepare("SELECT id, name, email, role, created_at FROM users WHERE role != 'super_admin' ORDER BY created_at DESC").all();
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// ========== 用户设置接口（必须在 /:id 之前注册） ==========

// 获取用户设置
router.get('/settings', (_req: Request, res: Response) => {
  try {
    const settings = db.prepare('SELECT max_content_length, max_token FROM user_settings WHERE id = 1').get();
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// 更新用户设置
router.put('/settings', (req: Request, res: Response) => {
  try {
    const { max_content_length, max_token } = req.body;

    if (typeof max_content_length !== 'number' || typeof max_token !== 'number') {
      res.status(400).json({ success: false, message: 'max_content_length 和 max_token 必须是数字' });
      return;
    }

    if (max_content_length < 0 || max_token < 0) {
      res.status(400).json({ success: false, message: 'max_content_length 和 max_token 不能为负数' });
      return;
    }

    const stmt = db.prepare(
      `UPDATE user_settings
       SET max_content_length = ?, max_token = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = 1`
    );
    stmt.run(max_content_length, max_token);

    res.json({ success: true, message: '设置更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: '更新失败', error });
  }
});

// 获取单个用户
router.get('/:id', (req: Request, res: Response) => {
  try {
    const username = getCurrentUsername(req);
    if (!username || !isAdmin(username)) {
      res.status(403).json({ success: false, message: '无权限' });
      return;
    }

    const user = db.prepare("SELECT id, name, email, role, created_at FROM users WHERE id = ? AND role != 'super_admin'").get(req.params.id);
    if (user) {
      res.json({ success: true, data: user });
    } else {
      res.status(404).json({ success: false, message: '用户不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// 创建用户
router.post('/', (req: Request, res: Response) => {
  try {
    const username = getCurrentUsername(req);
    if (!username || !isAdmin(username)) {
      res.status(403).json({ success: false, message: '无权限' });
      return;
    }

    const { name, password, email, role } = req.body;

    if (!name || !password) {
      res.status(400).json({ success: false, message: 'name 和 password 是必填的' });
      return;
    }

    // 验证 role 值
    const validRoles = ['admin', 'user'];
    const userRole = validRoles.includes(role) ? role : 'user';

    // 检查用户名是否已存在
    const existingUser = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
    if (existingUser) {
      res.status(400).json({ success: false, message: '用户名已存在' });
      return;
    }

    const stmt = db.prepare('INSERT INTO users (name, password_hash, email, role) VALUES (?, ?, ?, ?)');
    const result = stmt.run(name, hashPassword(password), email || null, userRole);

    res.status(201).json({ 
      success: true, 
      message: '用户创建成功',
      data: { id: result.lastInsertRowid, name, email, role: userRole }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '创建失败', error });
  }
});

// 更新用户
router.put('/:id', (req: Request, res: Response) => {
  try {
    const username = getCurrentUsername(req);
    if (!username || !isAdmin(username)) {
      res.status(403).json({ success: false, message: '无权限' });
      return;
    }

    const { name, email, role, password } = req.body;
    const userId = req.params.id;

    // 不能更新 super_admin
    const existingUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    if (!existingUser || existingUser.role === 'super_admin') {
      res.status(404).json({ success: false, message: '用户不存在或不能更新' });
      return;
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (name !== undefined) {
      updates.push('name = ?');
      params.push(name);
    }
    if (email !== undefined) {
      updates.push('email = ?');
      params.push(email);
    }
    if (role !== undefined && (role === 'admin' || role === 'user')) {
      updates.push('role = ?');
      params.push(role);
    }
    if (password !== undefined && password !== '') {
      updates.push('password_hash = ?');
      params.push(hashPassword(password));
    }

    if (updates.length === 0) {
      res.status(400).json({ success: false, message: '没有任何更新' });
      return;
    }

    params.push(userId);
    const stmt = db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`);
    const result = stmt.run(...params);

    if (result.changes > 0) {
      res.json({ success: true, message: '用户更新成功' });
    } else {
      res.status(404).json({ success: false, message: '用户更新失败' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '更新失败', error });
  }
});

// 删除用户
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const username = getCurrentUsername(req);
    if (!username || !isAdmin(username)) {
      res.status(403).json({ success: false, message: '无权限' });
      return;
    }

    const userId = req.params.id;

    // 不能删除 super_admin
    const existingUser = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as any;
    if (!existingUser) {
      res.status(404).json({ success: false, message: '用户不存在' });
      return;
    }
    if (existingUser.role === 'super_admin') {
      res.status(400).json({ success: false, message: '不能删除超级管理员' });
      return;
    }

    const stmt = db.prepare('DELETE FROM users WHERE id = ?');
    const result = stmt.run(userId);

    if (result.changes > 0) {
      res.json({ success: true, message: '用户删除成功' });
    } else {
      res.status(404).json({ success: false, message: '用户删除失败' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '删除失败', error });
  }
});

export default router;
