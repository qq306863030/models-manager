import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  getModels,
  updateModel,
  deleteModel,
  batchCreateModels,
  copyModel,
  reorderModels,
  type Model,
  type ModelForm,
  type ModelRowForm,
} from '@/api/modelService'
import { getTokenStatsByModelIds, type TokenStat } from '@/api/tokenStatsService'
import type { ModelLabelOption } from '@/components/AddModelDialog/index'

// ========== 模型列表 ==========
export const modelLoading = ref(false)
export const modelList = ref<Model[]>([])
export const selectedModelId = ref<number | null>(null)
export const checkedModelIds = ref<number[]>([])

// ========== Token 统计 ==========
export const statsLoading = ref(false)
export const allStats = ref<TokenStat[]>([])

const formatDate = (date: Date) => {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const getRecent7Days = () => {
  const end = new Date()
  const start = new Date()
  start.setDate(end.getDate() - 6)
  return [formatDate(start), formatDate(end)]
}

export const dateRange = ref<string[]>(getRecent7Days())

// ========== 模型Label 选项 ==========
export const modelLabelOptions = ref<ModelLabelOption[]>([])

// ========== 选中模型名称 ==========
export const selectedModelName = computed(() => {
  const m = modelList.value.find((item) => item.id === selectedModelId.value)
  return m ? m.name : '-'
})

// ========== 批量选择 ==========
export const isAllChecked = computed(() => {
  return modelList.value.length > 0 && checkedModelIds.value.length === modelList.value.length
})

export const handleCheckChange = (id: number, checked: boolean) => {
  if (checked) {
    if (!checkedModelIds.value.includes(id)) {
      checkedModelIds.value.push(id)
    }
  } else {
    checkedModelIds.value = checkedModelIds.value.filter((item) => item !== id)
  }
}

export const handleToggleAll = () => {
  if (isAllChecked.value) {
    checkedModelIds.value = []
  } else {
    checkedModelIds.value = modelList.value.map((item) => item.id)
  }
}

export const handleBatchDelete = () => {
  if (checkedModelIds.value.length === 0) {
    ElMessage.warning('请选择要删除的模型')
    return
  }

  ElMessageBox.confirm(
    `确定要删除选中的 ${checkedModelIds.value.length} 个模型吗？`,
    '批量删除',
    { type: 'warning' }
  )
    .then(async () => {
      const ids = [...checkedModelIds.value]
      try {
        await Promise.all(ids.map((id) => deleteModel(id)))
        ElMessage.success('批量删除成功')
        checkedModelIds.value = []
        if (selectedModelId.value && ids.includes(selectedModelId.value)) {
          selectedModelId.value = null
        }
        fetchModels()
      } catch {
        ElMessage.error('批量删除失败')
      }
    })
    .catch(() => {})
}

// ========== 排序后的模型列表 ==========
export const sortedModelList = computed(() => {
  return [...modelList.value].sort((a, b) => {
    // sort_index = -1 保持原添加顺序（按 created_at）
    const aIdx = a.sort_index === -1 ? 999999 : a.sort_index
    const bIdx = b.sort_index === -1 ? 999999 : b.sort_index
    if (aIdx !== bIdx) return aIdx - bIdx
    return a.created_at.localeCompare(b.created_at)
  })
})

// ========== 选中模型的图表统计 ==========
export const selectedModelStats = computed(() => {
  if (!selectedModelId.value) return []
  return allStats.value
    .filter((s) => s.model_id === selectedModelId.value)
    .sort((a, b) => a.stat_date.localeCompare(b.stat_date))
})

// ========== 按模型ID分组的统计数据（用于卡片展示） ==========
export interface ModelStatSummary {
  todayToken: number
  totalToken: number
  totalCallCount: number
}

export const modelStatMap = computed(() => {
  const map = new Map<number, ModelStatSummary>()
  const today = new Date().toISOString().slice(0, 10) // 'YYYY-MM-DD'

  for (const stat of allStats.value) {
    if (!map.has(stat.model_id)) {
      map.set(stat.model_id, { todayToken: 0, totalToken: 0, totalCallCount: 0 })
    }
    const entry = map.get(stat.model_id)!
    entry.totalToken += stat.total_token
    entry.totalCallCount += stat.call_count
    if (stat.stat_date === today) {
      entry.todayToken += stat.total_token
    }
  }
  return map
})

// ========== 加载模型列表 ==========
export const fetchModels = async () => {
  modelLoading.value = true
  try {
    const res = await getModels()
    if (res.success) {
      modelList.value = res.data
      const existIds = new Set(res.data.map((item) => item.id))
      checkedModelIds.value = checkedModelIds.value.filter((id) => existIds.has(id))
      if (!selectedModelId.value && res.data.length > 0) {
        selectedModelId.value = res.data[0].id
      }
      // 加载统计数据
      await fetchStats()
    }
  } catch {
    // error
  } finally {
    modelLoading.value = false
  }
}

// ========== 加载统计数据 ==========
export const fetchStats = async () => {
  statsLoading.value = true
  try {
    const params: any = {}
    if (dateRange.value && dateRange.value.length === 2) {
      params.start_date = dateRange.value[0]
      params.end_date = dateRange.value[1]
    }
    // 只加载模型列表中存在的模型的统计数据
    const modelIds = modelList.value.map((m) => m.id)
    if (modelIds.length > 0) {
      params.model_ids = modelIds.join(',')
    }
    const res = await getTokenStatsByModelIds(
      modelIds,
      params.start_date,
      params.end_date
    )
    if (res.success) {
      allStats.value = res.data
    }
  } catch {
    // error
  } finally {
    statsLoading.value = false
  }
}

// loadStats 是 fetchStats 的别名
export const loadStats = fetchStats

// ========== 选择模型（图表切换） ==========
export const selectModel = (id: number) => {
  // 切换选中状态：点击已选中的模型则取消选中
  selectedModelId.value = selectedModelId.value === id ? null : id
}

// ========== 添加模型弹窗 ==========
export const addDialogRef = ref<{ openDialog: () => void } | null>(null)
export const openAddDialog = () => {
  addDialogRef.value?.openDialog()
}
export const handleAddSubmit = async (data: {
  url: string
  api_key: string
  api_format: number
  items: ModelRowForm[]
}) => {
  try {
    const res = await batchCreateModels(data)
    if (res.success) {
      ElMessage.success(res.message || `成功添加 ${res.data.count} 条`)
      fetchModels()
    }
  } catch {
    // error
  }
}

// ========== 编辑模型（ModelCard 行内编辑模式通过父组件提交） ==========
export const handleEditSubmit = async (id: number, data: ModelForm) => {
  try {
    const res = await updateModel(id, data)
    if (res.success) {
      ElMessage.success('更新成功')
      fetchModels()
    }
  } catch {
    // error
  }
}

// ========== 复制模型 ==========
export const handleCopy = async (id: number) => {
  try {
    const res = await copyModel(id)
    if (res.success) {
      ElMessage.success('模型复制成功')
      fetchModels()
    }
  } catch {
    // error
  }
}

// ========== 切换锁定/禁用状态 ==========
const buildModelForm = (model: Model, patch: Partial<ModelForm> = {}): ModelForm => ({
  name: model.name,
  model_name: model.model_name,
  url: model.url,
  max_content_length: model.max_content_length,
  max_token: model.max_token,
  api_key: model.api_key,
  sort_index: model.sort_index,
  api_format: model.api_format,
  model_label_id: model.model_label_id,
  capabilities: model.capabilities,
  isLock: model.isLock,
  isDisable: model.isDisable,
  ...patch,
})

// 锁定/解锁：调用 PUT /:id/lock 切换 isLock 时间戳
//   isLock = 0 → 设为当前时间戳（锁定）
//   isLock > 0 → 设为 0（解锁）
export const handleToggleLock = async (id: number) => {
  const model = modelList.value.find((item) => item.id === id)
  if (!model) return
  const newLockValue = model.isLock > 0 ? 0 : Date.now()
  try {
    const res = await fetch(`/api/models/${id}/lock`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isLock: newLockValue }),
    }).then((r) => r.json())
    if (res.success) {
      ElMessage.success(model.isLock > 0 ? '已解锁' : '已锁定')
      fetchModels()
    }
  } catch {
    ElMessage.error('锁定状态更新失败')
  }
}

