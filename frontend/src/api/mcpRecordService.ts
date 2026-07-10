import request from './models';

export interface McpRecordData {
  content: string;
}

// 获取当前用户的 MCP 记录
export const getMcpRecord = () => {
  return request.get<{ success: boolean; data: McpRecordData | null }>('/mcp-records');
};

// 保存当前用户的 MCP 记录
export const saveMcpRecord = (content: string) => {
  return request.post<{ success: boolean; message: string; data?: { content: string } }>('/mcp-records', { content });
};
