<template>
  <el-dialog
    v-model="dialogVisible"
    :title="dialogTitle"
    width="1100px"
    :close-on-click-modal="false"
    @close="handleClose">
    <el-form
      ref="formRef"
      :model="formData"
      :rules="formRules"
      label-width="100px">
      <!-- 供应商下拉 -->
      <el-form-item label="供应商" prop="vendor">
        <el-select
          v-model="formData.vendor"
          placeholder="请选择供应商"
          style="width: 100%"
          @change="handleVendorChange">
          <el-option
            v-for="opt in vendorOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value" />
          <el-option value="custom" label="自定义" />
        </el-select>
      </el-form-item>

      <!-- 名称前缀（非必填） -->
      <el-form-item label="名称">
        <el-input
          v-model="formData.name"
          placeholder="请输入名称前缀（可选，将与显示名称/模型名称合并）" />
      </el-form-item>

      <el-form-item label="Base URL" prop="url">
        <el-input
          v-model="formData.url"
          placeholder="例如：http://localhost:11438/v1" />
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
    </el-form>

    <!-- 模型列表 -->
    <div class="model-list-section">
      <div class="model-list-header">
        <span class="model-list-title">模型列表</span>
        <el-button
          type="primary"
          size="small"
          @click="addModelRow">
          <el-icon><Plus /></el-icon>添加
        </el-button>
      </div>

      <!-- 表头 -->
      <div class="model-row model-row-header">
        <span class="header-label">模型名称</span>
        <span class="header-label">显示名称</span>
        <span class="header-label">最大内容长度</span>
        <span class="header-label">最大 Token</span>
        <span class="header-label">模态能力</span>
        <span class="header-label">操作</span>
      </div>

      <!-- 数据行 -->
      <div
        v-for="(row, idx) in formData.rows"
        :key="row.key"
        class="model-row">
        <!-- 模型名称：下拉搜索框 -->
        <el-select
          v-model="row.model_name"
          placeholder="请搜索或选择模型"
          filterable
          clearable
          allow-create
          default-first-option
          style="width: 100%"
          @change="(val) => handleModelNameChange(val, row)"
          @blur="(e) => handleModelNameBlur(e, row)">
          <el-option
            v-for="opt in allModelOptions"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value" />
        </el-select>

        <!-- 显示名称：输入框，显示 [名称]_[模型名称] -->
        <el-input
          v-model="row.model_label"
          :placeholder="getDefaultLabel(row)"
          @focus="handleLabelFocus(row)"
          @blur="handleLabelBlur(row)" />

        <el-input-number
          v-model="row.max_content_length"
          :min="1"
          :max="1000000"
          controls-position="right"
          class="row-number" />
        <el-input-number
          v-model="row.max_token"
          :min="1"
          :max="1000000"
          controls-position="right"
          class="row-number" />
        <el-select
          v-model="row.capabilities"
          multiple
          collapse-tags
          collapse-tags-tooltip
          placeholder="请选择"
          class="row-select row-capabilities">
          <el-option
            v-for="opt in CAPABILITIES_OPTIONS"
            :key="opt.value"
            :label="opt.label"
            :value="opt.value" />
        </el-select>
        <div class="row-actions">
          <el-button
            type="danger"
            size="small"
            :disabled="formData.rows.length <= 1"
            @click="removeModelRow(idx)">
            <el-icon><Delete /></el-icon>
          </el-button>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="handleCancel">取消</el-button>
      <el-button
        type="primary"
        @click="handleSubmit"
        :loading="submitLoading">提交</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, watchEffect } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Plus, Delete } from '@element-plus/icons-vue'
import type { ModelRowForm } from '@/api/modelService'
import { getModels } from '@/api/modelService'
import type { AddFormData, AddFormRow, ModelLabelOption, AddModelDialogEmits } from './index'
import { API_FORMAT_OPTIONS, CAPABILITIES_OPTIONS, DEFAULT_CAPABILITIES } from '@/types/enum'
import { getLlmModels, type LlmCompany } from '@/api/llmService'

defineOptions({ name: 'AddModelDialog' })

const props = withDefaults(
  defineProps<{
    modelLabelOptions?: ModelLabelOption[];
  }>(),
  { modelLabelOptions: () => [] },
)

const emit = defineEmits<AddModelDialogEmits>()

// 对话框状态
const dialogVisible = ref(false)
const dialogTitle = ref('添加模型')
const submitLoading = ref(false)
const formRef = ref<FormInstance>()

// LLM 配置数据
const llmCompanies = ref<LlmCompany[]>([])

