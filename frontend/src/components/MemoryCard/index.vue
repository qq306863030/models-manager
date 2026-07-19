<template>
  <div class="memory-card">
    <div class="memory-card-body">
      <div class="memory-title" :title="description || ''">{{ description || '（无标题）' }}</div>
      <div class="memory-content">{{ content || '（无内容）' }}</div>
    </div>
    <div class="memory-card-footer">
      <el-button size="small" type="primary" plain @click="$emit('detail', item)">
        <el-icon><View /></el-icon>
        查看详情
      </el-button>
      <el-button size="small" type="danger" plain @click="$emit('delete', item)">
        <el-icon><Delete /></el-icon>
        删除
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { AgentMemoryItem } from '@/api/agentMemoryService';

defineOptions({ name: 'MemoryCard' });

interface Props {
  item: AgentMemoryItem;
}

const props = defineProps<Props>();

defineEmits<{
  detail: [item: AgentMemoryItem];
  delete: [item: AgentMemoryItem];
}>();

const description = props.item.description;
const content = props.item.content;
</script>

<style scoped lang="less">
.memory-card {
  background: #fff;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
  padding: 16px;
  display: flex;
  flex-direction: column;
  transition: box-shadow 0.2s;
  height: 100%;
  width: 100%;
  max-height: 260px;

  &:hover {
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  }
}

.memory-card-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: 100%;
}

.memory-title {
  font-size: 15px;
  font-weight: 600;
  color: #303133;
  line-height: 1.4;
  margin-bottom: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  word-break: break-all;
  width: 100%;
  flex-shrink: 0;
}

.memory-content {
  font-size: 13px;
  color: #606266;
  line-height: 1.6;
  word-break: break-all;
  width: 100%;
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.memory-card-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid #f0f0f0;
  flex-shrink: 0;
}
</style>
