/**
 * useRequestLog — 请求日志 Composable
 *
 * 管理最近 100 次代理请求信息，支持 REST 查询与 WebSocket 实时推送更新
 */

import { ref } from 'vue';
import {
  getRequestLogs,
  clearRequestLogsApi,
  type RequestLogItem,
} from '@/api/requestLogService';

const MAX_REQUESTS = 100;

// 全局单例状态
const requestLogs = ref<RequestLogItem[]>([]);
const loading = ref(false);

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let connected = false;

export async function fetchLogs(): Promise<void> {
  loading.value = true;
  try {
    const res = await getRequestLogs();
    if (res.success && Array.isArray(res.data)) {
      requestLogs.value = res.data.slice(-MAX_REQUESTS);
    }
  } catch (e) {
    console.error('[useRequestLog] 获取请求日志失败:', e);
  } finally {
    loading.value = false;
  }
}

export async function clearLogs(): Promise<void> {
  try {
    await clearRequestLogsApi();
    requestLogs.value = [];
  } catch (e) {
    console.error('[useRequestLog] 清空请求日志失败:', e);
  }
}

function handleWsMessage(event: MessageEvent): void {
  try {
    const msg = JSON.parse(event.data);
    if (msg.type === 'request_history' && Array.isArray(msg.data)) {
      requestLogs.value = msg.data.slice(-MAX_REQUESTS);
    } else if (msg.type === 'request_log' && msg.data) {
      // 避免重复追加
      const exists = requestLogs.value.some((r) => r.id === msg.data.id);
      if (!exists) {
        requestLogs.value.push(msg.data);
        if (requestLogs.value.length > MAX_REQUESTS) {
          requestLogs.value = requestLogs.value.slice(-MAX_REQUESTS);
        }
      }
    } else if (msg.type === 'request_log_update' && msg.data) {
      const idx = requestLogs.value.findIndex((r) => r.id === msg.data.id);
      if (idx !== -1) {
        requestLogs.value[idx] = { ...requestLogs.value[idx], ...msg.data };
      } else {
        requestLogs.value.push(msg.data);
        if (requestLogs.value.length > MAX_REQUESTS) {
          requestLogs.value = requestLogs.value.slice(-MAX_REQUESTS);
        }
      }
    } else if (msg.type === 'request_log_clear') {
      requestLogs.value = [];
    }
  } catch {
    // 忽略非 JSON 格式
  }
}

function connect(): void {
  if (connected) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}`;

  ws = new WebSocket(url);

  ws.onopen = () => {
    connected = true;
  };

  ws.onmessage = handleWsMessage;

  ws.onclose = () => {
    connected = false;
    ws = null;
    reconnectTimer = window.setTimeout(() => {
      connect();
    }, 3000);
  };

  ws.onerror = () => {
    // onclose 会触发
  };
}

function disconnect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  connected = false;
}

export function useRequestLog() {
  return {
    requestLogs,
    loading,
    fetchLogs,
    clearLogs,
    connect,
    disconnect,
  };
}
