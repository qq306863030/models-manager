<template>
  <el-select
    ref="selectRef"
    v-model="innerValue"
    filterable
    clearable
    allow-create
    default-first-option
    :placeholder="placeholder"
    :filter-method="handleFilterMethod"
    style="width: 100%"
    @visible-change="handleVisibleChange"
    @change="handleChange"
    @blur="handleBlur"
    @clear="handleClear"
  >
    <el-option
      v-for="opt in displayedOptions"
      :key="opt.value"
      :label="opt.label"
      :value="opt.value"
    />
    <el-option
      v-if="hasMore"
      disabled
      label="...已显示匹配的前 80 项，输入更多字符精确定位"
      value="__more_notice__"
      class="more-notice-option"
    />
  </el-select>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAllModels } from '@/composables/useAllModels'

defineOptions({
  name: 'ModelSelect',
})

const props = withDefaults(
  defineProps<{
    modelValue?: string
    placeholder?: string
    priorityModels?: string[]
  }>(),
  {
    modelValue: '',
    placeholder: '请搜索或选择模型',
    priorityModels: () => [],
  }
)

const emit = defineEmits<{
  (e: 'update:modelValue', val: string): void
  (e: 'change', val: string): void
  (e: 'blur', evt: FocusEvent): void
  (e: 'clear'): void
}>()

const { allModels, loadAllModels } = useAllModels()

onMounted(() => {
  loadAllModels()
})

const selectRef = ref()
const searchKeyword = ref('')
const hasMore = ref(false)
const MAX_DISPLAY = 80

const innerValue = computed({
  get: () => props.modelValue || '',
  set: (val: string) => {
    emit('update:modelValue', val)
  },
})

// 计算下拉列表选项：仅渲染前 MAX_DISPLAY 项，消除卡顿
const displayedOptions = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()
  const models = allModels.value
  const result: { value: string; label: string }[] = []
  const seen = new Set<string>()

  const currentVal = props.modelValue?.trim()

  if (!keyword) {
    // 优先显示 priorityModels（如果有）
    if (props.priorityModels && props.priorityModels.length > 0) {
      for (const pm of props.priorityModels) {
        if (pm && !seen.has(pm)) {
          seen.add(pm)
          result.push({ value: pm, label: pm })
        }
      }
    }

    // 然后填充 models.json 中的常规模型
    for (let i = 0; i < models.length; i++) {
      if (result.length >= MAX_DISPLAY) break
      const m = models[i].model
      if (m && !seen.has(m)) {
        seen.add(m)
        result.push({ value: m, label: m })
      }
    }

    hasMore.value = models.length > MAX_DISPLAY
  } else {
    // 搜索模式：按匹配度分级（前缀匹配优先，包含匹配居次）
    const exactMatches: { value: string; label: string }[] = []
    const prefixMatches: { value: string; label: string }[] = []
    const includeMatches: { value: string; label: string }[] = []

    let matchCount = 0

    for (let i = 0; i < models.length; i++) {
      const m = models[i].model
      if (!m) continue
      const lower = m.toLowerCase()

      if (lower === keyword) {
        matchCount++
        if (!seen.has(m)) {
          seen.add(m)
          exactMatches.push({ value: m, label: m })
        }
      } else if (lower.startsWith(keyword)) {
        matchCount++
        if (exactMatches.length + prefixMatches.length < MAX_DISPLAY && !seen.has(m)) {
          seen.add(m)
          prefixMatches.push({ value: m, label: m })
        }
      } else if (lower.includes(keyword)) {
        matchCount++
        if (
          exactMatches.length + prefixMatches.length + includeMatches.length < MAX_DISPLAY &&
          !seen.has(m)
        ) {
          seen.add(m)
          includeMatches.push({ value: m, label: m })
        }
      }
    }

    result.push(...exactMatches, ...prefixMatches, ...includeMatches)
    hasMore.value = matchCount > MAX_DISPLAY
  }

  // 保证当前选中的值在列表中，避免 el-select 无法正确显示文本
  if (currentVal && !seen.has(currentVal)) {
    result.unshift({ value: currentVal, label: currentVal })
  }

  return result
})

const handleFilterMethod = (query: string) => {
  searchKeyword.value = query || ''
}

const handleVisibleChange = (visible: boolean) => {
  if (!visible) {
    // 关闭下拉菜单时清空搜索关键词，恢复初始显示列表
    searchKeyword.value = ''
  }
}

const handleChange = (val: string) => {
  emit('update:modelValue', val)
  emit('change', val)
}

const handleClear = () => {
  searchKeyword.value = ''
  emit('update:modelValue', '')
  emit('change', '')
  emit('clear')
}

const handleBlur = (e: FocusEvent) => {
  const inputVal = (e.target as HTMLInputElement)?.value?.trim()
  if (inputVal && inputVal !== props.modelValue) {
    emit('update:modelValue', inputVal)
    emit('change', inputVal)
  }
  emit('blur', e)
}
</script>

<style scoped>
.more-notice-option {
  font-size: 12px;
  color: #909399 !important;
  text-align: center;
  pointer-events: none;
}
</style>
