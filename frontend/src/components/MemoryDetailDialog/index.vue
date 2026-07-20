<template>
  <el-dialog
    v-model="dialogVisible"
    title="记忆详情"
    width="70vw"
    top="10vh"
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
        <!-- 查看模式：Markdown 渲染 -->
        <div v-if="!isEditing" class="field-value markdown-body" v-html="renderedContent"></div>
        <!-- 编辑模式：原始内容 textarea -->
        <el-input
          v-else
          v-model="editContent"
          type="textarea"
          :rows="16"
          placeholder="输入内容（Markdown 格式）"
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
import { ref, computed } from 'vue';
import { ElMessage } from 'element-plus';
import MarkdownIt from 'markdown-it';
import type { AgentMemoryItem } from '@/api/agentMemoryService';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

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

const renderedContent = computed(() => {
  const content = item.value?.content;
  if (!content) return '<p style="color: #999;">（无内容）</p>';
  return md.render(content);
});

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

/* Markdown 渲染样式 */
.markdown-body {
  max-height: 500px;
  overflow-y: auto;
  background: #fafafa;
  padding: 16px 20px;
  border-radius: 6px;
  border: 1px solid #eee;
  font-size: 14px;
  line-height: 1.7;
  color: #24292e;

  :deep(h1), :deep(h2), :deep(h3), :deep(h4), :deep(h5), :deep(h6) {
    margin-top: 1em;
    margin-bottom: 0.5em;
    font-weight: 600;
    line-height: 1.25;
    color: #1a1a1a;
  }

  :deep(h1) { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: 0.3em; }
  :deep(h2) { font-size: 1.3em; border-bottom: 1px solid #eaecef; padding-bottom: 0.25em; }
  :deep(h3) { font-size: 1.15em; }
  :deep(h4) { font-size: 1.05em; }

  :deep(p) {
    margin-top: 0;
    margin-bottom: 12px;
  }

  :deep(ul), :deep(ol) {
    padding-left: 2em;
    margin-bottom: 12px;
  }

  :deep(li) {
    margin-bottom: 4px;
  }

  :deep(blockquote) {
    margin: 0 0 12px;
    padding: 8px 16px;
    border-left: 4px solid #dfe2e5;
    color: #6a737d;
    background: #f6f8fa;
    border-radius: 0 4px 4px 0;
  }

  :deep(code) {
    font-family: Consolas, 'Courier New', monospace;
    font-size: 0.9em;
    padding: 2px 6px;
    background: #f0f2f4;
    border-radius: 3px;
    color: #d63384;
  }

  :deep(pre) {
    background: #f6f8fa;
    border: 1px solid #e1e4e8;
    border-radius: 6px;
    padding: 14px 16px;
    overflow-x: auto;
    margin-bottom: 14px;

    code {
      background: none;
      padding: 0;
      color: inherit;
      font-size: 13px;
      line-height: 1.5;
    }
  }

  :deep(table) {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 14px;
    font-size: 13px;
  }

  :deep(th), :deep(td) {
    border: 1px solid #dfe2e5;
    padding: 8px 12px;
    text-align: left;
  }

  :deep(th) {
    background: #f6f8fa;
    font-weight: 600;
  }

  :deep(tr:nth-child(even)) {
    background: #fafbfc;
  }

  :deep(hr) {
    height: 1px;
    background: #e1e4e8;
    border: none;
    margin: 20px 0;
  }

  :deep(a) {
    color: #0366d6;
    text-decoration: none;
    &:hover { text-decoration: underline; }
  }

  :deep(img) {
    max-width: 100%;
    border-radius: 4px;
  }

  :deep(strong) {
    font-weight: 600;
  }

  :deep(input[type="checkbox"]) {
    margin-right: 6px;
  }
}
</style>
