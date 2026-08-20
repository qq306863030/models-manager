import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { getUserFilesList, getUserFileById, createUserFile, deleteUserFile } from '../config/database';

const router = Router();

// 文件上传目录: ~/.models-manager/user-files/{userId}/
function getUserFileDir(userId: number): string {
  const dir = path.join(os.homedir(), '.models-manager', 'user-files', String(userId));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// multer 配置：使用内存存储 + 自定义文件名
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// 从请求头获取用户 ID
function getUserIdFromHeader(req: Request): number | null {
  const username = req.headers['x-username'] as string;
  if (!username) return null;
  const db = require('../config/database').default;
  const user = db.prepare('SELECT id FROM users WHERE name = ?').get(username) as { id: number } | undefined;
  return user?.id ?? null;
}

// 获取文件列表
router.get('/', (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    res.status(401).json({ success: false, message: '未授权' });
    return;
  }
  try {
    const files = getUserFilesList(userId);
    res.json({ success: true, data: files });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || '获取文件列表失败' });
  }
});

// 上传文件
router.post('/upload', upload.single('file'), (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    res.status(401).json({ success: false, message: '未授权' });
    return;
  }
  if (!req.file) {
    res.status(400).json({ success: false, message: '未选择文件' });
    return;
  }
  try {
    // multer 的 content-disposition 解析器可能把 UTF-8 字节当 latin1 处理
    // 需要检测并修复：将 latin1 编码的字符串转回 UTF-8 原文
    let originalName = req.file.originalname;
    try {
      const fixed = Buffer.from(originalName, 'latin1').toString('utf8');
      // 如果转换后没有替换字符(U+FFFD)，说明修复成功
      if (!fixed.includes('\uFFFD')) {
        originalName = fixed;
      }
    } catch (e) {
      // 转换失败则使用原始值
    }
    const ext = path.extname(originalName);
    const storedName = crypto.randomUUID() + ext;
    const userDir = getUserFileDir(userId);
    const filePath = path.join(userDir, storedName);

    // 写入磁盘
    fs.writeFileSync(filePath, req.file.buffer);

    // 写入数据库
    const result = createUserFile(originalName, storedName, req.file.mimetype || null, req.file.size, userId);

    res.json({
      success: true,
      message: '上传成功',
      data: {
        id: result.id,
        original_name: originalName,
        mime_type: req.file.mimetype || null,
        file_size: req.file.size,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || '上传失败' });
  }
});

// 下载文件
router.get('/:id/download', (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    res.status(401).json({ success: false, message: '未授权' });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, message: '无效的文件 ID' });
    return;
  }
  try {
    const file = getUserFileById(id, userId);
    if (!file) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    const userDir = getUserFileDir(userId);
    const filePath = path.join(userDir, file.stored_name);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ success: false, message: '文件已丢失' });
      return;
    }
    // 设置下载文件名（URL 编码处理中文）
    const encodedName = encodeURIComponent(file.original_name);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedName}`);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', file.file_size);
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || '下载失败' });
  }
});

// 删除文件
router.delete('/:id', (req: Request, res: Response) => {
  const userId = getUserIdFromHeader(req);
  if (!userId) {
    res.status(401).json({ success: false, message: '未授权' });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, message: '无效的文件 ID' });
    return;
  }
  try {
    const result = deleteUserFile(id, userId);
    if (!result) {
      res.status(404).json({ success: false, message: '文件不存在' });
      return;
    }
    // 删除磁盘文件
    const userDir = getUserFileDir(userId);
    const filePath = path.join(userDir, result.stored_name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.json({ success: true, message: '删除成功' });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || '删除失败' });
  }
});

export default router;
