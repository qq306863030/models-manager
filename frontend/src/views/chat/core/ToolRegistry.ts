/**
 * ToolRegistry.ts
 *
 * 统一管理前端 Agent 所需的所有 MCP 工具（模型记忆、处置方案、我的文档、以及外部 doc-processor 等），
 * 负责向 LLM 输出工具 Schema 声明，并执行具体的 Function Calling。
 */

import type { ILlmToolSchema } from './LlmClient';
import {
  getMemoryList,
  getMemoryById,
  createMemory,
  updateMemory,
  deleteMemory,
} from '../../../api/agentMemoryService';
import { getExternalMcpTools, callExternalMcpTool, parseDocumentToMarkdown } from '../../../api/chatMcpService';
import { uploadFile } from '../../../api/userFilesService';

export type TToolExecutor = (args: Record<string, any>) => Promise<any>;

interface IInternalToolDef {
  name: string;
  title: string;
  category: 'memory' | 'skills' | 'docs' | 'external';
  description: string;
  parameters: Record<string, unknown>;
  executor: TToolExecutor;
}

export class ToolRegistry {
  private static instance: ToolRegistry | null = null;
  private internalTools: Map<string, IInternalToolDef> = new Map();
  private externalTools: Map<string, { schema: ILlmToolSchema; title: string }> = new Map();
  private isExternalLoaded = false;

  private constructor() {
    this.registerBuiltInTools();
  }

