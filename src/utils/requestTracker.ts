/**
 * Request Tracker — 实时请求跟踪器
 *
 * 记录最近 100 次代理请求信息，包括时间、模型、耗时、状态码、系统提示词、携带的工具等，
 * 并通过 WebSocket 和 REST API 提供给前端查看。
 */

import { WebSocket } from 'ws';
import { formatTimestamp } from './timezone';

export interface RequestLogEntry {
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

const MAX_REQUESTS = 100;

class RequestTracker {
  private requests: RequestLogEntry[] = [];
  private clients: Set<WebSocket> = new Set();

  /**
   * 记录请求开始
   */
  recordStart(params: {
    endpoint: string;
    method?: string;
    model: string;
    stream: boolean;
    systemPrompt?: string;
    toolNames?: string[];
    tools?: any[];
    messages?: any[];
    username?: string;
    clientIp?: string;
  }): RequestLogEntry {
    const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const entry: RequestLogEntry = {
      id,
      timestamp: formatTimestamp(new Date(now)),
      startTime: now,
      method: params.method || 'POST',
      endpoint: params.endpoint,
      model: params.model,
      stream: params.stream,
      status: 'pending',
      durationMs: 0,
      systemPrompt: params.systemPrompt || '',
      toolNames: params.toolNames || [],
      tools: params.tools || [],
      messages: params.messages || [],
      username: params.username,
      clientIp: params.clientIp,
    };

    this.requests.push(entry);
    if (this.requests.length > MAX_REQUESTS) {
      this.requests = this.requests.slice(-MAX_REQUESTS);
    }

    this.broadcast({ type: 'request_log', data: entry });
    return entry;
  }

  /**
   * 记录请求结束
   */
  recordEnd(
    id: string,
    updates: {
      statusCode?: number;
      status?: 'success' | 'error';
      actualModel?: string;
      error?: string;
    },
  ): void {
    const entry = this.requests.find((r) => r.id === id);
    if (!entry) return;

    entry.durationMs = Date.now() - entry.startTime;
    if (updates.statusCode !== undefined) {
      entry.statusCode = updates.statusCode;
      if (!updates.status) {
        entry.status = updates.statusCode >= 200 && updates.statusCode < 400 ? 'success' : 'error';
      }
    }
    if (updates.status) {
      entry.status = updates.status;
    }
    if (updates.actualModel) {
      entry.actualModel = updates.actualModel;
    }
    if (updates.error) {
      entry.error = updates.error;
    }

    this.broadcast({ type: 'request_log_update', data: entry });
  }

  /**
   * 获取最近的请求记录（最新在后）
   */
  getRecentRequests(): RequestLogEntry[] {
    return [...this.requests];
  }

  /**
   * 清空记录
   */
  clear(): void {
    this.requests = [];
    this.broadcast({ type: 'request_log_clear' });
  }

  /**
   * WebSocket 客户端订阅
   */
  subscribe(ws: WebSocket): void {
    this.clients.add(ws);

    // 连接时发送当前的完整历史记录
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'request_history',
          data: this.requests,
        }),
      );
    }
  }

  /**
   * WebSocket 客户端退订
   */
  unsubscribe(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  /**
   * 广播消息给所有连接的客户端
   */
  private broadcast(payload: Record<string, unknown>): void {
    const message = JSON.stringify(payload);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}

export const requestTracker = new RequestTracker();
