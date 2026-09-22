import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import McpBridgeManager, { getMcpUploadsDir, getMcpOutputsDir } from '../utils/mcpBridgeManager';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

/**
 * 获取所有外部挂载的 MCP 工具（如 doc-processor）
 */
router.get('/tools', async (_req: Request, res: Response) => {
  try {
    const bridge = McpBridgeManager.getInstance();
    const tools = await bridge.getAllTools();
    res.json({ success: true, data: tools });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || '获取 MCP 工具失败' });
  }
});

/**
 * 执行特定的 MCP 工具
 */
router.post('/call', async (req: Request, res: Response) => {
  try {
    const { toolName, arguments: args } = req.body;
    if (!toolName) {
      res.status(400).json({ success: false, message: '缺少 toolName' });
      return;
    }

    const bridge = McpBridgeManager.getInstance();
    const result = await bridge.callTool(toolName, args || {});
    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || '执行 MCP 工具失败' });
  }
});

/**
 * 下载 MCP 工具生成或暂存的文件
 * GET /api/mcp/download?file=xxx.docx
 */
router.get('/download', (req: Request, res: Response) => {
  const fileName = req.query.file as string;
  if (!fileName) {
    res.status(400).send('缺少 file 参数');
    return;
  }

  const safeBaseName = path.basename(fileName);
  const outputsDir = getMcpOutputsDir();
  let filePath = path.join(outputsDir, safeBaseName);

  if (!fs.existsSync(filePath)) {
    const uploadsDir = getMcpUploadsDir();
    filePath = path.join(uploadsDir, safeBaseName);
  }

  if (!fs.existsSync(filePath)) {
    res.status(404).send('文件不存在或已过期');
    return;
  }

  const safeAsciiName = safeBaseName.replace(/[^\x20-\x7E]/g, '_');
  const encodedName = encodeURIComponent(safeBaseName);
  res.setHeader('Content-Disposition', `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${encodedName}`);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

/**
 * 解析上传的文档为 Markdown 文本，并保存至 ~/.models-manager/mcp-files/uploads
 */
router.post('/parse-document', upload.single('file'), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ success: false, message: '未提供文件' });
    return;
  }

  try {
    let originalName = req.file.originalname;
    try {
      const fixed = Buffer.from(originalName, 'latin1').toString('utf8');
      if (!fixed.includes('\uFFFD')) {
        originalName = fixed;
      }
    } catch {}

    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);
    const uploadsDir = getMcpUploadsDir();

    // 存储在 ~/.models-manager/mcp-files/uploads 下，持久保留给多轮对话工具作为输入源
    const safeStoredName = `${baseName}_${Date.now()}${ext}`;
    const storedFilePath = path.join(uploadsDir, safeStoredName);
    fs.writeFileSync(storedFilePath, req.file.buffer);

    const bridge = McpBridgeManager.getInstance();
    const markdown = await bridge.parseDocumentToMarkdown(storedFilePath, originalName);

    res.json({
      success: true,
      data: {
        originalName,
        markdown,
        serverFilePath: storedFilePath,
        fileName: safeStoredName,
      },
    });
  } catch (err: any) {
    console.error('[mcpBridge] 解析文档错误:', err.message);
    res.status(500).json({ success: false, message: err.message || '解析文档失败' });
  }
});

export default router;
