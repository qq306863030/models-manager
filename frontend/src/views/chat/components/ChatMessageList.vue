<template>
  <div ref="scrollContainerRef" class="message-list-container">
    <!-- 空状态：仅显示标题 -->
    <div v-if="!messages || messages.length === 0" class="empty-guide-panel">
      <h3 class="guide-title">开始与 AI 助手对话</h3>
    </div>

    <!-- 消息列表 -->
    <div v-else class="message-list-inner">
      <ChatMessageItem
        v-for="(msg, index) in messages"
        :key="msg.id || index"
        :message="msg"
        :is-streaming-current="isStreaming && index === messages.length - 1 && msg.role === 'assistant'"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue';
import ChatMessageItem from './ChatMessageItem.vue';
import type { IChatMessage } from '../composables/useChatStore';

const props = defineProps<{
  messages: IChatMessage[];
  isStreaming: boolean;
}>();

const scrollContainerRef = ref<HTMLDivElement | null>(null);

function scrollToBottom(smooth = true) {
  nextTick(() => {
    if (scrollContainerRef.value) {
      scrollContainerRef.value.scrollTo({
        top: scrollContainerRef.value.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    }
  });
}

// 监听消息数量变化
watch(
  () => props.messages.length,
  () => {
    scrollToBottom(true);
  }
);

// 监听流式思考增量与正文增量，保证实时滚底
watch(
  () => {
    const last = props.messages[props.messages.length - 1];
    return last ? `${last.id}_${(last.content || '').length}_${(last.reasoning || '').length}_${(last.toolCalls || []).length}` : '';
  },
  () => {
    if (props.isStreaming) {
      scrollToBottom(false);
    }
  }
);

onMounted(() => {
  scrollToBottom(false);
});
</script>

<style scoped lang="less">
.message-list-container {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  background-color: #f7f9fb;

  .message-list-inner {
    max-width: 900px;
    margin: 0 auto;
  }

  .empty-guide-panel {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 400px;
    user-select: none;

    .guide-title {
      font-size: 20px;
      font-weight: 500;
      color: #909399;
      letter-spacing: 1px;
      margin: 0;
    }
  }
}
</style>
