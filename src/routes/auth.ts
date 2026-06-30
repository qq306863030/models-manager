/**
 * 认证路由 - 用户登录/注册
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import db from '../config/database';

const router = Router();

// 默认管理员账户
const DEFAULT_ADMIN = { username: 'admin', password: 'admin' };

// ========== 初始化默认管理员 ==========
function initDefaultAdmin() {
  try {
    // 先检查表是否存在并包含所需字段
    const tableInfo = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    const hasPasswordHash = tableInfo.some(col => col.name === 'password_hash');

    if (!hasPasswordHash) {
      console.log('[auth] users table missing password_hash column, skipping admin init');
      return;
    }

    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number };
    if (userCount.count === 0) {
      const passwordHash = crypto.createHash('sha256').update(DEFAULT_ADMIN.password).digest('hex');
      db.prepare('INSERT INTO users (name, password_hash, is_admin) VALUES (?, ?, 1)').run(DEFAULT_ADMIN.username, passwordHash);
      console.log('[auth] Default admin user created: admin/admin');
    }
  } catch (error) {
    console.error('[auth] Failed to init default admin:', error);
  }
}

// 应用启动时初始化（延迟执行，确保数据库已初始化）
setTimeout(initDefaultAdmin, 100);

// ========== 验证码相关 ==========

// 生成4位随机验证码
function generateCaptchaCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// 获取验证码图片
router.get('/captcha', (req: Request, res: Response) => {
  try {
    const code = generateCaptchaCode();
    const expireAt = Date.now() + 5 * 60 * 1000; // 5分钟后过期

    // 保存验证码到数据库
    db.prepare('DELETE FROM captchas WHERE expire_at < ?').run(Date.now()); // 清理过期验证码
    db.prepare('INSERT INTO captchas (code, expire_at) VALUES (?, ?)').run(code, expireAt);

    // 生成简单的 SVG 验证码图片
    const svg = generateCaptchaSVG(code);
    
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(svg);
  } catch (error) {
    console.error('[auth] captcha error:', error);
    res.status(500).json({ success: false, message: '验证码生成失败' });
  }
});

// 生成简单的 SVG 验证码
function generateCaptchaSVG(code: string): string {
  const width = 120;
  const height = 40;
  const chars = code.split('');
  
  // 随机颜色
  const bgColor = `hsl(${Math.random() * 60 + 200}, 20%, 95%)`; // 淡蓝色背景
  const textColor = `hsl(${Math.random() * 60 + 200}, 80%, 30%)`;
  
  let paths = '';
  // 添加一些干扰线
  for (let i = 0; i < 3; i++) {
    const x1 = Math.random() * width;
    const y1 = Math.random() * height;
    const x2 = Math.random() * width;
    const y2 = Math.random() * height;
    paths += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${textColor}" stroke-width="1" opacity="0.3"/>`;
  }
  
  // 添加干扰点
  for (let i = 0; i < 20; i++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    paths += `<circle cx="${x}" cy="${y}" r="1" fill="${textColor}" opacity="0.3"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="${width}" height="${height}" fill="${bgColor}"/>
    ${paths}
    <text x="20" y="28" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="${textColor}" transform="rotate(${-5 + Math.random() * 10}, 20, 28)">${chars[0]}</text>
    <text x="45" y="30" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="${textColor}" transform="rotate(${-5 + Math.random() * 10}, 45, 30)">${chars[1]}</text>
    <text x="70" y="28" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="${textColor}" transform="rotate(${-5 + Math.random() * 10}, 70, 28)">${chars[2]}</text>
    <text x="95" y="30" font-family="Arial, sans-serif" font-size="24" font-weight="bold" fill="${textColor}" transform="rotate(${-5 + Math.random() * 10}, 95, 30)">${chars[3]}</text>
  </svg>`;
}

// ========== 用户认证 ==========

// 注册用户
router.post('/register', (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({ success: false, message: '用户名和密码是必填项' });
      return;
    }

    if (username.length < 3 || username.length > 20) {
      res.status(400).json({ success: false, message: '用户名长度应为 3-20 个字符' });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ success: false, message: '密码长度至少为 6 个字符' });
      return;
    }

    // 检查用户是否已存在
    const existingUser = db.prepare('SELECT id FROM users WHERE name = ?').get(username);
    if (existingUser) {
      res.status(400).json({ success: false, message: '用户名已存在' });
      return;
    }

    // 哈希密码
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    // 创建用户
    const result = db.prepare('INSERT INTO users (name, password_hash) VALUES (?, ?)').run(username, passwordHash);

    // 生成 token
    const token = generateToken();
    const tokenExpireAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7天后过期

    res.status(201).json({
      success: true,
      message: '注册成功',
      data: {
        userId: result.lastInsertRowid,
        username,
        token,
        tokenExpireAt,
      },
    });
  } catch (error) {
    console.error('[auth] register error:', error);
    res.status(500).json({ success: false, message: '注册失败' });
  }
});

// 登录
router.post('/login', (req: Request, res: Response) => {
  try {
    const { username, password, captcha } = req.body;

    if (!username || !password || !captcha) {
      res.status(400).json({ success: false, message: '用户名、密码和验证码是必填项' });
      return;
    }

    // 验证验证码
    const captchaRecord = db.prepare('SELECT * FROM captchas ORDER BY id DESC LIMIT 1').get() as { code: string; expire_at: number } | undefined;
    if (!captchaRecord) {
      res.status(400).json({ success: false, message: '请先获取验证码' });
      return;
    }

    if (Date.now() > captchaRecord.expire_at) {
      res.status(400).json({ success: false, message: '验证码已过期，请重新获取' });
      return;
    }

    if (captchaRecord.code.toLowerCase() !== captcha.toLowerCase()) {
      res.status(400).json({ success: false, message: '验证码错误' });
      return;
    }

    // 删除已使用的验证码
    db.prepare('DELETE FROM captchas WHERE expire_at < ?').run(Date.now());

    // 验证用户
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    const user = db.prepare('SELECT id, name, role FROM users WHERE name = ? AND password_hash = ?').get(username, passwordHash) as { id: number; name: string; role: string } | undefined;

    if (!user) {
      res.status(401).json({ success: false, message: '用户名或密码错误' });
      return;
    }

    // 生成新的 token
    const token = generateToken();
    const tokenExpireAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7天后过期

    res.json({
      success: true,
      message: '登录成功',
      data: {
        userId: user.id,
        username: user.name,
        role: user.role,
        token,
        tokenExpireAt,
      },
    });
  } catch (error) {
    console.error('[auth] login error:', error);
    res.status(500).json({ success: false, message: '登录失败' });
  }
});

// 生成随机 token
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// 验证 token
router.get('/verify', (req: Request, res: Response) => {
  try {
    // 从 Authorization header 获取 token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: '未提供认证 token' });
      return;
    }

    const token = authHeader.substring(7);
    
    // 简单的 token 验证：检查 token 长度
    if (token.length !== 64) {
      res.status(401).json({ success: false, message: '无效的 token' });
      return;
    }

    res.json({ success: true, message: 'Token 有效' });
  } catch (error) {
    console.error('[auth] verify error:', error);
    res.status(500).json({ success: false, message: '验证失败' });
  }
});

// 获取当前用户信息
router.get('/me', (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: '未登录' });
      return;
    }

    // 简单的验证：token 存在即有效
    // 在实际应用中，应该将 token 存储在数据库中进行更严格的验证
    res.json({ success: true, message: '用户已登录' });
  } catch (error) {
    console.error('[auth] me error:', error);
    res.status(500).json({ success: false, message: '获取用户信息失败' });
  }
});

// ========== 修改密码 ==========
router.post('/change-password', (req: Request, res: Response) => {
  try {
    const { username, oldPassword, newPassword } = req.body;

    if (!username || !oldPassword || !newPassword) {
      res.status(400).json({ success: false, message: '用户名、旧密码和新密码是必填项' });
      return;
    }

    if (newPassword.length < 6) {
      res.status(400).json({ success: false, message: '新密码长度至少为 6 个字符' });
      return;
    }

    // 验证旧密码
    const oldPasswordHash = crypto.createHash('sha256').update(oldPassword).digest('hex');
    const user = db.prepare('SELECT id, name, role FROM users WHERE name = ? AND password_hash = ?').get(username, oldPasswordHash) as { id: number; name: string } | undefined;

    if (!user) {
      res.status(401).json({ success: false, message: '旧密码错误' });
      return;
    }

    // 更新新密码
    const newPasswordHash = crypto.createHash('sha256').update(newPassword).digest('hex');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newPasswordHash, user.id);

    res.json({ success: true, message: '密码修改成功' });
  } catch (error) {
    console.error('[auth] change-password error:', error);
    res.status(500).json({ success: false, message: '修改密码失败' });
  }
});

// ========== 获取用户列表 ==========
router.get('/users', (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: '未登录' });
      return;
    }

    const users = db.prepare('SELECT id, name, is_admin, created_at FROM users ORDER BY id ASC').all();
    res.json({ success: true, data: users });
  } catch (error) {
    console.error('[auth] get users error:', error);
    res.status(500).json({ success: false, message: '获取用户列表失败' });
  }
});

// ========== 删除用户 ==========
router.delete('/users/:id', (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ success: false, message: '未登录' });
      return;
    }

    const userId = parseInt(req.params.id as string);
    if (isNaN(userId)) {
      res.status(400).json({ success: false, message: '无效的用户ID' });
      return;
    }

    // 不允许删除自己
    const currentUser = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!currentUser) {
      res.status(404).json({ success: false, message: '用户不存在' });
      return;
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    res.json({ success: true, message: '用户删除成功' });
  } catch (error) {
    console.error('[auth] delete user error:', error);
    res.status(500).json({ success: false, message: '删除用户失败' });
  }
});

export default router;
