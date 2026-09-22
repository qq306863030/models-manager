<template>
  <div v-if="attachments && attachments.length > 0" class="attachment-list">
    <div
      v-for="(item, idx) in attachments"
      :key="item.id || idx"
      class="attachment-item"
      :class="[`type-${item.type}`]"
    >
      <!-- 图片缩略图 -->
      <div v-if="item.type === 'image'" class="image-thumb" @click="handlePreviewImage(item.url)">
        <img :src="item.url" :alt="item.name" />
      </div>

      <!-- 文档类图标 -->
      <div v-else class="doc-icon-wrap">
        <el-icon class="doc-icon">
          <Document />
        </el-icon>
        <span class="ext-tag">{{ item.type.toUpperCase() }}</span>
      </div>

      <!-- 文件名与大小 -->
      <div class="file-info">
        <div class="file-name" :title="item.name">{{ item.name }}</div>
        <div class="file-meta">
          <span class="file-size">{{ formatSize(item.size) }}</span>
          <span v-if="item.extractedText" class="parsed-tag">已提取文本</span>
        </div>
      </div>

      <!-- 移除按钮（仅编辑时显示） -->
      <button
        v-if="removable"
        type="button"
        class="remove-btn"
        title="移除"
        @click.stop="$emit('remove', idx)"
      >
        <el-icon><Close /></el-icon>
      </button>
    </div>

    <!-- 图片大图预览 -->
    <el-image-viewer
      v-if="previewUrl"
      :url-list="[previewUrl]"
      @close="previewUrl = ''"
    />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Document, Close } from '@element-plus/icons-vue';
import type { IAttachmentView } from '../composables/useChatStore';

defineProps<{
  attachments: IAttachmentView[];
  removable?: boolean;
}>();

defineEmits<{
  (e: 'remove', index: number): void;
}>();

const previewUrl = ref<string>('');

function handlePreviewImage(url?: string) {
  if (url) {
    previewUrl.value = url;
  }
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
</script>

<style scoped lang="less">
.attachment-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 6px 0;

  .attachment-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    background-color: #ffffff;
    border: 1px solid #e4e7ed;
    border-radius: 6px;
    max-width: 240px;
    position: relative;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);

    .image-thumb {
      width: 36px;
      height: 36px;
      border-radius: 4px;
      overflow: hidden;
      cursor: pointer;
      flex-shrink: 0;

      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    }

    .doc-icon-wrap {
      width: 36px;
      height: 36px;
      background-color: #f0f2f5;
      border-radius: 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;

      .doc-icon {
        font-size: 16px;
        color: #409eff;
      }

      .ext-tag {
        font-size: 8px;
        font-weight: 700;
        color: #909399;
        line-height: 1;
      }
    }

    .file-info {
      flex: 1;
      min-width: 0;

      .file-name {
        font-size: 12px;
        font-weight: 500;
        color: #303133;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .file-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: #909399;

        .parsed-tag {
          font-size: 10px;
          color: #67c23a;
          background-color: #f0f9eb;
          padding: 1px 4px;
          border-radius: 2px;
        }
      }
    }

    .remove-btn {
      border: none;
      background: none;
      color: #909399;
      cursor: pointer;
      padding: 2px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;

      &:hover {
        background-color: #f2f6fc;
        color: #f56c6c;
      }
    }
  }
}
</style>