  static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry();
    }
    return ToolRegistry.instance;
  }

  /**
   * 注册内置的 3 大平台 MCP 工具（模型记忆、处置方案、我的文档）
   */
  private registerBuiltInTools() {
    // ========== 1. 模型记忆 (User Memory) ==========
    this.registerInternal({
      name: 'ai_mm_search_user_memories',
      title: '检索模型记忆',
      category: 'memory',
      description: '根据关键词检索当前用户的长期偏好、习惯与系统配置画像，返回匹配的记忆列表',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词，如称呼、系统、习惯、docker等' },
        },
      },
      executor: async ({ keyword }: { keyword?: string }) => {
        const res = await getMemoryList('user');
        const list = res.data || [];
        if (!keyword) return list;
        const kw = keyword.toLowerCase();
        return list.filter((item) =>
          (item.description && item.description.toLowerCase().includes(kw)) ||
          (item.content && item.content.toLowerCase().includes(kw))
        );
      },
    });

    this.registerInternal({
      name: 'ai_mm_get_user_memory_detail',
      title: '查看记忆详情',
      category: 'memory',
      description: '根据 ID 获取指定记忆条目的完整内容',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '记忆条目 ID' },
        },
        required: ['id'],
      },
      executor: async ({ id }: { id: number }) => {
        const res = await getMemoryById('user', Number(id));
        return res.data;
      },
    });

    this.registerInternal({
      name: 'ai_mm_create_user_memory',
      title: '保存新记忆',
      category: 'memory',
      description: '记录或沉淀关于用户的长期偏好、项目、系统配置等新信息',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: '类别描述，如：用户称呼、用户系统设置、用户操作习惯、用户编码习惯、用户个人偏好、AI人格设定、AI长期计划、AI其他记忆',
          },
          content: { type: 'string', description: '记忆详细内容' },
        },
        required: ['description', 'content'],
      },
      executor: async ({ description, content }: { description: string; content: string }) => {
        const res = await createMemory('user', description, content);
        return { success: true, message: '记忆已保存', id: res.data?.id };
      },
    });

    this.registerInternal({
      name: 'ai_mm_update_user_memory',
      title: '更新用户记忆',
      category: 'memory',
      description: '更新已有记忆条目的类别或详细内容',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '要更新的记忆 ID' },
          description: { type: 'string', description: '新的类别描述' },
          content: { type: 'string', description: '新的记忆内容' },
        },
        required: ['id', 'content'],
      },
      executor: async ({ id, description, content }: { id: number; description?: string; content: string }) => {
        await updateMemory('user', Number(id), description || null, content);
        return { success: true, message: '记忆已成功更新' };
      },
    });

    this.registerInternal({
      name: 'ai_mm_delete_user_memory',
      title: '删除记忆条目',
      category: 'memory',
      description: '删除指定 ID 的用户记忆',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '要删除的记忆 ID' },
        },
        required: ['id'],
      },
      executor: async ({ id }: { id: number }) => {
        await deleteMemory('user', Number(id));
        return { success: true, message: '记忆已删除' };
      },
    });

    // ========== 2. 处置方案 (Skills) ==========
    this.registerInternal({
      name: 'ai_mm_search_skills',
      title: '检索处置方案',
      category: 'skills',
      description: '根据关键词在处置方案库（故障排查、运维步骤、标准化流程）中搜索匹配项',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
        },
      },
      executor: async ({ keyword }: { keyword?: string }) => {
        const res = await getMemoryList('skills');
        const list = res.data || [];
        if (!keyword) return list;
        const kw = keyword.toLowerCase();
        return list.filter((item) =>
          (item.description && item.description.toLowerCase().includes(kw)) ||
          (item.content && item.content.toLowerCase().includes(kw))
        );
      },
    });

    this.registerInternal({
      name: 'ai_mm_get_skill_detail',
      title: '查看处置方案详情',
      category: 'skills',
      description: '根据 ID 获取指定处置方案的详细步骤与内容',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '处置方案 ID' },
        },
        required: ['id'],
      },
      executor: async ({ id }: { id: number }) => {
        const res = await getMemoryById('skills', Number(id));
        return res.data;
      },
    });

    this.registerInternal({
      name: 'ai_mm_create_skill',
      title: '新增处置方案',
      category: 'skills',
      description: '将解决问题的新流程、规范或最佳实践沉淀为处置方案',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '方案标题与核心概述' },
          content: { type: 'string', description: '方案详细步骤与指令' },
        },
        required: ['description', 'content'],
      },
      executor: async ({ description, content }: { description: string; content: string }) => {
        const res = await createMemory('skills', description, content);
        return { success: true, message: '处置方案已创建', id: res.data?.id };
      },
    });

    this.registerInternal({
      name: 'ai_mm_update_skill',
      title: '更新处置方案',
      category: 'skills',
      description: '更新指定 ID 处置方案的内容',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '处置方案 ID' },
          description: { type: 'string', description: '新方案标题' },
          content: { type: 'string', description: '新方案详细内容' },
        },
        required: ['id', 'content'],
      },
      executor: async ({ id, description, content }: { id: number; description?: string; content: string }) => {
        await updateMemory('skills', Number(id), description || null, content);
        return { success: true, message: '处置方案已更新' };
      },
    });

    this.registerInternal({
      name: 'ai_mm_delete_skill',
      title: '删除处置方案',
      category: 'skills',
      description: '删除指定 ID 的处置方案',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '处置方案 ID' },
        },
        required: ['id'],
      },
      executor: async ({ id }: { id: number }) => {
        await deleteMemory('skills', Number(id));
        return { success: true, message: '处置方案已删除' };
      },
    });

    // ========== 3. 我的文档 (User Document) ==========
    this.registerInternal({
      name: 'ai_mm_search_user_docs',
      title: '检索知识库文档',
      category: 'docs',
      description: '在个人知识库与业务文档中根据关键词检索匹配记录',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
        },
      },
      executor: async ({ keyword }: { keyword?: string }) => {
        const res = await getMemoryList('docs');
        const list = res.data || [];
        if (!keyword) return list;
        const kw = keyword.toLowerCase();
        return list.filter((item) =>
          (item.description && item.description.toLowerCase().includes(kw)) ||
          (item.content && item.content.toLowerCase().includes(kw))
        );
      },
    });

    this.registerInternal({
      name: 'ai_mm_get_user_doc_detail',
      title: '查看文档内容',
      category: 'docs',
      description: '获取指定知识库文档的正文内容',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '文档 ID' },
        },
        required: ['id'],
      },
      executor: async ({ id }: { id: number }) => {
        const res = await getMemoryById('docs', Number(id));
        return res.data;
      },
    });

    this.registerInternal({
      name: 'ai_mm_create_user_doc',
      title: '新建知识库文档',
      category: 'docs',
      description: '新增一篇文档到知识库中',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '文档名称或标题' },
          content: { type: 'string', description: '文档正文内容' },
        },
        required: ['description', 'content'],
      },
      executor: async ({ description, content }: { description: string; content: string }) => {
        const res = await createMemory('docs', description, content);
        return { success: true, message: '文档已录入知识库', id: res.data?.id };
      },
    });

    this.registerInternal({
      name: 'ai_mm_update_user_doc',
      title: '更新知识库文档',
      category: 'docs',
      description: '更新指定文档的标题或正文',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '文档 ID' },
          description: { type: 'string', description: '新标题' },
          content: { type: 'string', description: '新正文内容' },
        },
        required: ['id', 'content'],
      },
      executor: async ({ id, description, content }: { id: number; description?: string; content: string }) => {
        await updateMemory('docs', Number(id), description || null, content);
        return { success: true, message: '知识库文档已更新' };
      },
    });

    this.registerInternal({
      name: 'ai_mm_delete_user_doc',
      title: '删除知识库文档',
      category: 'docs',
      description: '删除指定知识库文档',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: '文档 ID' },
        },
        required: ['id'],
      },
      executor: async ({ id }: { id: number }) => {
        await deleteMemory('docs', Number(id));
        return { success: true, message: '文档已删除' };
      },
    });

    // ========== 4. Markdown 文件创建 (通用工具) ==========
    this.registerInternal({
      name: 'create_markdown_file',
      title: '创建 Markdown 文件',
      category: 'external',
      description: '创建 Markdown (.md) 文件。输入 Markdown 纯文本内容，将文件写入保存至服务器 outputs/uploads 目录，并输出文件本地绝对路径和 Web 下载链接。可用于将生成的排版文章、代码总结等保存为文件，或作为其它转换工具（如 md_conver）的输入源。',
      parameters: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Markdown 纯文本正文内容（如总结报告、表格、文档排版内容）',
          },
          fileName: {
            type: 'string',
            description: '可选，指定保存的 Markdown 文件名（例如 note.md、report.md 或无需后缀的名称）。若未提供则自动分配带时间戳的文件名。',
          },
          markdownFileName: {
            type: 'string',
            description: '可选，保存的文件名称别名',
          },
        },
        required: ['content'],
      },
      executor: async (args: Record<string, any>) => {
        // 1. 优先调用后端专门的处理路由
        try {
          const res = await callExternalMcpTool('create_markdown_file', args);
          if (res?.success && res.data) {
            return res.data;
          }
        } catch {
          // 若后端处于旧进程未重载该工具，自动无感降级为通用持久化直传
        }

        const content = String(args.content ?? args.markdown ?? args.markdownText ?? args.text ?? '');
        let rawName = String(
          args.fileName ?? args.filename ?? args.markdownFileName ?? args.name ?? args.title ?? ''
        ).trim();

        if (!rawName) {
          rawName = `document_${Date.now()}.md`;
        } else if (!rawName.toLowerCase().endsWith('.md')) {
          rawName = `${rawName}.md`;
        }

        const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
        const file = new File([blob], rawName, { type: 'text/markdown' });

        // 优先通过平台官方文件管理接口上传并持久化，兼容当前已运行的后端进程
        let downloadUrl = '';
        const username = localStorage.getItem('auth_username') || '';
        try {
          const userRes = await uploadFile(file);
          if (userRes?.success && userRes.data?.id) {
            const fileId = userRes.data.id;
            const queryPart = username ? `?username=${encodeURIComponent(username)}` : '';
            downloadUrl = `/api/user-files/${fileId}/download${queryPart}`;
          }
        } catch (e: any) {
          console.warn('[create_markdown_file] uploadFile 异常，尝试兜底:', e.message);
        }

        // 同时尝试在 MCP 目录缓存物理文件（供下游 md_conver 等格式转换工具读取绝对路径）
        let savedPath = '';
        try {
          const mcpUpload = await parseDocumentToMarkdown(file);
          if (mcpUpload?.success && mcpUpload.data) {
            savedPath = mcpUpload.data.serverFilePath || '';
            if (!downloadUrl) {
              const fileName = mcpUpload.data.fileName || rawName;
              downloadUrl = `/api/mcp/download?file=${encodeURIComponent(fileName)}`;
            }
          }
        } catch {}

        if (!downloadUrl) {
          // 兜底下载链接
          downloadUrl = `/api/mcp/download?file=${encodeURIComponent(rawName)}`;
        }

        const message = [
          `Markdown 文件创建成功！`,
          `- 文件名称: ${rawName}`,
          `- Web 下载链接: ${downloadUrl}`,
          savedPath ? `- 服务器文件路径: ${savedPath}` : '',
          ``,
          `（请直接在回答中向用户呈现 Markdown 链接: [点击下载 ${rawName}](${downloadUrl})）`,
        ].filter(Boolean).join('\n');

        return {
          content: [
            {
              type: 'text',
              text: message,
            },
          ],
          filePath: savedPath || downloadUrl,
          fileName: rawName,
          downloadUrl,
        };
      },
    });
  }

  private registerInternal(def: IInternalToolDef) {
    this.internalTools.set(def.name, def);
  }

  /**
   * 异步加载外部 MCP 工具（如 doc-processor）
   */
  async loadExternalTools(): Promise<void> {
    if (this.isExternalLoaded) return;
    try {
      const res = await getExternalMcpTools();
      if (res.success && Array.isArray(res.data)) {
        this.externalTools.clear();
        for (const item of res.data) {
          const fn = item.function;
          let humanTitle = fn.name;
          if (fn.name === 'create_markdown_file') humanTitle = '创建 Markdown 文件';
          else if (fn.name === 'md_conver') humanTitle = 'Markdown/全格式互转';
          else if (fn.name.startsWith('doc_excel_')) humanTitle = 'Excel表格操作';
          else if (fn.name.startsWith('doc_word_')) humanTitle = 'Word文档操作';
          else if (fn.name.startsWith('doc_pdf_')) humanTitle = 'PDF处理';
          else if (fn.name.startsWith('doc_pptx_')) humanTitle = 'PowerPoint演示文稿';
          else if (fn.name.startsWith('doc_img_')) humanTitle = '图像处理与转换';

          this.externalTools.set(fn.name, {
            schema: item,
            title: humanTitle,
          });
        }
        this.isExternalLoaded = true;
      }
    } catch (e: any) {
      console.warn('[ToolRegistry] 加载外部 MCP 工具失败:', e.message);
    }
  }

  /**
   * 获取所有注册给 LLM 的 tools Schema
   */
  getAllSchemas(): ILlmToolSchema[] {
    const schemas: ILlmToolSchema[] = [];

    // 内置平台工具
    for (const [, tool] of this.internalTools) {
      schemas.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      });
    }

    // 外部 MCP 工具
    for (const [, tool] of this.externalTools) {
      schemas.push(tool.schema);
    }

    return schemas;
  }

  /**
   * 获取工具的人类友好中文标题
   */
  getToolTitle(toolName: string): string {
    if (this.internalTools.has(toolName)) {
      return this.internalTools.get(toolName)!.title;
    }
    if (this.externalTools.has(toolName)) {
      return this.externalTools.get(toolName)!.title;
    }
    return toolName;
  }

  /**
   * 格式化入参摘要显示（卡片摘要）
   */
  formatArgsPreview(toolName: string, args: Record<string, any>): string {
    if (toolName === 'create_markdown_file') {
      const fn = args.fileName || args.filename || args.markdownFileName || args.name || args.title || '';
      const len = String(args.content || args.markdown || args.text || '').length;
      return `文件名: ${fn || '自动分配'}, 内容: ${len} 字符`;
    }

    if (args.keyword) return `关键词: "${args.keyword}"`;
    if (args.description) return `分类/标题: "${args.description}"`;
    if (args.inputPath) return `输入: ${args.inputPath}`;
    if (args.filePath) return `文件: ${args.filePath}`;
    if (args.id) return `ID: #${args.id}`;

    const keys = Object.keys(args);
    return `${keys[0]}: ${JSON.stringify(args[keys[0]]).slice(0, 30)}...`;
  }

  /**
   * 执行特定的工具
   */
  async execute(toolName: string, args: Record<string, any>): Promise<any> {
    // 检查内置工具
    if (this.internalTools.has(toolName)) {
      const tool = this.internalTools.get(toolName)!;
      return await tool.executor(args);
    }

    // 检查外部工具
    if (this.externalTools.has(toolName)) {
      const res = await callExternalMcpTool(toolName, args);
      return res.data;
    }

    throw new Error(`未找到注册的工具: ${toolName}`);
  }
}

export default ToolRegistry;
