import request from './models';

export interface RequestLogItem {
  id: string;
  timestamp: string;
  startTime: number;
  method: string;
  endpoint: string;
  model: string;
  actualModel?: string;
  stream: boolean;
  status: 'pending' | 'success' | 'error';
  statusCode?: number;
  durationMs: number;
  systemPrompt: string;
  toolNames: string[];
  tools: any[];
  messages: any[];
  error?: string;
  username?: string;
  clientIp?: string;
}

export const getRequestLogs = () => {
  return request.get<{ success: boolean; data: RequestLogItem[] }>('/request-logs');
};

export const clearRequestLogsApi = () => {
  return request.delete<{ success: boolean; message: string }>('/request-logs');
};
