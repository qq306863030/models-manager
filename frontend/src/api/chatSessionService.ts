/**
 * chatSessionService.ts
 *
 * AI 聊天会话的服务端持久化接口，用于 PC 端与移动端跨设备共享同一份会话数据。
 * 请求拦截器会自动附带 X-Username 与 Authorization，无需在此手动处理。
 */

import request from './models';

/** 会话消息（结构由前端 useChatStore 定义，服务端按原样 JSON 存取） */
export interface ChatSessionMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  reasoning?: string;
  attachments?: any[];
  toolCalls?: any[];
  createdAt: number;
  error?: string | null;
}

/** 会话同步载荷 */
export interface ChatSessionPayload {
  id: string;
  title: string;
  modelName: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatSessionMessage[];
}

/** 拉取当前用户全部会话（按最近更新倒序） */
export const getChatSessions = () => {
  return request.get<{ success: boolean; data: ChatSessionPayload[] }>('/chat/sessions', {
    timeout: 30000,
  });
};

/** 保存单个会话（upsert） */
export const saveChatSession = (session: ChatSessionPayload) => {
  return request.put<{ success: boolean; data: { id: string; updatedAt: number } }>(
    `/chat/sessions/${encodeURIComponent(session.id)}`,
    session,
    { timeout: 60000 }
  );
};

/** 批量保存会话（首次迁移 / 跨端合并） */
export const saveChatSessions = (sessions: ChatSessionPayload[]) => {
  return request.put<{ success: boolean; data: { saved: number; skipped: string[] } }>(
    '/chat/sessions',
    { sessions },
    { timeout: 60000 }
  );
};

/** 删除单个会话 */
export const deleteChatSession = (id: string) => {
  return request.delete<{ success: boolean; message: string }>(
    `/chat/sessions/${encodeURIComponent(id)}`,
    { timeout: 30000 }
  );
};

/** 清空当前用户全部会话 */
export const clearChatSessions = () => {
  return request.delete<{ success: boolean; data: { removed: number } }>('/chat/sessions', {
    timeout: 30000,
  });
};
