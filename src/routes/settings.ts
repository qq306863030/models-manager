import { Router, Request, Response } from 'express';
import db, { saveUserApiKey, getUserApiKey, deleteUserApiKey, getUserSettings, saveUserSettings } from '../config/database';

const router = Router();

// 获取设置
router.get('/', (_req: Request, res: Response) => {
  try {
    const settings = getUserSettings();
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// 更新设置
router.put('/', (req: Request, res: Response) => {
  try {
    const { max_content_length, max_token, lock_duration, proxy_url } = req.body;

    if (typeof max_content_length !== 'number' || typeof max_token !== 'number' || typeof lock_duration !== 'number') {
      res.status(400).json({ success: false, message: 'max_content_length、max_token 和 lock_duration 必须是数字' });
      return;
    }

    if (max_content_length < 0 || max_token < 0 || lock_duration < 0) {
      res.status(400).json({ success: false, message: 'max_content_length、max_token 和 lock_duration 不能为负数' });
      return;
    }

    saveUserSettings(max_content_length, max_token, lock_duration, proxy_url);

    res.json({ success: true, message: '设置更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: '更新失败', error });
  }
});

// ========== API Key 管理 ==========

// 获取当前用户的 API Key
router.get('/api-key', (req: Request, res: Response) => {
  try {
    const username = req.headers['x-username'] as string;
    if (!username) {
      res.status(401).json({ success: false, message: '缺少用户名' });
      return;
    }
    const apiKey = getUserApiKey(username);
    res.json({ success: true, api_key: apiKey || null });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// 保存 API Key
router.post('/api-key', (req: Request, res: Response) => {
  try {
    const username = req.headers['x-username'] as string;
    if (!username) {
      res.status(401).json({ success: false, message: '缺少用户名' });
      return;
    }

    const { api_key } = req.body;
    if (typeof api_key !== 'string' || !api_key.trim()) {
      res.status(400).json({ success: false, message: 'api_key 不能为空' });
      return;
    }

    saveUserApiKey(username, api_key.trim());
    res.json({ success: true, message: 'API Key 保存成功' });
  } catch (error) {
    res.status(500).json({ success: false, message: '保存失败', error });
  }
});

// 清除 API Key
router.delete('/api-key', (req: Request, res: Response) => {
  try {
    const username = req.headers['x-username'] as string;
    if (!username) {
      res.status(401).json({ success: false, message: '缺少用户名' });
      return;
    }

    deleteUserApiKey(username);
    res.json({ success: true, message: 'API Key 已清除' });
  } catch (error) {
    res.status(500).json({ success: false, message: '清除失败', error });
  }
});

export default router;