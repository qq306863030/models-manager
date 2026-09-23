<template>
  <el-dialog
    v-model="dialogVisible"
    title="编辑模型"
    width="600px"
    @close="handleClose">
    <el-form
      ref="formRef"
      :model="formData"
      :rules="formRules"
      label-width="120px">
      <el-form-item label="模型名称" prop="name">
        <el-input v-model="formData.name" placeholder="请输入模型名称" />
      </el-form-item>
      <el-form-item label="模型ID" prop="model_name">
        <el-select
          v-model="formData.model_name"
          placeholder="请搜索或选择模型"
          filterable
          clearable
          allow-create
          default-first-option
          style="width: 100%"
          @change="handleModelNameChange"
          @blur="handleModelNameBlur">
          <el-option
            v-for="opt in allModelOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="接口地址" prop="url">
        <el-input v-model="formData.url" placeholder="请输入接口地址" />
      </el-form-item>
      <el-form-item label="API Key" prop="api_key">
        <el-input
          v-model="formData.api_key"
          placeholder="请输入 API Key"
          show-password />
      </el-form-item>
      <el-form-item label="API 格式" prop="api_format">
        <el-select
          v-model="formData.api_format"
          placeholder="请选择 API 格式"
          style="width: 100%">
          <el-option
            v-for="opt in API_FORMAT_OPTIONS"
            :key="opt.value"
            :value="opt.value"
            :label="opt.label" />
        </el-select>
      </el-form-item>
      <el-form-item label="最大内容长度">
        <el-input-number
          v-model="formData.max_content_length"
          :min="1"
          :max="10000000"
          controls-position="right"
          style="width: 100%" />
      </el-form-item>
      <el-form-item label="最大 Token">
        <el-input-number
          v-model="formData.max_token"
          :min="1"
          :max="10000000"
          controls-position="right"
          style="width: 100%" />
      </el-form-item>
      <el-form-item label="模态能力">
        <el-select
          v-model="formData.capabilities"
          multiple
          placeholder="请选择模态能力"
          style="width: 100%">
          <el-option
            v-for="opt in CAPABILITIES_OPTIONS"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value" />
        </el-select>
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="handleCancel">取消</el-button>
      <el-button
        type="primary"
        @click="handleSubmit"
        :loading="submitLoading"
        >确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import type { Model, ModelForm } from '@/api/modelService'
import { getLlmModels, type LlmCompany, type LlmModelItem } from '@/api/llmService'
import type { EditFormData, EditModelDialogEmits } from './index'
import { API_FORMAT_OPTIONS, CAPABILITIES_OPTIONS } from '@/types/enum'
import { useAllModels } from '@/composables/useAllModels'

defineOptions({
  name: 'EditModelDialog',
})

const emit = defineEmits<EditModelDialogEmits>()

// 对话框状态
const dialogVisible = ref(false)
const submitLoading = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

// 从 models.json 获取所有模型数据与配置映射
const { allModelOptions, modelDataMap, loadAllModels } = useAllModels()

onMounted(() => {
  loadAllModels()
})

// 表单数据
const formData = reactive<EditFormData>({
  name: '',
  model_name: '',
  url: '',
  api_key: '',
  max_content_length: 4096,
  max_token: 2048,
  sort_index: 0,
  api_format: 1,
  model_label_id: null,
  capabilities: ['completion', 'tools', 'thinking'],
})

// 表单验证规则
const formRules: FormRules = {
  name: [{ required: true, message: '请输入模型名称', trigger: 'blur' }],
  model_name: [{ required: true, message: '请输入模型ID', trigger: ['blur', 'change'] }],
  url: [{ required: true, message: '请输入接口地址', trigger: 'blur' }],
  api_key: [{ required: true, message: '请输入 API Key', trigger: 'blur' }],
}

// 模型ID变化时，匹配成功后自动填表（最大内容长度、最大 Token、模态能力）
const handleModelNameChange = (modelName: string) => {
  if (!modelName?.trim()) return

  const modelData = modelDataMap.value.get(modelName.trim())
  if (modelData) {
    formData.max_content_length = Number(modelData.content_length) || 200000
    formData.max_token = Number(modelData.max_token) || 64000
    if (modelData.capabilities?.length) {
      formData.capabilities = [...modelData.capabilities]
    }
  }
}

// 处理模型名称输入框失焦（支持自定义输入）
const handleModelNameBlur = (event: FocusEvent) => {
  const target = event.target as HTMLInputElement
  const inputValue = target.value?.trim()
  if (inputValue && !formData.model_name?.trim()) {
    formData.model_name = inputValue
    handleModelNameChange(inputValue)
  }
}

// 打开对话框并填充数据
const openDialog = (model: Model) => {
  loadAllModels()
  editingId.value = model.id
  Object.assign(formData, {
    name: model.name,
    model_name: model.model_name,
    url: model.url,
    api_key: model.api_key,
    max_content_length: model.max_content_length,
    max_token: model.max_token,
    sort_index: model.sort_index,
    api_format: model.api_format ?? 1,
    model_label_id: model.model_label_id ?? null,
    capabilities: model.capabilities ?? ['completion', 'tools', 'thinking'],
  })
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
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return

  if (editingId.value === null) return

  submitLoading.value = true
  try {
    const data: ModelForm = {
      name: formData.name,
      model_name: formData.model_name,
      url: formData.url,
      api_key: formData.api_key,
      max_content_length: formData.max_content_length,
      max_token: formData.max_token,
      sort_index: formData.sort_index,
      api_format: formData.api_format,
      model_label_id: formData.model_label_id,
      capabilities: formData.capabilities,
    }

    emit('submit', editingId.value, data)
    dialogVisible.value = false
  } finally {
    submitLoading.value = false
  }
}

// 暴露方法给父组件
defineExpose({
  openDialog,
})
</script>

<style lang="less" scoped>
@import './index.less';
</style>