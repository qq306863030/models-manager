/**
 * useErrorLog — 错误日志 WebSocket composable
 *
 * 管理与后端的 WebSocket 连接，接收实时错误推送，
 * 维护最近 30 条错误消息列表。
 */

import { ref } from 'vue'

export interface ErrorLogEntry {
  timestamp: string
  modelId: number
  modelName: string
  errorType: string
  message: string
}

const MAX_MESSAGES = 30

// 全局单例状态
const errorLogs = ref<ErrorLogEntry[]>([])
let ws: WebSocket | null = null
let reconnectTimer: number | null = null
let connected = false

function connect(): void {
  if (connected) return

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url = `${protocol}//${window.location.host}`

  ws = new WebSocket(url)

  ws.onopen = () => {
    connected = true
    console.log('[ErrorLog] WebSocket connected')
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      if (msg.type === 'error' && msg.data) {
        errorLogs.value.push(msg.data)
        // 最多保留 MAX_MESSAGES 条
        if (errorLogs.value.length > MAX_MESSAGES) {
          errorLogs.value = errorLogs.value.slice(-MAX_MESSAGES)
        }
      }
    } catch {
      // ignore parse errors
    }
  }

  ws.onclose = () => {
    connected = false
    ws = null
    console.log('[ErrorLog] WebSocket disconnected, reconnecting in 3s...')
    // 自动重连
    reconnectTimer = window.setTimeout(() => {
      connect()
    }, 3000)
  }

  ws.onerror = () => {
    // onclose 会自动触发
  }
}

function disconnect(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (ws) {
    ws.close()
    ws = null
  }
  connected = false
}

function clearLogs(): void {
  errorLogs.value = []
}

export function useErrorLog() {
  return {
    errorLogs,
    connect,
    disconnect,
    clearLogs,
  }
}