// 禁用/启用：切换 isDisable 值
export const handleToggleDisable = async (id: number) => {
  const model = modelList.value.find((item) => item.id === id)
  if (!model) return
  try {
    const res = await updateModel(id, buildModelForm(model, { isDisable: !model.isDisable }))
    if (res.success) {
      ElMessage.success(model.isDisable ? '已启用' : '已禁用')
      fetchModels()
    }
  } catch {
    ElMessage.error('状态更新失败')
  }
}

// ========== 删除模型 ==========
export const handleDelete = (id: number) => {
  ElMessageBox.confirm('确定要删除该模型吗？', '提示', { type: 'warning' })
    .then(async () => {
      try {
        const res = await deleteModel(id)
        if (res.success) {
          ElMessage.success('删除成功')
          if (selectedModelId.value === id) {
            selectedModelId.value = modelList.value[0]?.id ?? null
          }
          fetchModels()
        }
      } catch {
        // error
      }
    })
    .catch(() => {})
}

// ========== 拖拽排序后更新索引 ==========
export const handleReorder = async (newList: Model[]) => {
  // 更新本地排序
  modelList.value = newList
  // 更新索引：按照当前顺序设置新的 sort_index
  const items = newList.map((m, idx) => ({
    id: m.id,
    sort_index: idx,
  }))
  try {
    await reorderModels(items)
    ElMessage.success('排序已保存')
  } catch {
    ElMessage.error('排序保存失败')
    fetchModels() // 恢复原顺序
  }
}

