import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';

const router = Router();

// 获取 llm-data.json 数据
router.get('/', (req: Request, res: Response) => {
  try {
    const jsonPath = path.join(__dirname, '../config/llm-data.json');
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: '读取模型配置失败', error });
  }
});

export default router;