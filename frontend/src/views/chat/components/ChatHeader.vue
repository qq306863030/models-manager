<template>
  <header class="chat-header">
    <div class="header-left">
      <!-- 侧边栏折叠按钮 -->
      <button
        type="button"
        class="toggle-sidebar-btn"
        title="切换会话列表"
        @click="$emit('toggle-sidebar')"
      >
        <el-icon><Expand v-if="sidebarCollapsed" /><Fold v-else /></el-icon>
      </button>

      <!-- 会话标题编辑 -->
      <div class="session-title-wrap">
        <template v-if="isEditingTitle">
          <input
            ref="titleInputRef"
            v-model="editTitleText"
            class="title-input"
            @blur="handleSaveTitle"
            @keydown.enter="handleSaveTitle"
          />
        </template>
        <template v-else>
          <span class="session-title" :title="title" @click="startEditTitle">
            {{ title || '新对话' }}
          </span>
          <el-icon class="edit-icon" @click="startEditTitle"><EditPen /></el-icon>
        </template>
      </div>
    </div>

    <div class="header-right">
      <!-- 模型选择下拉框 (严格过滤 isDisable === true) -->
      <div class="model-select-wrap">
        <span class="select-label">当前模型:</span>
        <el-select
          :model-value="modelName"
          placeholder="请选择模型"
          size="default"
          style="width: 220px"
          :loading="isModelsLoading"
          @update:model-value="(val) => $emit('change-model', val)"
        >
          <el-option
            v-for="m in availableModels"
            :key="m.id"
            :label="m.name"
            :value="m.name"
          >
            <div class="model-option-item">
              <span class="model-name">{{ m.name }}</span>
              <span class="model-tag" :class="`format-${m.api_format}`">
                {{ formatName(m.api_format) }}
              </span>
            </div>
          </el-option>
        </el-select>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { ref, nextTick } from 'vue';
import { Expand, Fold, EditPen } from '@element-plus/icons-vue';
import type { Model } from '../../../api/modelService';

const props = defineProps<{
  title: string;
  modelName: string;
  availableModels: Model[];
  isModelsLoading: boolean;
  sidebarCollapsed: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void;
  (e: 'update-title', newTitle: string): void;
  (e: 'change-model', modelName: string): void;
}>();

const isEditingTitle = ref(false);
const editTitleText = ref('');
const titleInputRef = ref<HTMLInputElement | null>(null);

function startEditTitle() {
  editTitleText.value = props.title;
  isEditingTitle.value = true;
  nextTick(() => {
    titleInputRef.value?.focus();
    titleInputRef.value?.select();
  });
}

function handleSaveTitle() {
  if (isEditingTitle.value) {
    isEditingTitle.value = false;
    emit('update-title', editTitleText.value);
  }
}

function formatName(format?: number) {
  switch (format) {
    case 1:
      return 'OpenAI';
    case 2:
      return 'Anthropic';
    case 3:
      return 'Responses';
    default:
      return 'LLM';
  }
}
</script>

<style scoped lang="less">
.chat-header {
  height: 56px;
  background-color: #ffffff;
  border-bottom: 1px solid #e4e7ed;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  z-index: 10;

  .header-left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;

    .toggle-sidebar-btn {
      background: none;
      border: 1px solid #dcdfe6;
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 16px;
      color: #606266;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;

      &:hover {
        border-color: #409eff;
        color: #409eff;
      }
    }

    .session-title-wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;

      .session-title {
        font-size: 15px;
        font-weight: 600;
        color: #303133;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;

        &:hover {
          color: #409eff;
        }
      }

      .edit-icon {
        font-size: 14px;
        color: #909399;
        cursor: pointer;

        &:hover {
          color: #409eff;
        }
      }

      .title-input {
        font-size: 15px;
        font-weight: 600;
        border: 1px solid #409eff;
        border-radius: 4px;
        padding: 2px 8px;
        outline: none;
        width: 200px;
      }
    }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 16px;

    .model-select-wrap {
      display: flex;
      align-items: center;
      gap: 6px;

      .select-label {
        font-size: 12px;
        color: #909399;
        white-space: nowrap;
      }
    }
  }
}

.model-option-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;

  .model-name {
    font-size: 13px;
    color: #303133;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .model-tag {
    font-size: 10px;
    padding: 1px 4px;
    border-radius: 3px;
    font-weight: 600;

    &.format-1 {
      background-color: #ecf5ff;
      color: #409eff;
    }
    &.format-2 {
      background-color: #fdf6ec;
      color: #e6a23c;
    }
    &.format-3 {
      background-color: #f0f9eb;
      color: #67c23a;
    }
  }
}
</style>
