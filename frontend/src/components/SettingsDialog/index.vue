<template>
  <el-dialog
    v-model="dialogVisible"
    title="设置"
    width="400px"
    :close-on-click-modal="false"
    @close="handleClose">
    <el-form
      ref="formRef"
      :model="formData"
      label-width="120px">
      <el-form-item label="最大内容长度">
        <el-input-number
          v-model="formData.max_content_length"
          :min="0"
          :max="10000000"
          controls-position="right"
          style="width: 100%" />
      </el-form-item>
      <el-form-item label="最大 Token">
        <el-input-number
          v-model="formData.max_token"
          :min="0"
          :max="10000000"
          controls-position="right"
          style="width: 100%" />
      </el-form-item>
      <el-form-item label="锁定时间(秒)">
        <el-input-number
          v-model="formData.lock_duration"
          :min="60"
          :max="86400"
          :step="60"
          controls-position="right"
          style="width: 100%" />
      </el-form-item>
      <el-form-item class="shuoming">
        <div class="settings-hint">
          <el-icon><InfoFilled /></el-icon>
          <span>设置说明：值为 0 时，各模型使用自身的配置数值；值大于 0 时，所有模型将统一使用此处设置的数值。</span>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="handleCancel">取消</el-button>
      <el-button
        type="primary"
        @click="handleSubmit"
        :loading="loading">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { ElMessage, type FormInstance } from 'element-plus'
import { InfoFilled } from '@element-plus/icons-vue'
import { getUserSettings, updateUserSettings, type UserSettings } from '@/api/userSettingsService'

defineOptions({ name: 'SettingsDialog' })

const dialogVisible = ref(false)
const loading = ref(false)
const formRef = ref<FormInstance>()

const formData = reactive<UserSettings>({
  max_content_length: 0,
  max_token: 0,
  lock_duration: 600,
})

// 加载设置
const loadSettings = async () => {
  try {
    const res = await getUserSettings()
    if (res.success && res.data) {
      formData.max_content_length = res.data.max_content_length
      formData.max_token = res.data.max_token
      formData.lock_duration = res.data.lock_duration || 600
    }
  } catch (e) {
    // ignore
  }
}

// 打开对话框
const openDialog = async () => {
  await loadSettings()
  dialogVisible.value = true
}

// 关闭对话框
const handleClose = () => {
  formRef.value?.resetFields()
}

// 取消
const handleCancel = () => {
  dialogVisible.value = false
}

// 提交
const handleSubmit = async () => {
  loading.value = true
  try {
    const res = await updateUserSettings({
      max_content_length: formData.max_content_length,
      max_token: formData.max_token,
      lock_duration: formData.lock_duration,
    })
    if (res.success) {
      ElMessage.success('设置已保存')
      dialogVisible.value = false
    }
  } finally {
    loading.value = false
  }
}

// 暴露方法给父组件
defineExpose({
  openDialog,
})
</script>

<style scoped lang="less">
.settings-hint {
  display: inline-flex;
  align-items: flex-start;
  gap: 8px;
  color: #909399;
  font-size: 13px;
  line-height: 1.5;
}

.settings-hint .el-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.shuoming {
  :deep(.el-form-item__content) {
    margin-left: 10px!important;
  }
}
</style>
