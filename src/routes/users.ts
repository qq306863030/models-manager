import { Router, Request, Response } from 'express';
import db from '../config/database';

const router = Router();

// 获取所有用户
router.get('/', (req: Request, res: Response) => {
  try {
    const users = db.prepare('SELECT * FROM users').all();
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// 获取单个用户
router.get('/:id', (req: Request, res: Response) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
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
    const { name, email } = req.body;
    if (!name || !email) {
      res.status(400).json({ success: false, message: 'name 和 email 是必填项' });
      return;
    }
    
    const stmt = db.prepare('INSERT INTO users (name, email) VALUES (?, ?)');
    const result = stmt.run(name, email);
    
    res.status(201).json({ 
      success: true, 
      message: '用户创建成功',
      data: { id: result.lastInsertRowid, name, email }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '创建失败', error });
  }
});

// 更新用户
router.put('/:id', (req: Request, res: Response) => {
  try {
    const { name, email } = req.body;
    const stmt = db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?');
    const result = stmt.run(name, email, req.params.id);
    
    if (result.changes > 0) {
      res.json({ success: true, message: '用户更新成功' });
    } else {
      res.status(404).json({ success: false, message: '用户不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '更新失败', error });
  }
});

// 删除用户
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const stmt = db.prepare('DELETE FROM users WHERE id = ?');
    const result = stmt.run(req.params.id);

    if (result.changes > 0) {
      res.json({ success: true, message: '用户删除成功' });
    } else {
      res.status(404).json({ success: false, message: '用户不存在' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '删除失败', error });
  }
});

// ========== 用户设置接口 ==========

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

    const stmt = db.prepare(`
      UPDATE user_settings
      SET max_content_length = ?, max_token = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `);
    stmt.run(max_content_length, max_token);

    res.json({ success: true, message: '设置更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: '更新失败', error });
  }
});

export default router;