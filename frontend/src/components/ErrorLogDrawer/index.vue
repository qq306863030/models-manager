<template>
  <el-drawer
    v-model="visible"
    title="运行日志"
    direction="rtl"
    size="420px"
    :before-close="handleClose">
    <template #header>
      <div class="drawer-header">
        <span class="drawer-title">运行日志</span>
        <el-tag v-if="errorLogs.length > 0" type="danger" size="small" round>
          {{ errorLogs.length }}
        </el-tag>
      </div>
    </template>

    <div class="error-log-container" ref="listRef">
      <el-empty v-if="errorLogs.length === 0" description="暂无错误日志" :image-size="80" />

      <div
        v-for="(entry, index) in reversedLogs"
        :key="index"
        class="error-log-item">
        <div class="log-item-header">
          <el-tag :type="getErrorTagType(entry.errorType)" size="small" round>
            {{ getErrorTypeLabel(entry.errorType) }}
          </el-tag>
          <span class="log-model-name">{{ entry.modelName }}</span>
          <span class="log-time">{{ formatTime(entry.timestamp) }}</span>
        </div>
        <div class="log-item-message">{{ entry.message }}</div>
      </div>
    </div>

    <template #footer>
      <div class="drawer-footer">
        <el-button size="small" @click="clearLogs" :disabled="errorLogs.length === 0">
          清空日志
        </el-button>
      </div>
    </template>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useErrorLog } from '@/composables/useErrorLog'

const props = defineProps<{
  visible: boolean
}>()

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

const visible = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val),
})

const { errorLogs, clearLogs } = useErrorLog()
const listRef = ref<HTMLElement>()

// 倒序显示（最新在上）
const reversedLogs = computed(() => [...errorLogs.value].reverse())

// 自动滚动到底部（当有新消息且 drawer 打开时）
watch(
  () => errorLogs.value.length,
  async () => {
    if (visible.value) {
      await nextTick()
      if (listRef.value) {
        listRef.value.scrollTop = 0
      }
    }
  }
)

const handleClose = () => {
  emit('update:visible', false)
}

const formatTime = (iso: string): string => {
  try {
    const d = new Date(iso)
    const h = String(d.getHours()).padStart(2, '0')
    const m = String(d.getMinutes()).padStart(2, '0')
    const s = String(d.getSeconds()).padStart(2, '0')
    return `${h}:${m}:${s}`
  } catch {
    return iso
  }
}

const getErrorTagType = (errorType: string): 'danger' | 'warning' | 'info' => {
  if (errorType.includes('timeout')) return 'warning'
  if (errorType.includes('upstream')) return 'danger'
  return 'info'
}

const getErrorTypeLabel = (errorType: string): string => {
  const map: Record<string, string> = {
    upstream_error: '上游错误',
    timeout_error: '超时',
    chat_stream_error: '流式错误',
    responses_stream_error: '流式错误',
    anthropic_stream_error: '流式错误',
  }
  return map[errorType] || errorType
}
</script>

<style scoped lang="less">
.drawer-header {
  display: flex;
  align-items: center;
  gap: 8px;

  .drawer-title {
    font-size: 16px;
    font-weight: 600;
    color: #303133;
  }
}

.error-log-container {
  height: calc(100vh - 160px);
  overflow-y: auto;
  padding: 0;
}

.error-log-item {
  padding: 10px 12px;
  border-bottom: 1px solid #f0f0f0;
  transition: background 0.2s;

  &:hover {
    background: #fafafa;
  }

  &:last-child {
    border-bottom: none;
  }
}

.log-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;

  .log-model-name {
    font-size: 12px;
    font-weight: 600;
    color: #303133;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .log-time {
    font-size: 11px;
    color: #909399;
    margin-left: auto;
    flex-shrink: 0;
  }
}

.log-item-message {
  font-size: 12px;
  color: #606266;
  line-height: 1.5;
  word-break: break-all;
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
}
</style>
