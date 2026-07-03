<template>
  <div class="model-card-wrap" :class="{ 'is-editing': isEditing }">
    <el-card
      :class="['model-card', { 'is-selected': isSelected }]"
      shadow="never">
      <!-- 点击卡片区域触发选中（除了编辑模式和操作按钮） -->
      <div class="card-content" @click="handleSelect">
      <!-- 显示模式 -->
      <template v-if="!isEditing">
        <!-- 操作按钮：单独一行，header 区域可拖拽 -->
        <div class="card-actions" title="拖拽排序" @click.stop>
          <el-checkbox
            class="card-checkbox"
            :model-value="checked"
            title="选择模型"
            @mousedown.stop
            @change="handleCheckChange" />
          <div class="card-action-buttons">
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

        <!-- 卡片主体 -->
        <div class="card-body">
          <!-- 标题（粗体，字体与下方模型名称一致） -->
          <div class="card-title">
            <span :title="model.name" class="card-title-text">{{ model.name }}</span>
            <el-button
              class="copy-label-btn"
              :icon="DocumentCopy"
              size="small"
              text
              title="复制 Label"
              @mousedown.stop
              @click="handleCopyLabel" />
          </div>
          <div class="card-row">
            <span class="card-label">模型名称:</span>
            <span class="card-value" :title="model.model_name">{{ model.model_name }}</span>
          </div>
          <div class="card-row">
            <span class="card-label">URL:</span>
            <span class="card-value card-value-url" :title="model.url">{{ model.url }}</span>
          </div>
          <div class="card-row">
            <span class="card-label">API Key:</span>
            <span class="card-value card-value-key">••••••••</span>
          </div>
          <div class="card-row">
            <span class="card-label">Max_Content:</span>
            <span class="card-value">{{ formatNumber(model.max_content_length) }}</span>
          </div>
          <div class="card-row">
            <span class="card-label">Max_Token:</span>
            <span class="card-value">{{ formatNumber(model.max_token) }}</span>
          </div>
          <div class="card-row card-row-stat">
            <span class="card-label">今日消耗:</span>
            <span class="card-value card-value-stat">{{ formatNumber(statSummary.todayToken) }}</span>
          </div>
          <div class="card-row card-row-stat">
            <span class="card-label">调用次数:</span>
            <span class="card-value card-value-stat">{{ formatNumber(statSummary.totalCallCount) }}</span>
          </div>
        </div>
      </template>

      <!-- 编辑模式 -->
      <template v-else>
        <el-form :model="editForm" label-width="90px" size="small" class="card-edit-form">
          <el-form-item label="显示名称">
            <el-input v-model="editForm.name" placeholder="请输入显示名称" />
          </el-form-item>
          <el-form-item label="模型名称">
            <el-input v-model="editForm.model_name" placeholder="请输入模型名称" />
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
          <el-form-item class="card-edit-form-actions">
            <el-button type="info" size="small" :icon="Close" @click="handleCancelEdit" plain>取消</el-button>
            <el-button type="success" size="small" :icon="Check" :loading="submitting" @click="handleSubmitEdit">提交</el-button>
          </el-form-item>
        </el-form>
      </template>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive } from 'vue'
import { ElMessage } from 'element-plus'
import { Edit, Delete, CopyDocument, Check, Close, Lock, Unlock, CircleClose, CircleCheck, DocumentCopy } from '@element-plus/icons-vue'
import type { Model, ModelForm } from '@/api/modelService'
import type { ModelCardProps, ModelCardEmits } from './index'

defineOptions({ name: 'ModelCard' })

const props = withDefaults(defineProps<ModelCardProps>(), {
  isSelected: false,
  checked: false,
})

const emit = defineEmits<ModelCardEmits>()

// ========== Token 统计摘要 ==========
const statSummary = computed(() => {
  return props.statSummary ?? { todayToken: 0, totalToken: 0 }
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
}>({
  name: '',
  model_name: '',
  url: '',
  api_key: '',
  max_content_length: 4096,
  max_token: 2048,
})

const handleEdit = () => {
  editForm.name = props.model.name
  editForm.model_name = props.model.model_name
  editForm.url = props.model.url
  editForm.api_key = props.model.api_key
  editForm.max_content_length = props.model.max_content_length
  editForm.max_token = props.model.max_token
  isEditing.value = true
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
      capabilities: props.model.capabilities,
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

// 复制模型 Label
const handleCopyLabel = () => {
  const text = props.model.name
  // 优先使用现代 Clipboard API，支持 http 协议
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

// 降级复制方法（支持 http 协议）
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

const formatNumber = (num: number): string => {
  if (!num) return '0'
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
</script>

<style lang="less">
@import './index.less';

// 覆盖 el-card 的 padding（仅 ModelCard 生效）
.model-card .el-card__body {
  padding: 0 !important;
}

.card-edit-form-actions {
  .el-form-item__content {
    justify-content: flex-end;
  }
}
</style>