// ========== 代理接口弹窗 ==========
export const apiDialogVisible = ref(false)
export const proxyBaseUrl = ref(`http://localhost:${window.location.port || 11888}`)
export const customApiKey = ref(localStorage.getItem('custom_api_key') || '')
export const proxyEndpoints = [
  { method: 'GET',  path: '/v1/models',              desc: '获取模型列表（OpenAI 兼容）' },
  { method: 'POST', path: '/v1/chat/completions',    desc: '聊天补全（Chat Completions / Anthropic Messages / Responses）' },
  { method: 'POST', path: '/v1/responses',           desc: 'Responses API（自动转为 Chat Completion 请求）' },
  { method: 'GET',  path: '/api/tags',               desc: '获取模型列表（Ollama 兼容）' },
  { method: 'POST', path: '/api/show',               desc: '获取模型详情（Ollama 兼容）' },
  { method: 'GET',  path: '/api/version',            desc: 'Ollama 版本信息' },
  { method: 'GET',  path: '/v1/test',    desc: '测试接口，支持 model 和 content 参数' },
]

// 用户名前缀的代理地址
export const userProxyBaseUrl = computed(() => {
  const username = localStorage.getItem('auth_username') || 'default'
  return `${proxyBaseUrl.value}/${username}`
})

// 生成随机 API Key
export const generateApiKey = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let key = 'sk-'
  for (let i = 0; i < 48; i++) {
    key += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  customApiKey.value = key
  localStorage.setItem('custom_api_key', key)
}

// 清除 API Key
export const clearApiKey = () => {
  customApiKey.value = ''
  localStorage.removeItem('custom_api_key')
}

// 复制带 API Key 的完整地址
export const copyEndpointWithKey = (path: string): string => {
  const baseUrl = userProxyBaseUrl.value
  const fullUrl = `${baseUrl}${path}`
  if (customApiKey.value) {
    return `${fullUrl}\nAuthorization: Bearer ${customApiKey.value}`
  }
  return fullUrl
}

export const openApiDialog = () => { apiDialogVisible.value = true }

// ========== 生命周期 ==========
export const onMountedCallback = async () => {
  // 优先从后端读取服务端口
  try {
    const res = await fetch('/api/config')
    const data = await res.json()
    if (data.port) {
      proxyBaseUrl.value = `http://localhost:${data.port}`
    }
  } catch {
    // 读取失败，保持默认端口
  }
  await fetchModels()
}