// 供应商下拉选项
const vendorOptions = computed(() =>
  llmCompanies.value.map((c) => ({
    value: c.llmCompany,
    label: c.llmCompany,
  })),
)

// 所有模型去重列表（用于模型名称下拉）
const allModelOptions = computed(() => {
  const seen = new Set<string>()
  const options: { value: string; label: string }[] = []
  for (const company of llmCompanies.value) {
    for (const m of company.models) {
      if (!seen.has(m.model)) {
        seen.add(m.model)
        options.push({ value: m.model, label: m.model })
      }
    }
  }
  return options
})

// 模型名称 → 配置数据映射
const modelDataMap = computed(() => {
  const map = new Map<string, LlmCompany['models'][number]>()
  for (const company of llmCompanies.value) {
    for (const m of company.models) {
      if (!map.has(m.model)) {
        map.set(m.model, m)
      }
    }
  }
  return map
})

// 行数据 key 计数器
let rowKeyCounter = 0

// 创建空行
const createEmptyRow = (): AddFormRow => ({
  key: ++rowKeyCounter,
  model_label_id: null,
  model_label: '',
  model_name: '',
  max_content_length: 200000,
  max_token: 64000,
  capabilities: [...DEFAULT_CAPABILITIES],
})

// 从 llm-data.json 创建行
const createRowFromLlmModel = (item: LlmCompany['models'][number]): AddFormRow => ({
  key: ++rowKeyCounter,
  model_label_id: null,
  model_label: '',
  model_name: item.model,
  max_content_length: Number(item.content_length) || 4096,
  max_token: Number(item.max_token) || 2048,
  capabilities: item.capabilities?.length ? [...item.capabilities] : [...DEFAULT_CAPABILITIES],
})

// 获取默认 Label 显示值
const getDefaultLabel = (row: AddFormRow): string => {
  const prefix = formData.name?.trim()
  const modelName = row.model_name?.trim()
  if (prefix && modelName) return `${prefix}_${modelName}`
  if (modelName) return modelName
  return '请输入显示名称'
}

// Label 获得焦点时：如果当前为空且有模型名，自动填入默认值
const handleLabelFocus = (row: AddFormRow) => {
  if (!row.model_label?.trim() && row.model_name?.trim()) {
    row.model_label = getDefaultLabel(row)
  }
}

// Label 失去焦点时：如果未修改，清空（让用户手动输入）
const handleLabelBlur = (row: AddFormRow) => {
  const defaultVal = getDefaultLabel(row)
  if (row.model_label === defaultVal) {
    // 用户未修改，保持原样
  }
}

// 模型名称选中/输入时，自动填充其他字段
const handleModelNameChange = (modelName: string, row: AddFormRow) => {
  if (!modelName?.trim()) {
    // 清空时恢复默认值
    row.max_content_length = 200000
    row.max_token = 64000
    row.capabilities = [...DEFAULT_CAPABILITIES]
    row.model_label = ''
    return
  }

  const modelData = modelDataMap.value.get(modelName.trim())
  if (modelData) {
    // 从 llm-data.json 匹配到数据，自动填充
    row.max_content_length = Number(modelData.content_length) || 200000
    row.max_token = Number(modelData.max_token) || 64000
    row.capabilities = modelData.capabilities?.length
      ? [...modelData.capabilities]
      : [...DEFAULT_CAPABILITIES]
  } else {
    // 自定义输入时使用默认值
    row.max_content_length = 200000
    row.max_token = 64000
    row.capabilities = [...DEFAULT_CAPABILITIES]
  }
  // 更新 model_label 默认值
  row.model_label = getDefaultLabel(row)
}

// 处理模型名称输入框失焦（支持自定义输入）
const handleModelNameBlur = (event: FocusEvent, row: AddFormRow) => {
  const target = event.target as HTMLInputElement
  const inputValue = target.value?.trim()
  // 如果输入了值但没有匹配到选项，保持输入的值
  if (inputValue && !row.model_name?.trim()) {
    row.model_name = inputValue
    row.model_label = getDefaultLabel(row)
  }
}

// 表单数据
const formData = reactive<AddFormData>({
  vendor: 'custom',
  name: '',
  url: '',
  api_key: '',
  api_format: 1,
  rows: [createEmptyRow()],
})

// 监听 name 变化，更新所有行的显示名称
watchEffect(() => {
  const prefix = formData.name?.trim() || ''
  for (const row of formData.rows) {
    row.model_label = prefix
      ? `${prefix}_${row.model_name?.trim() || ''}`
      : row.model_name?.trim() || ''
  }
})

