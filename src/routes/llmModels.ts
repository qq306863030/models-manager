import { Router, Request, Response } from 'express';
import data from '../config/llm-data.json';

const router = Router();

// 获取 llm-data.json 数据
router.get('/', (req: Request, res: Response) => {
  try {
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: '读取模型配置失败', error });
  }
});

export default router;