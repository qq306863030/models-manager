<template>
  <div class="model-row-wrap" :class="{ 'is-editing': isEditing }">
    <!-- 显示模式 -->
    <template v-if="!isEditing">
      <div class="model-row" :class="{ 'is-selected': isSelected }" @click="handleSelect">
        <!-- 拖拽手柄 -->
        <div class="row-cell cell-drag row-drag-handle" title="拖拽排序" @click.stop>
          <el-icon :size="14"><Rank /></el-icon>
        </div>

        <!-- 复选框 -->
        <div class="row-cell cell-checkbox" @click.stop>
          <el-checkbox
            :model-value="checked"
            title="选择模型"
            @mousedown.stop
            @change="handleCheckChange" />
        </div>

        <!-- 模型名称 -->
        <div class="row-cell cell-name" @click.stop>
          <el-button
            class="copy-name-btn"
            :icon="CopyDocument"
            size="small"
            text
            title="复制模型名称"
            @mousedown.stop
            @click="handleCopyLabel" />
          <span class="cell-text" :title="model.name">{{ model.name }}</span>
        </div>

        <!-- 模型ID -->
        <div class="row-cell cell-model-name">
          <span class="cell-text" :title="model.model_name">{{ model.model_name }}</span>
        </div>

        <!-- URL -->
        <div class="row-cell cell-url" @click.stop>
          <el-button
            class="copy-url-btn"
            :icon="CopyDocument"
            size="small"
            text
            title="复制 URL"
            @mousedown.stop
            @click="handleCopyUrl" />
          <span class="cell-text cell-text-url" :title="model.url">{{ model.url }}</span>
        </div>

        <!-- 能力 -->
        <div class="row-cell cell-capabilities">
          <el-tag
            v-for="cap in model.capabilities"
            :key="cap"
            size="small"
            type="info"
            class="capability-tag">
            {{ getCapabilityLabel(cap) }}
          </el-tag>
        </div>

        <!-- 今日消耗 -->
        <div class="row-cell cell-consume">
          <span class="cell-text cell-text-stat">{{ formatNumber(statSummary.todayToken) }}</span>
        </div>

        <!-- 调用次数 -->
        <div class="row-cell cell-call-count">
          <span class="cell-text cell-text-stat">{{ formatNumber(statSummary.todayCallCount) }}</span>
        </div>

        <!-- 状态 -->
        <div class="row-cell cell-status" @click.stop>
          <el-button
            class="state-btn lock-btn"
            :class="{ 'is-active': model.isLock > 0 }"
            size="small"
            :icon="model.isLock > 0 ? Lock : Unlock"
            circle
            :title="model.isLock > 0 ? '已锁定，点击解锁' : '未锁定，点击锁定'"
            @mousedown.stop
            @click="handleToggleLock" />
          <el-button
            class="state-btn disable-btn"
            :class="{ 'is-active': model.isDisable }"
            size="small"
            :icon="model.isDisable ? CircleClose : CircleCheck"
            circle
            :title="model.isDisable ? '已禁用，点击启用' : '已启用，点击禁用'"
            @mousedown.stop
            @click="handleToggleDisable" />
          <el-button
            class="state-btn test-btn"
            :type="testStatus === 'success' ? 'success' : testStatus === 'error' ? 'danger' : 'info'"
            size="small"
            :icon="testStatus === 'success' ? CircleCheck : testStatus === 'error' ? CircleClose : VideoPlay"
            circle
            :loading="testing"
            title="测试连接"
            @mousedown.stop
            @click="handleTest" />
        </div>

        <!-- 操作按钮 -->
        <div class="row-cell cell-actions" @click.stop>
          <el-button
            type="default"
            size="small"
            :icon="CopyDocument"
            circle
            title="复制"
            @mousedown.stop
            @click="handleCopy" />
          <el-button
            type="primary"
            size="small"
            :icon="Edit"
            circle
            title="编辑"
            @mousedown.stop
            @click="handleEdit" />
          <el-button
            type="danger"
            size="small"
            :icon="Delete"
            circle
            title="删除"
            @mousedown.stop
            @click="handleDelete" />
        </div>
      </div>
    </template>

    <!-- 编辑模式 -->
    <template v-else>
      <div class="model-row model-row-edit">
        <el-form :model="editForm" label-width="90px" size="small" class="card-edit-form">
          <div class="edit-form-grid">
            <el-form-item label="模型名称">
              <el-input v-model="editForm.name" placeholder="请输入模型名称" />
            </el-form-item>
            <el-form-item label="模型ID">
              <el-input v-model="editForm.model_name" placeholder="请输入模型ID" />
            </el-form-item>
            <el-form-item label="URL">
              <el-input v-model="editForm.url" placeholder="请输入URL" />
            </el-form-item>
            <el-form-item label="API Key">
              <el-input v-model="editForm.api_key" placeholder="请输入API Key" show-password />
            </el-form-item>
            <el-form-item label="Max_Content">
              <el-input-number v-model="editForm.max_content_length" :min="1" :max="1000000" controls-position="right" />
            </el-form-item>
            <el-form-item label="Max_Token">
              <el-input-number v-model="editForm.max_token" :min="1" :max="1000000" controls-position="right" />
            </el-form-item>
            <el-form-item label="模态能力">
              <el-select
                v-model="editForm.capabilities"
                multiple
                style="width: 100%">
                <el-option
                  v-for="opt in CAPABILITIES_OPTIONS"
                  :key="opt.value"
                  :label="opt.label"
                  :value="opt.value" />
              </el-select>
            </el-form-item>
          </div>
          <div class="edit-form-actions">
            <el-button type="info" size="small" :icon="Close" @click="handleCancelEdit" plain>取消</el-button>
            <el-button type="success" size="small" :icon="Check" :loading="submitting" @click="handleSubmitEdit">提交</el-button>
          </div>
        </el-form>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { Edit, Delete, CopyDocument, Check, Close, Lock, Unlock, CircleClose, CircleCheck, DocumentCopy, Rank, VideoPlay } from '@element-plus/icons-vue'
