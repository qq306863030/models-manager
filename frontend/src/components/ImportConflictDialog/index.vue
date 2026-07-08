<template>
  <el-dialog
    v-model="visible"
    title="导入冲突"
    width="420px"
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :before-close="handleBeforeClose">
    <div class="conflict-content" v-if="data">
      <div class="conflict-info">
        <span class="conflict-label">第 {{ data.current }} / {{ data.total }} 条</span>
        <span class="conflict-name">{{ data.modelName }}</span>
        <span class="conflict-hint">已存在，是否覆盖？</span>
      </div>
    </div>
    <template #footer>
      <div class="conflict-footer">
        <el-checkbox v-model="applyToAll" class="conflict-checkbox">
          后续冲突均按此操作执行
        </el-checkbox>
        <div class="conflict-actions">
          <el-button size="small" @click="handleCancel">取消</el-button>
          <el-button size="small" @click="handleSkip">跳过</el-button>
          <el-button size="small" type="primary" @click="handleOverwrite">覆盖</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import type { ImportConflictDialogEmits, ImportConflictData } from './index'

defineOptions({ name: 'ImportConflictDialog' })

const emit = defineEmits<ImportConflictDialogEmits>()

const visible = ref(false)
const data = ref<ImportConflictData | null>(null)
const applyToAll = ref(false)

const open = (conflictData: ImportConflictData) => {
  data.value = conflictData
  applyToAll.value = false
  visible.value = true
}

const handleCancel = () => {
  visible.value = false
  emit('resolve', 'cancel')
}

const handleBeforeClose = (done: () => void) => {
  done()
  emit('resolve', 'cancel')
}

const handleSkip = () => {
  visible.value = false
  emit('resolve', applyToAll.value ? 'all-skip' : 'skip')
}

const handleOverwrite = () => {
  visible.value = false
  emit('resolve', applyToAll.value ? 'all-overwrite' : 'overwrite')
}

defineExpose({ open })
</script>

<style scoped lang="less">
.conflict-content {
  padding: 8px 0;
}

.conflict-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: #606266;
  line-height: 1.6;
}

.conflict-label {
  color: #909399;
  flex-shrink: 0;
}

.conflict-name {
  font-weight: 600;
  color: #303133;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conflict-hint {
  flex-shrink: 0;
}

.conflict-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.conflict-checkbox {
  :deep(.el-checkbox__label) {
    font-size: 12px;
    color: #909399;
  }
}

.conflict-actions {
  display: flex;
  gap: 6px;

  :deep(.el-button) {
    margin-left: 0 !important;
  }
}
</style>
