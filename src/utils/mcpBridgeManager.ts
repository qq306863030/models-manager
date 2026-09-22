/**
 * mcpBridgeManager.ts
 *
 * 负责管理与本地外部 Stdio MCP 进程（如 npx -y doc-processor-mcp）的长连接通信，
 * 发现工具、代理工具执行，并提供快捷的文档提取转换能力。
 */

import path from 'path';
import fs from 'fs';
import os from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpServerConfig {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpToolDefinition {
  serverName: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function getMcpBaseDir(): string {
  const dir = path.join(os.homedir(), '.models-manager', 'mcp-files');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getMcpUploadsDir(): string {
  const dir = path.join(getMcpBaseDir(), 'uploads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getMcpOutputsDir(): string {
  const dir = path.join(getMcpBaseDir(), 'outputs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getMcpTempDir(): string {
  const dir = path.join(getMcpBaseDir(), 'temp');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class McpBridgeManager {
  private static instance: McpBridgeManager | null = null;
  private clients: Map<string, { client: Client; transport: StdioClientTransport }> = new Map();
  private toolCache: Map<string, McpToolDefinition[]> = new Map();
  private isConnecting: Map<string, Promise<boolean>> = new Map();

  private constructor() {}

  static getInstance(): McpBridgeManager {
    if (!McpBridgeManager.instance) {
      McpBridgeManager.instance = new McpBridgeManager();
    }
    return McpBridgeManager.instance;
  }

  /**
   * 获取 doc-processor 运行配置:
   * "doc-processor": {
   *   "command": "npx",
   *   "args": ["-y", "doc-processor-mcp"]
   * }
   */
  private getDocProcessorConfig(): McpServerConfig {
    const isWindows = process.platform === 'win32';
    // Windows 下执行 npx 需要指定 npx.cmd
    const command = isWindows ? 'npx.cmd' : 'npx';
    const args = ['-y', 'doc-processor-mcp'];

    return {
      command,
      args,
    };
  }

  /**
   * 初始化并连接指定的 MCP 服务
   */
  async ensureServerConnected(serverName: string): Promise<boolean> {
    if (this.clients.has(serverName)) {
      return true;
    }

    if (this.isConnecting.has(serverName)) {
      return this.isConnecting.get(serverName)!;
    }

    const connectPromise = (async () => {
      try {
        let config: McpServerConfig | null = null;
        if (serverName === 'doc-processor') {
          config = this.getDocProcessorConfig();
        }

        if (!config) {
          console.warn(`[McpBridge] 未知或未配置的 MCP Server: ${serverName}`);
          return false;
        }

        console.log(`[McpBridge] 正在启动并连接 ${serverName}: ${config.command} ${config.args.join(' ')}`);

        const cleanEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(process.env)) {
          if (typeof v === 'string') cleanEnv[k] = v;
        }
        if (config.env) {
          Object.assign(cleanEnv, config.env);
        }

        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          cwd: config.cwd,
          env: cleanEnv,
        });

        const client = new Client(
          {
            name: 'models-manager-mcp-bridge',
            version: '1.0.0',
          },
          {
            capabilities: {},
          }
        );

        await client.connect(transport);

        // 获取工具列表
        const toolsResult = await client.listTools();
        const tools: McpToolDefinition[] = (toolsResult.tools || []).map((t) => ({
          serverName,
          name: t.name,
          description: t.description || '',
          parameters: (t.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
        }));

        this.clients.set(serverName, { client, transport });
        this.toolCache.set(serverName, tools);

        console.log(`[McpBridge] ${serverName} 连接成功，已就绪 ${tools.length} 个工具`);
        return true;
      } catch (err: any) {
        console.error(`[McpBridge] 连接 ${serverName} 失败:`, err.message);
        return false;
      } finally {
        this.isConnecting.delete(serverName);
      }
    })();

    this.isConnecting.set(serverName, connectPromise);
    return connectPromise;
  }

  /**
   * 获取所有已挂载 Stdio MCP 服务的工具定义（格式适配为 OpenAI Tool Schema）
   */
  async getAllTools(): Promise<Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>> {
    await this.ensureServerConnected('doc-processor');

    const result: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }> = [];

    // 内置文件生成工具：创建 Markdown 文件
    result.push({
      type: 'function',
      function: {
        name: 'create_markdown_file',
        description: '创建 Markdown (.md) 文件。输入 Markdown 纯文本内容，将文件写入保存至服务器 outputs 目录，并输出文件本地绝对路径和 Web 下载链接。可用于将生成的排版文章、代码总结等保存为文件，或作为其它转换工具（如 md_conver）的输入源。',
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: 'Markdown 文本正文内容（如总结报告、表格、文档排版内容）',
            },
            fileName: {
              type: 'string',
              description: '可选，指定保存的 Markdown 文件名（例如 note.md、report.md）。若未提供则自动分配带时间戳的文件名。',
            },
          },
          required: ['content'],
        },
      },
    });

    for (const [, tools] of this.toolCache) {
      for (const t of tools) {
        result.push({
          type: 'function',
          function: {
            name: t.name,
            description: `[${t.serverName}] ${t.description}`,
            parameters: t.parameters,
          },
        });
      }
    }

    return result;
  }

  /**
   * 执行指定工具
   */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<any> {
    // 1. 处理内置创建 Markdown 文件的工具
    if (toolName === 'create_markdown_file') {
      const argsObj = (args && typeof args === 'object' ? args : {}) as Record<string, any>;
      const content = String(argsObj.content ?? argsObj.markdown ?? argsObj.markdownText ?? argsObj.text ?? '');
      let rawFileName = String(
        argsObj.fileName ?? argsObj.filename ?? argsObj.markdownFileName ?? argsObj.name ?? argsObj.title ?? ''
      ).trim();

      if (!rawFileName) {
        rawFileName = `document_${Date.now()}.md`;
      } else {
        const base = path.basename(rawFileName);
        if (!base.toLowerCase().endsWith('.md')) {
          rawFileName = `${base}.md`;
        } else {
          rawFileName = base;
        }
      }

      const outputsDir = getMcpOutputsDir();
      const filePath = path.join(outputsDir, rawFileName);
      fs.writeFileSync(filePath, content, 'utf8');

      const downloadUrl = `/api/mcp/download?file=${encodeURIComponent(rawFileName)}`;
      const message = [
        `Markdown 文件创建成功！`,
        `- 文件名称: ${rawFileName}`,
        `- 服务器文件路径: ${filePath}`,
        `- Web 下载链接: ${downloadUrl}`,
        ``,
        `（若向用户提供下载，请使用 Markdown 链接格式: [点击下载 ${rawFileName}](${downloadUrl})；若需要将此文件转换为 Word/PDF 等，可直接将上述服务器文件路径作为 inputPath 传给 md_conver 工具）`,
      ].join('\n');

      return {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
        filePath,
        fileName: rawFileName,
        downloadUrl,
      };
    }

    let targetServer = '';
    for (const [serverName, tools] of this.toolCache) {
      if (tools.some((t) => t.name === toolName)) {
        targetServer = serverName;
        break;
      }
    }

    if (!targetServer) {
      await this.ensureServerConnected('doc-processor');
      const tools = this.toolCache.get('doc-processor') || [];
      if (tools.some((t) => t.name === toolName)) {
        targetServer = 'doc-processor';
      }
    }

    if (!targetServer || !this.clients.has(targetServer)) {
      throw new Error(`找不到提供工具 "${toolName}" 的 MCP 实例`);
    }

    // 智能拦截/规范化文件输出路径：若工具包含 outputPath，重定向到 ~/.models-manager/mcp-files/outputs 目录
    const outputsDir = getMcpOutputsDir();
    let expectedOutputFile = '';
    const argsObj = (args && typeof args === 'object' ? args : {}) as Record<string, any>;
    if (typeof argsObj.outputPath === 'string' && argsObj.outputPath) {
      const baseName = path.basename(argsObj.outputPath);
      argsObj.outputPath = path.join(outputsDir, baseName);
      expectedOutputFile = argsObj.outputPath;
    } else if (toolName === 'md_conver' && typeof argsObj.inputPath === 'string' && !argsObj.outputPath) {
      // 如果 md_conver 缺少 outputPath，根据输入文件名自动分配
      const inBase = path.basename(argsObj.inputPath, path.extname(argsObj.inputPath));
      const outExt = typeof argsObj.targetExt === 'string' ? argsObj.targetExt : '.md';
      argsObj.outputPath = path.join(outputsDir, `${inBase}_${Date.now()}${outExt}`);
      expectedOutputFile = argsObj.outputPath;
    }

    const { client } = this.clients.get(targetServer)!;
    console.log(`[McpBridge] 正在向 ${targetServer} 执行工具: ${toolName}`, args);
    const result: any = await client.callTool({
      name: toolName,
      arguments: args,
    });

    // 检查是否有新生成的文件，自动转换本地物理路径为 Web 下载链接
    try {
      let generatedPath = '';
      if (expectedOutputFile && fs.existsSync(expectedOutputFile)) {
        generatedPath = expectedOutputFile;
      } else {
        // 从返回文本中尝试正则匹配本地磁盘路径
        const text = result?.content?.[0]?.text || '';
        const match = text.match(/([A-Za-z]:\\[^"'\n\r\t]+|\/[^"'\n\r\t]+?\.[a-zA-Z0-9]{2,5})/);
        if (match && fs.existsSync(match[0])) {
          const matchedPath = match[0];
          const fileName = path.basename(matchedPath);
          const targetPath = path.join(outputsDir, fileName);
          if (matchedPath !== targetPath) {
            fs.copyFileSync(matchedPath, targetPath);
          }
          generatedPath = targetPath;
        }
      }

      if (generatedPath && fs.existsSync(generatedPath)) {
        const fileName = path.basename(generatedPath);
        const downloadUrl = `/api/mcp/download?file=${encodeURIComponent(fileName)}`;
        const downloadNotice = [
          '',
          `【生成文件下载信息】:`,
          `- 文件名称: ${fileName}`,
          `- Web 下载链接: ${downloadUrl}`,
          `（请在回复中为用户提供可点击的 Markdown 链接如: [点击下载 ${fileName}](${downloadUrl})，切勿向用户输出本地绝对路径）`,
        ].join('\n');

        if (!result.content) result.content = [];
        if (result.content[0] && typeof result.content[0].text === 'string') {
          result.content[0].text += '\n' + downloadNotice;
        } else {
          result.content.push({ type: 'text', text: downloadNotice });
        }
        result.downloadUrl = downloadUrl;
        result.fileName = fileName;
      }
    } catch (err: any) {
      console.warn('[McpBridge] 后处理文件下载链接警告:', err.message);
    }

    return result;
  }

  /**
   * 文档快捷解析：利用 doc-processor 的工具将文件解析为 Markdown 格式文本
   */
  async parseDocumentToMarkdown(filePath: string, originalName: string): Promise<string> {
    const ext = path.extname(originalName).toLowerCase();
    const connected = await this.ensureServerConnected('doc-processor');

    if (!connected) {
      throw new Error('doc-processor MCP 服务未就绪');
    }

    // Excel 表格优先使用 doc_excel_read 转化为结构化数据
    if (ext === '.xlsx' || ext === '.xls') {
      try {
        const res = await this.callTool('doc_excel_read', { filePath });
        const textContent = res?.content?.[0]?.text;
        if (textContent) {
          return `### 表格数据 (${originalName})\n\n` + textContent;
        }
      } catch (err: any) {
        console.warn('[McpBridge] doc_excel_read 失败，降级尝试 md_conver:', err.message);
      }
    }

    // 其他格式使用 md_conver 转换为 Markdown，临时文件存放于 ~/.models-manager/mcp-files/temp
    const tempOutputDir = getMcpTempDir();
    const targetMdFile = path.join(tempOutputDir, `${path.basename(originalName, ext)}_${Date.now()}.md`);

    try {
      const res = await this.callTool('md_conver', {
        inputPath: filePath,
        outputPath: targetMdFile,
      });

      if (fs.existsSync(targetMdFile)) {
        const mdContent = fs.readFileSync(targetMdFile, 'utf-8');
        setTimeout(() => {
          try { fs.unlinkSync(targetMdFile); } catch {}
        }, 30000);
        return mdContent;
      }

      const directText = res?.content?.[0]?.text;
      if (directText && typeof directText === 'string') {
        return directText;
      }

      throw new Error('未能生成目标 Markdown 内容');
    } catch (err: any) {
      console.error('[McpBridge] md_conver 转换失败:', err.message);
      throw new Error(`文档解析失败: ${err.message}`);
    }
  }
}

export default McpBridgeManager;