// 表单验证规则
const formRules: FormRules = {
  vendor: [{ required: true, message: '请选择供应商', trigger: 'change' }],
  url: [{ required: true, message: '请输入 Base URL', trigger: 'blur' }],
  api_key: [{ required: true, message: '请输入 API Key', trigger: 'blur' }],
  api_format: [{ required: true, message: '请选择 API 格式', trigger: 'change' }],
}

// 切换供应商
const handleVendorChange = (vendor: string) => {
  if (vendor === 'custom') {
    formData.name = ''
    formData.url = ''
    formData.api_key = ''
    formData.api_format = 1
    formData.rows = [createEmptyRow()]
    // 清空 model_label 和 model_name，防止点击输入框时自动填充之前的值
    formData.rows[0].model_label = ''
    formData.rows[0].model_name = ''
  } else {
    const company = llmCompanies.value.find((c) => c.llmCompany === vendor)
    if (company) {
      formData.url = company.url
      formData.api_format = Number(company.api_format) as 1 | 2 | 3
      formData.name = company.llmCompany
      formData.rows = company.models.map(createRowFromLlmModel)
    }
  }
}

// 添加行（仅自定义模式可用）
const addModelRow = () => {
  formData.rows.push(createEmptyRow())
}

// 删除行
const removeModelRow = (idx: number) => {
  if (formData.rows.length <= 1) return
  formData.rows.splice(idx, 1)
}

// 加载 LLM 配置数据
const loadLlmData = async () => {
  try {
    const res = await getLlmModels()
    if (res.success) {
      llmCompanies.value = res.data
    }
  } catch (e) {
    // ignore
  }
}

// 打开对话框
const openDialog = async () => {
  formData.vendor = 'custom'
  formData.name = ''
  formData.url = ''
  formData.api_key = ''
  formData.api_format = 1
  formData.rows = [createEmptyRow()]

  if (llmCompanies.value.length === 0) {
    await loadLlmData()
  }

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
  const formValid = await formRef.value?.validate().catch(() => false)
  if (!formValid) return

  // 校验行字段
  for (let i = 0; i < formData.rows.length; i++) {
    const row = formData.rows[i]
    if (!row.model_name?.trim()) {
      ElMessage.warning(`第 ${i + 1} 行：模型名称不能为空`)
      return
    }
    if (!row.max_content_length || row.max_content_length <= 0) {
      ElMessage.warning(`第 ${i + 1} 行：最大上下文长度必须大于 0`)
      return
    }
    if (!row.max_token || row.max_token <= 0) {
      ElMessage.warning(`第 ${i + 1} 行：最大输出长度必须大于 0`)
      return
    }
  }

  // 获取显示名称列表
  const displayNames = formData.rows.map((r) => r.model_label?.trim() || getDefaultLabel(r))

  // 检查模型列表内部是否有重复
  const seenInList = new Set<string>()
  for (let i = 0; i < displayNames.length; i++) {
    const name = displayNames[i]
    if (!name) continue
    if (seenInList.has(name)) {
      ElMessage.warning(`第 ${i + 1} 行：显示名称 "${name}" 与列表中其他行重复，请修改`)
      return
    }
    seenInList.add(name)
  }

  // 检查是否与数据库中已存储的模型重复
  try {
    const res = await getModels()
    if (res.success) {
      const dbNames = new Set(res.data.map((m) => m.name))
      for (let i = 0; i < displayNames.length; i++) {
        const name = displayNames[i]
        if (name && dbNames.has(name)) {
          ElMessage.warning(`第 ${i + 1} 行：显示名称 "${name}" 与已存在的模型重复，请修改`)
          return
        }
      }
    }
  } catch (e) {
    // ignore
  }

  submitLoading.value = true
  try {
    const items: ModelRowForm[] = formData.rows.map((r) => {
      // 显示名称 = 合并后的值（带前缀），作为 name
      // model_name = 原始模型名（不带前缀）
      const displayName = r.model_label?.trim() || getDefaultLabel(r)
      const rawModelName = r.model_name?.trim() || ''
      return {
        name: displayName,
        model_name: rawModelName,
        max_content_length: r.max_content_length,
        max_token: r.max_token,
        model_label_id: r.model_label_id ?? null,
        capabilities: r.capabilities ?? DEFAULT_CAPABILITIES,
      }
    })

    emit('submit', {
      url: formData.url,
      api_key: formData.api_key,
      api_format: formData.api_format,
      items,
    })

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
