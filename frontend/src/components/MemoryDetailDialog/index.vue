<template>
  <el-dialog
    v-model="dialogVisible"
    title="记忆详情"
    width="600px"
    :close-on-click-modal="false"
    @close="handleClose">
    <div v-if="item" class="detail-container">
      <div class="field-group">
        <label class="field-label">标题（description）</label>
        <div v-if="!isEditing" class="field-value">{{ item.description || '（无标题）' }}</div>
        <el-input v-else v-model="editDescription" placeholder="输入标题" maxlength="500" />
      </div>

      <div class="field-group">
        <label class="field-label">内容（content）</label>
        <div v-if="!isEditing" class="field-value content-value">{{ item.content || '（无内容）' }}</div>
        <el-input
          v-else
          v-model="editContent"
          type="textarea"
          :rows="10"
          placeholder="输入内容"
          maxlength="100000"
          show-word-limit />
      </div>
    </div>

    <template #footer>
      <el-button @click="dialogVisible = false">关闭</el-button>
      <el-button v-if="!isEditing" type="primary" @click="enterEdit">
        <el-icon><Edit /></el-icon>
        编辑
      </el-button>
      <template v-else>
        <el-button @click="cancelEdit">取消</el-button>
        <el-button type="primary" @click="handleSave" :loading="saving">
          <el-icon><Check /></el-icon>
          提交保存
        </el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { AgentMemoryItem } from '@/api/agentMemoryService';

defineOptions({ name: 'MemoryDetailDialog' });

const props = defineProps<{
  memoryType: 'user' | 'skills';
}>();

const emit = defineEmits<{
  saved: [item: AgentMemoryItem];
}>();

const dialogVisible = ref(false);
const item = ref<AgentMemoryItem | null>(null);
const isEditing = ref(false);
const saving = ref(false);
const editDescription = ref('');
const editContent = ref('');
const originalItem = ref<AgentMemoryItem | null>(null);

const openDialog = (data: AgentMemoryItem) => {
  item.value = { ...data };
  originalItem.value = { ...data };
  isEditing.value = false;
  dialogVisible.value = true;
};

const enterEdit = () => {
  if (!item.value) return;
  editDescription.value = item.value.description || '';
  editContent.value = item.value.content || '';
  isEditing.value = true;
};

const cancelEdit = () => {
  if (originalItem.value) {
    item.value = { ...originalItem.value };
  }
  isEditing.value = false;
};

const handleSave = async () => {
  if (!item.value) return;
  saving.value = true;
  try {
    const { updateMemory } = await import('@/api/agentMemoryService');
    const res = await updateMemory(
      props.memoryType,
      item.value.id,
      editDescription.value || null,
      editContent.value || null
    );
    if (res.success) {
      ElMessage.success('保存成功');
      item.value.description = editDescription.value || null;
      item.value.content = editContent.value || null;
      originalItem.value = { ...item.value };
      isEditing.value = false;
      emit('saved', { ...item.value });
    } else {
      ElMessage.error(res.message || '保存失败');
    }
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message || '保存失败');
  } finally {
    saving.value = false;
  }
};

const handleClose = () => {
  isEditing.value = false;
};

defineExpose({ openDialog });
</script>

<style scoped lang="less">
.detail-container {
  .field-group {
    margin-bottom: 18px;

    .field-label {
      display: block;
      font-size: 13px;
      color: #909399;
      margin-bottom: 6px;
      font-weight: 500;
    }

    .field-value {
      font-size: 14px;
      color: #303133;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
    }

    .content-value {
      max-height: 300px;
      overflow-y: auto;
      background: #f5f7fa;
      padding: 10px 12px;
      border-radius: 4px;
    }
  }
}
</style>
