import { Router, Request, Response } from 'express';
import db from '../config/database';

const router = Router();

// 获取设置
router.get('/', (_req: Request, res: Response) => {
  try {
    const settings = db.prepare('SELECT max_content_length, max_token FROM user_settings WHERE id = 1').get();
    res.json({ success: true, data: settings });
  } catch (error) {
    res.status(500).json({ success: false, message: '查询失败', error });
  }
});

// 更新设置
router.put('/', (req: Request, res: Response) => {
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