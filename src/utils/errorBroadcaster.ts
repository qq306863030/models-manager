/**
 * Error Broadcaster — 实时错误广播
 *
 * 通过 WebSocket 向所有连接的客户端推送错误消息，
 * 包括上游 API 错误、超时错误、流式处理错误等。
 * 每个新连接的客户端会收到最近 30 条错误历史。
 */

import { WebSocket } from 'ws';

import { formatTimestamp } from './timezone';

export interface ErrorLogEntry {
  timestamp: string
  modelId: number
  modelName: string
  errorType: string
  message: string
}

const MAX_MESSAGES = 30;

class ErrorBroadcaster {
  private messages: ErrorLogEntry[] = [];
  private clients: Set<WebSocket> = new Set();

  /** 推送一条错误消息给所有客户端 */
  emitError(modelId: number, modelName: string, errorType: string, message: string): void {
    const entry: ErrorLogEntry = {
      timestamp: formatTimestamp(new Date()),
      modelId,
      modelName,
      errorType,
      message,
    };

    // 存储到历史（最多保留 MAX_MESSAGES 条）
    this.messages.push(entry);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages = this.messages.slice(-MAX_MESSAGES);
    }

    // 广播给所有客户端
    const data = JSON.stringify({ type: 'error', data: entry });
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /** 客户端连接时订阅 */
  subscribe(ws: WebSocket): void {
    this.clients.add(ws);

    // 发送最近的历史消息
    for (const msg of this.messages) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', data: msg }));
      }
    }
  }

  /** 客户端断开时取消订阅 */
  unsubscribe(ws: WebSocket): void {
    this.clients.delete(ws);
  }
}

export const errorBroadcaster = new ErrorBroadcaster();
