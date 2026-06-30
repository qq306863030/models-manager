// ==================== API 格式 ====================

export type ApiFormat = 1 | 2 | 3

export const API_FORMAT_OPTIONS: { value: ApiFormat; label: string }[] = [
  { value: 1, label: 'Chat Completions (/chat/completions)' },
  { value: 2, label: 'Anthropic Messages (/v1/messages)' },
  { value: 3, label: 'Responses (/responses)' },
]

export const API_FORMAT_MAP: Record<ApiFormat, string> = {
  1: 'Chat Completions',
  2: 'Anthropic Messages',
  3: 'Responses',
}

// 获取 API 格式标签类型
export const getApiFormatTagType = (
  format: number,
): 'primary' | 'success' | 'warning' => {
  if (format === 2) return 'warning'
  if (format === 3) return 'success'
  return 'primary'
}

// ==================== 模态能力 ====================

export const CAPABILITIES_OPTIONS: { value: string; label: string }[] = [
  { value: 'completion', label: 'Completion' },
  { value: 'tools', label: 'Tools' },
  { value: 'thinking', label: 'Thinking' },
  { value: 'vision', label: 'Vision' },
]

export const DEFAULT_CAPABILITIES = ['completion', 'tools', 'thinking']
