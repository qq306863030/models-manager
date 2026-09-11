/**
 * Request Logs 路由
 *
 * 提供最近 100 次请求日志的查询与清空接口
 */

import { Router, Request, Response } from 'express';
import { requestTracker } from '../utils/requestTracker';

const router = Router();

// GET /api/request-logs — 获取最近请求记录
router.get('/', (_req: Request, res: Response) => {
  try {
    const logs = requestTracker.getRecentRequests();
    res.json({
      success: true,
      data: logs,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取请求日志失败',
      error: (error as Error).message,
    });
  }
});

// DELETE /api/request-logs — 清空请求记录
router.delete('/', (_req: Request, res: Response) => {
  try {
    requestTracker.clear();
    res.json({
      success: true,
      message: '请求日志已清空',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '清空请求日志失败',
      error: (error as Error).message,
    });
  }
});

export default router;
