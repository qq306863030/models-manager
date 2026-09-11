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
        class="error-log-item"
        @click="openDetail(entry)">
        <div class="log-item-header">
          <el-tag :type="getErrorTagType(entry.errorType)" size="small" round>
            {{ getErrorTypeLabel(entry.errorType) }}
          </el-tag>
          <span class="log-model-name">{{ entry.modelName }}</span>
          <span class="log-time">{{ formatTime(entry.timestamp) }}</span>
        </div>
        <div class="log-item-message">{{ entry.message }}</div>
        <div class="log-item-tip">
          <el-icon><ArrowRight /></el-icon>
        </div>
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

  <!-- 错误详情弹窗 -->
  <el-dialog
    v-model="detailVisible"
    :title="'错误详情 - ' + (activeEntry?.modelName || '')"
    width="680px"
    top="10vh"
    append-to-body
    :close-on-click-modal="false">
    <div v-if="activeEntry" class="error-detail-body">
      <div class="overview-grid">
        <div class="overview-cell">
          <span class="label">错误类型:</span>
          <el-tag :type="getErrorTagType(activeEntry.errorType)" size="small" round>
            {{ getErrorTypeLabel(activeEntry.errorType) }} ({{ activeEntry.errorType }})
          </el-tag>
        </div>
        <div class="overview-cell">
          <span class="label">关联模型:</span>
          <span class="value font-bold">{{ activeEntry.modelName }}</span>
        </div>
        <div class="overview-cell">
          <span class="label">模型 ID:</span>
          <span class="value code-font">{{ activeEntry.modelId }}</span>
        </div>
        <div class="overview-cell">
          <span class="label">发生时间:</span>
          <span class="value">{{ activeEntry.timestamp }}</span>
        </div>
      </div>

      <div class="section-header">
        <span class="section-title">详细错误信息</span>
        <el-button size="small" type="primary" link @click="copyText(activeEntry.message)">
          <el-icon><CopyDocument /></el-icon>
          复制内容
        </el-button>
      </div>

      <div class="code-container">
        <pre class="error-pre">{{ activeEntry.message }}</pre>
      </div>
    </div>
    <template #footer>
      <el-button @click="detailVisible = false">关闭</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { ElMessage } from 'element-plus'
import { ArrowRight, CopyDocument } from '@element-plus/icons-vue'
import { useErrorLog, type ErrorLogEntry } from '@/composables/useErrorLog'

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

// 详情弹窗
const detailVisible = ref(false)
const activeEntry = ref<ErrorLogEntry | null>(null)

const openDetail = (entry: ErrorLogEntry) => {
  activeEntry.value = entry
  detailVisible.value = true
}

import { copyToClipboard } from '../../utils/clipboard'

const copyText = async (text?: string) => {
  if (!text) return
  const success = await copyToClipboard(text)
  if (success) {
    ElMessage.success('已复制到剪贴板')
  } else {
    ElMessage.error('复制失败，请手动选择复制')
  }
}

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
:deep(.el-drawer__body) {
  display: flex;
  flex-direction: column;
}

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
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.error-log-item {
  position: relative;
  padding: 12px;
  border-bottom: 1px solid #f0f0f0;
  cursor: pointer;
  transition: all 0.2s;

  &:hover {
    background: #fdf6ec;

    .log-item-tip {
      opacity: 1;
      transform: translateX(0);
    }
  }

  &:last-child {
    border-bottom: none;
  }
}

.log-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;

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
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.log-item-tip {
  position: absolute;
  right: 8px;
  bottom: 8px;
  font-size: 12px;
  color: #e6a23c;
  opacity: 0;
  transform: translateX(-4px);
  transition: all 0.2s ease;
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
}

// 错误详情弹窗样式
.error-detail-body {
  max-height: 60vh;
  overflow-y: auto;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px 16px;
  background: #fdf6ec;
  border: 1px solid #faecd8;
  padding: 14px;
  border-radius: 8px;
  margin-bottom: 16px;

  .overview-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;

    .label {
      color: #909399;
      font-weight: 500;
      min-width: 70px;
    }

    .value {
      color: #303133;
    }

    .font-bold {
      font-weight: 600;
    }

    .code-font {
      font-family: monospace;
    }
  }
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: #303133;
  }
}

.code-container {
  background: #1e1e1e;
  border-radius: 6px;
  padding: 12px;
  max-height: 300px;
  overflow: auto;

  .error-pre {
    margin: 0;
    font-family: Consolas, Monaco, monospace;
    font-size: 12px;
    line-height: 1.5;
    color: #f89898;
    white-space: pre-wrap;
    word-break: break-all;
  }
}
</style>
