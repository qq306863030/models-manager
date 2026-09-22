import request from './models';

export interface McpToolItem {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ParseDocResponse {
  originalName: string;
  markdown: string;
}

/**
 * 获取后端桥接的外部 MCP 工具列表（例如 doc-processor）
 */
export const getExternalMcpTools = () => {
  return request.get<{ success: boolean; data: McpToolItem[] }>('/mcp/tools');
};

/**
 * 远程执行外部 MCP 工具
 */
export const callExternalMcpTool = (toolName: string, args: Record<string, unknown>) => {
  return request.post<{ success: boolean; data: any }>('/mcp/call', {
    toolName,
    arguments: args,
  });
};

/**
 * 上传文档（pdf/docx/pptx/xlsx）并解析为 Markdown 文本
 */
export const parseDocumentToMarkdown = (file: File) => {
  const formData = new FormData();
  formData.append('file', file);
  return request.post<{ success: boolean; data: ParseDocResponse }>('/mcp/parse-document', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000, // 2分钟超时
  });
};
