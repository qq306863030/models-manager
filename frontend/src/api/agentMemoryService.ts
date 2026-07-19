import request from './models';

export interface AgentMemoryItem {
  id: number;
  description: string | null;
  content: string | null;
}

export interface AgentMemoryResponse {
  success: boolean;
  data: AgentMemoryItem | AgentMemoryItem[] | null;
  message?: string;
}

type MemoryType = 'user' | 'skills';

// 获取列表
export const getMemoryList = (type: MemoryType) => {
  return request.get<{ success: boolean; data: AgentMemoryItem[] }>(`/agent-memory/${type}`);
};

// 获取单条
export const getMemoryById = (type: MemoryType, id: number) => {
  return request.get<{ success: boolean; data: AgentMemoryItem }>(`/agent-memory/${type}/${id}`);
};

// 新增
export const createMemory = (type: MemoryType, description: string | null, content: string | null) => {
  return request.post<{ success: boolean; message: string; data: { id: number } }>(`/agent-memory/${type}`, { description, content });
};

// 更新
export const updateMemory = (type: MemoryType, id: number, description: string | null, content: string | null) => {
  return request.put<{ success: boolean; message: string }>(`/agent-memory/${type}/${id}`, { description, content });
};

// 删除
export const deleteMemory = (type: MemoryType, id: number) => {
  return request.delete<{ success: boolean; message: string }>(`/agent-memory/${type}/${id}`);
};