import type { Model, ModelForm } from '@/api/modelService'
import { CAPABILITIES_OPTIONS } from '@/types/enum'
import type { ModelCardProps, ModelCardEmits } from './index'

defineOptions({ name: 'ModelCard' })

const props = withDefaults(defineProps<ModelCardProps>(), {
  isSelected: false,
  checked: false,
})

const emit = defineEmits<ModelCardEmits>()

// ========== Token 统计摘要 ==========
const statSummary = computed(() => {
  return props.statSummary ?? { todayToken: 0, totalToken: 0, totalCallCount: 0, todayCallCount: 0 }
})

// ========== 编辑模式 ==========
const isEditing = ref(false)
const submitting = ref(false)

const editForm = reactive<{
  name: string
  model_name: string
  url: string
  api_key: string
  max_content_length: number
  max_token: number
  capabilities: string[]
}>({
  name: '',
  model_name: '',
  url: '',
  api_key: '',
  max_content_length: 4096,
  max_token: 2048,
  capabilities: ["completion", "tools", "thinking"],
})

const handleEdit = () => {
  emit('edit', props.model)
}

const handleCancelEdit = () => {
  isEditing.value = false
}

const handleSubmitEdit = async () => {
  if (!editForm.name?.trim()) {
    ElMessage.warning('显示名称不能为空')
    return
  }
  if (!editForm.model_name?.trim()) {
    ElMessage.warning('模型名称不能为空')
    return
  }
  if (!editForm.url?.trim()) {
    ElMessage.warning('URL不能为空')
    return
  }
  if (!editForm.api_key?.trim()) {
    ElMessage.warning('API Key不能为空')
    return
  }

  submitting.value = true
  try {
    const data: ModelForm = {
      name: editForm.name.trim(),
      model_name: editForm.model_name.trim(),
      url: editForm.url.trim(),
      api_key: editForm.api_key.trim(),
      max_content_length: editForm.max_content_length,
      max_token: editForm.max_token,
      sort_index: props.model.sort_index,
      api_format: props.model.api_format,
      model_label_id: props.model.model_label_id,
      capabilities: editForm.capabilities,
      isLock: props.model.isLock,
      isDisable: props.model.isDisable,
    }
    emit('submit-edit', props.model.id, data)
    isEditing.value = false
  } finally {
    submitting.value = false
  }
}

const handleSelect = () => {
  if (!isEditing.value) {
    emit('select', props.model.id)
  }
}

const handleCopy = () => {
  emit('copy', props.model.id)
}

const handleCheckChange = (checked: string | number | boolean) => {
  emit('check-change', props.model.id, Boolean(checked))
}

const handleDelete = () => {
  emit('delete', props.model.id)
}

const handleToggleLock = () => {
  emit('toggle-lock', props.model.id)
}

const handleToggleDisable = () => {
  emit('toggle-disable', props.model.id)
}

// ========== 测试连接 ==========
const testing = ref(false)
const testStatus = ref<'idle' | 'success' | 'error'>('idle')

const handleTest = async () => {
  if (testing.value) return
  testing.value = true
  testStatus.value = 'idle'
  try {
    const username = localStorage.getItem('auth_username') || ''
    const url = `/${username}/v1/test?model=${encodeURIComponent(props.model.name)}`
    const headers: Record<string, string> = {}
    // 如果有自定义 API Key，携带它
    const apiKey = localStorage.getItem('custom_api_key')
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`
    }
    const response = await fetch(url, { headers })
    if (response.ok) {
      testStatus.value = 'success'
      ElMessage.success('连接成功')
    } else {
      const data = await response.json().catch(() => ({}))
      testStatus.value = 'error'
      ElMessage.error(`连接失败: ${data.error?.message || response.statusText}`)
    }
  } catch (err: any) {
    testStatus.value = 'error'
    ElMessage.error(`连接失败: ${err.message}`)
  } finally {
    testing.value = false
    setTimeout(() => { testStatus.value = 'idle' }, 3000)
  }
}

// 复制 URL
const handleCopyUrl = () => {
  const text = props.model.url
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      ElMessage.success('URL 已复制')
    }).catch(() => {
      fallbackCopy(text)
    })
  } else {
    fallbackCopy(text)
  }
}

// 复制模型 Label
const handleCopyLabel = () => {
  const text = props.model.name
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      ElMessage.success('模型名称已复制')
    }).catch(() => {
      fallbackCopy(text)
    })
  } else {
    fallbackCopy(text)
  }
}

const fallbackCopy = (text: string) => {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    document.execCommand('copy')
    ElMessage.success('模型名称已复制')
  } catch {
    ElMessage.error('复制失败')
  }
  document.body.removeChild(textarea)
}

const getCapabilityLabel = (cap: string): string => {
  const option = CAPABILITIES_OPTIONS.find(o => o.value === cap)
  return option?.label ?? cap
}

const formatNumber = (num: number): string => {
  if (!num) return '0'
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
</script>

<style lang="less">
@import './index.less';

.card-edit-form-actions {
  .el-form-item__content {
    justify-content: flex-end;
  }
}
</style>
