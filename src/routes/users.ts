import { Router, Request, Response } from 'express';
import db from '../config/database';
import crypto from 'crypto';

const router = Router();

// 韬浠芥枃瀛楀瘑
function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// 楠岃瘉韬浠芥槸鍚︽牴鎹璦min
function isSuperAdmin(username: string): boolean {
  const user = db.prepare('SELECT role FROM users WHERE name = ?').get(username) as { role: string } | undefined;
  return user?.role === 'super_admin';
}

function isAdmin(username: string): boolean {
  const user = db.prepare('SELECT role FROM users WHERE name = ?').get(username) as { role: string } | undefined;
  return user?.role === 'admin' || user?.role === 'super_admin';
}

// 鑾峰彇鎵€鏈夌敤鎴凤紙涓嶆樉绀烘満绠″楂樼瓑绠¤呴 Gris锛
router.get('/', (req: Request, res: Response) => {
  try {
    const username = (req as any).proxyUsername;
    
    // 鍙� admin 鍜� super_admin 鏌ヨ劇涓嶺lient
    if (!isAdmin(username)) {
      res.status(403).json({ success: false, message: '鏃犵粌璁や箟' });
      return;
    }
    
    // 涓嶆樉绀烘満绠″楂樼瓑绠¤呴
    const users = db.prepare("SELECT id, name, email, role, created_at FROM users WHERE role != 'super_admin' ORDER BY created_at DESC").all();
    res.json({ success: true, data: users });
  } catch (error) {
    res.status(500).json({ success: false, message: '鏌ヨ剧韬辩姸', error });
  }
});

// 鑾峰彇鍗曚釜鐢ㄦ埛
router.get('/:id', (req: Request, res: Response) => {
  try {
    const username = (req as any).proxyUsername;
    
    if (!isAdmin(username)) {
      res.status(403).json({ success: false, message: '鏃犵粌璁や箟' });
      return;
    }
    
    const user = db.prepare("SELECT id, name, email, role, created_at FROM users WHERE id = ? AND role != 'super_admin'").get(req.params.id);
    if (user) {
      res.json({ success: true, data: user });
    } else {
      res.status(404).json({ success: false, message: '鐢ㄦ埛涓嶅瓨鍦' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '鏌ヨ剧韬辩姸', error });
  }
});

// 鍒涘缓鐢ㄦ埛
router.post('/', (req: Request, res: Response) => {
  try {
    const username = (req as any).proxyUsername;
    
    if (!isAdmin(username)) {
      res.status(403).json({ success: false, message: '鏃犵粌璁や箟' });
      return;
    }
    
    const { name, password, email, role } = req.body;
    
    if (!name || !password) {
      res.status(400).json({ success: false, message: 'name 鍜岃矿褰曟槸蹇呴』鐨' });
      return;
    }
    
    // 楠岃瘉 role 鍊
    const validRoles = ['admin', 'user'];
    const userRole = validRoles.includes(role) ? role : 'user';
    
    // 妯℃佽〃涓嶆樉绀烘満绠″楂樼瓑绠
    const existingUser = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
    if (existingUser) {
      res.status(400).json({ success: false, message: '鐢ㄦ埛鍚嶅凡瀛樺湪' });
      return;
    }
    
    const stmt = db.prepare('INSERT INTO users (name, password_hash, email, role) VALUES (?, ?, ?, ?)');
    const result = stmt.run(name, hashPassword(password), email || null, userRole);
    
    res.status(201).json({ 
      success: true, 
      message: '鐢ㄦ埛鍒涘肩櫧鍔' ,
      data: { id: result.lastInsertRowid, name, email, role: userRole }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: '鍒涘肩櫧鍔' , error });
  }
});

// 鏇存柊鐢ㄦ埛
router.put('/:id', (req: Request, res: Response) => {
  try {
    const username = (req as any).proxyUsername;
    
    if (!isAdmin(username)) {
      res.status(403).json({ success: false, message: '鏃犵粌璁や箟' });
      return;
    }
    
    const { name, email, role, password } = req.body;
    const userId = req.params.id;
    
    // 涓嶈兘鏇存柊 super_admin
    const existingUser = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
    if (!existingUser || existingUser.role === 'super_admin') {
      res.status(404).json({ success: false, message: '鐢ㄦ埛涓嶅瓨鍦戠殑鎴栬呴 Gris涓嶈兘鏇存柊' });
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
      res.status(400).json({ success: false, message: '娌℃湁浠讳綍鏇存柊' });
      return;
    }
    
    params.push(userId);
    const stmt = db.prepare(UPDATE users SET  WHERE id = ?);
    const result = stmt.run(...params);
    
    if (result.changes > 0) {
      res.json({ success: true, message: '鐢ㄦ埛鏇存柊鎴愬姛' });
    } else {
      res.status(404).json({ success: false, message: '鐢ㄦ埛鏇存柊澶辫触' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '鏇存柊韬辩姸', error });
  }
});

// 鍒犻櫎鐢ㄦ埛
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const username = (req as any).proxyUsername;
    
    if (!isAdmin(username)) {
      res.status(403).json({ success: false, message: '鏃犵粌璁や箟' });
      return;
    }
    
    const userId = req.params.id;
    
    // 涓嶈兘鍒犻櫎 super_admin
    const existingUser = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as any;
    if (!existingUser) {
      res.status(404).json({ success: false, message: '鐢ㄦ埛涓嶅瓨鍦' });
      return;
    }
    if (existingUser.role === 'super_admin') {
      res.status(400).json({ success: false, message: '涓嶈兘鍒犻櫎楂樼瓑绠″℃閮ㄩ Gris' });
      return;
    }
    
    const stmt = db.prepare('DELETE FROM users WHERE id = ?');
    const result = stmt.run(userId);

    if (result.changes > 0) {
      res.json({ success: true, message: '鐢ㄦ埛鍒犻櫎鎴愬姛' });
    } else {
      res.status(404).json({ success: false, message: '鐢ㄦ埛鍒犻櫎澶辫触' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: '鍒犻櫎韬辩姸', error });
  }
});

// ========== 鐢ㄦ埛璁剧疆鎺ュ彛 ==========

// 鑾峰彇鐢ㄦ埛璁剧疆
router.get('/settings', (_req: Request, res: Response) => {
  try {
    const settings = db.prepare('SELECT max_content_length, max_token FROM user_settings WHERE id = 1').get();
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: '鏌ヨ剧韬辩姸', error });
  }
});

// 鏇存柊鐢ㄦ埛璁剧疆
router.put('/settings', (req: Request, res: Response) => {
  try {
    const { max_content_length, max_token } = req.body;

    if (typeof max_content_length !== 'number' || typeof max_token !== 'number') {
      res.status(400).json({ success: false, message: 'max_content_length 鍜 max_token 蹇呴』鏄鏁板瓧' });
      return;
    }

    if (max_content_length < 0 || max_token < 0) {
      res.status(400).json({ success: false, message: 'max_content_length 鍜 max_token 涓嶈兘涓鸿礋鏁' });
      return;
    }

    const stmt = db.prepare(\
      UPDATE user_settings
      SET max_content_length = ?, max_token = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    \);
    stmt.run(max_content_length, max_token);

    res.json({ success: true, message: '璁剧疆鏇存柊鎴愬姛' });
  } catch (error) {
    res.status(500).json({ success: false, message: '鏇存柊韬辩姸', error });
  }
});

export default router;
