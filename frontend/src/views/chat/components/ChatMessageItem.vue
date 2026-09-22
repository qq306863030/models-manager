<template>
  <div class="message-item-wrapper" :class="`role-${message.role}`">
    <!-- 用户头像 / AI 头像 -->
    <div class="avatar-wrap">
      <el-avatar v-if="message.role === 'user'" size="small" class="user-avatar">
        我
      </el-avatar>
      <el-avatar v-else size="small" class="ai-avatar">
        AI
      </el-avatar>
    </div>

    <!-- 消息主体 -->
    <div class="message-content-container">
      <!-- 用户附件 -->
      <div v-if="message.attachments && message.attachments.length > 0" class="message-attachments">
        <AttachmentList :attachments="message.attachments" :removable="false" />
      </div>

      <!-- 思考过程卡片 (Reasoning: 仅在有实际思考内容时实时展示) -->
      <div v-if="message.reasoning" class="reasoning-box" :class="{ 'is-thinking': isThinking }">
        <div class="reasoning-header" @click="isReasoningExpanded = !isReasoningExpanded">
          <div class="header-left">
            <el-icon class="brain-icon" :class="{ 'is-rotating': isThinking }">
              <Loading v-if="isThinking" />
              <HelpFilled v-else />
            </el-icon>
            <span class="title">{{ reasoningTitle }}</span>
            <span v-if="message.reasoning" class="reasoning-count">({{ reasoningWordCount }}字)</span>
          </div>
          <div class="header-right">
            <span class="toggle-tip">{{ isReasoningExpanded ? '收起' : '展开' }}</span>
            <el-icon class="arrow" :class="{ 'is-open': isReasoningExpanded }">
              <ArrowDown />
            </el-icon>
          </div>
        </div>

        <el-collapse-transition>
          <div v-show="isReasoningExpanded" class="reasoning-body">
            <div ref="reasoningTextRef" class="reasoning-text">
              {{ message.reasoning }}<span v-if="isThinking" class="reasoning-cursor"></span>
            </div>
          </div>
        </el-collapse-transition>
      </div>

      <!-- MCP 工具调用卡片列表 -->
      <div v-if="message.toolCalls && message.toolCalls.length > 0" class="message-tool-calls">
        <ToolCallCard
          v-for="call in message.toolCalls"
          :key="call.id"
          :tool="call"
        />
      </div>

      <!-- 正文回答气泡 (Markdown 渲染) -->
      <div
        v-if="message.content || (isStreamingCurrent && !message.reasoning)"
        class="message-bubble markdown-body"
        v-html="renderedContent"
      ></div>

      <!-- 错误提示 -->
      <div v-if="message.error" class="message-error-box">
        <el-icon><WarningFilled /></el-icon>
        <span>{{ message.error }}</span>
      </div>

      <!-- 底部辅助栏（时间与复制按钮） -->
      <div class="message-meta-footer">
        <span class="message-time">{{ formattedTime }}</span>
        <button
          v-if="message.content || message.reasoning"
          type="button"
          class="copy-action-btn"
          title="复制回答"
          @click="handleCopy"
        >
          <el-icon><CopyDocument /></el-icon>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import MarkdownIt from 'markdown-it';
import { HelpFilled, ArrowDown, WarningFilled, CopyDocument, Loading } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import ToolCallCard from './ToolCallCard.vue';
import AttachmentList from './AttachmentList.vue';
import type { IChatMessage } from '../composables/useChatStore';

const props = defineProps<{
  message: IChatMessage;
  isStreamingCurrent?: boolean;
}>();

const isReasoningExpanded = ref(true);
const reasoningTextRef = ref<HTMLDivElement | null>(null);

const isThinking = computed(() => {
  return props.isStreamingCurrent && !props.message.content;
});

// 思考流式推进时，自动滚动思考文本区域到底部
watch(
  () => props.message.reasoning,
  () => {
    if (isThinking.value && reasoningTextRef.value) {
      nextTick(() => {
        if (reasoningTextRef.value) {
          reasoningTextRef.value.scrollTop = reasoningTextRef.value.scrollHeight;
        }
      });
    }
  }
);

const reasoningTitle = computed(() => {
  if (isThinking.value) {
    return '正在深度思考中...';
  }
  return '已深度思考';
});

const reasoningWordCount = computed(() => {
  return props.message.reasoning ? props.message.reasoning.length : 0;
});

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

const renderedContent = computed(() => {
  if (!props.message.content) {
    if (props.isStreamingCurrent && !props.message.reasoning) {
      return '<span class="typing-placeholder">AI 正在思考中...</span><span class="typing-cursor"></span>';
    }
    return '';
  }
  let html = md.render(props.message.content);
  if (props.isStreamingCurrent) {
    if (html.endsWith('</p>\n')) {
      html = html.slice(0, -5) + '<span class="typing-cursor"></span></p>\n';
    } else if (html.endsWith('</p>')) {
      html = html.slice(0, -4) + '<span class="typing-cursor"></span></p>';
    } else {
      html += '<span class="typing-cursor"></span>';
    }
  }
  return html;
});

const formattedTime = computed(() => {
  if (!props.message.createdAt) return '';
  const d = new Date(props.message.createdAt);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
});

function handleCopy() {
  const textToCopy = props.message.content || props.message.reasoning || '';
  if (!textToCopy) return;

  navigator.clipboard
    .writeText(textToCopy)
    .then(() => {
      ElMessage.success('已复制到剪贴板');
    })
    .catch(() => {
      ElMessage.error('复制失败');
    });
}
</script>

<style scoped lang="less">
.message-item-wrapper {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;

  &.role-user {
    flex-direction: row-reverse;

    .message-content-container {
      align-items: flex-end;

      .message-bubble {
        background-color: #409eff;
        color: #ffffff;
        border-radius: 12px 2px 12px 12px;

        :deep(p), :deep(span), :deep(li) {
          color: #ffffff;
        }

        :deep(a) {
          color: #e4e7ed;
        }

        :deep(code) {
          background-color: rgba(0, 0, 0, 0.15);
          color: #ffffff;
        }
      }

      .message-meta-footer {
        flex-direction: row-reverse;
      }
    }

    .user-avatar {
      background-color: #409eff;
      color: #ffffff;
      font-size: 12px;
      font-weight: 600;
    }
  }

  &.role-assistant {
    .message-content-container {
      align-items: flex-start;

      .message-bubble {
        background-color: #ffffff;
        color: #303133;
        border: 1px solid #ebeef5;
        border-radius: 2px 12px 12px 12px;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
      }
    }

    .ai-avatar {
      background-color: #67c23a;
      color: #ffffff;
      font-size: 12px;
      font-weight: 700;
    }
  }

  .message-content-container {
    display: flex;
    flex-direction: column;
    max-width: 82%;
    min-width: 60px;
  }

  .message-bubble {
    padding: 10px 14px;
    font-size: 14px;
    line-height: 1.6;
    word-break: break-word;

    :deep(pre) {
      background-color: #282c34;
      color: #abb2bf;
      padding: 10px 12px;
      border-radius: 6px;
      overflow-x: auto;
      font-family: Consolas, Monaco, monospace;
      font-size: 13px;
      margin: 8px 0;
    }

    :deep(p) {
      margin: 0 0 8px;
      &:last-child {
        margin-bottom: 0;
      }
    }

    :deep(table) {
      border-collapse: collapse;
      width: 100%;
      margin: 8px 0;

      th, td {
        border: 1px solid #dcdfe6;
        padding: 6px 10px;
        text-align: left;
      }

      th {
        background-color: #f5f7fa;
      }
    }
  }

  /* 思考过程卡片高级样式 */
  .reasoning-box {
    margin-bottom: 8px;
    border-radius: 8px;
    border: 1px solid #e2e8f0;
    background-color: #f8fafc;
    font-size: 13px;
    width: 100%;
    transition: all 0.2s ease;

    &.is-thinking {
      border-color: #cbd5e1;
      background-color: #f1f5f9;
      box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.2);
    }

    .reasoning-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      color: #64748b;

      &:hover {
        background-color: rgba(0, 0, 0, 0.02);
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: 6px;

        .brain-icon {
          font-size: 15px;
          color: #6366f1;

          &.is-rotating {
            animation: spin 1.5s linear infinite;
          }
        }

        .title {
          font-size: 12px;
          font-weight: 600;
          color: #475569;
        }

        .reasoning-count {
          font-size: 11px;
          color: #94a3b8;
        }
      }

      .header-right {
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        color: #94a3b8;

        .arrow {
          transition: transform 0.2s;
          &.is-open {
            transform: rotate(180deg);
          }
        }
      }
    }

    .reasoning-body {
      padding: 8px 12px 10px;
      border-top: 1px dashed #e2e8f0;
      background-color: #ffffff;
      border-radius: 0 0 8px 8px;

      .reasoning-text {
        font-size: 12px;
        line-height: 1.6;
        color: #64748b;
        white-space: pre-wrap;
        word-break: break-word;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        max-height: 320px;
        overflow-y: auto;
      }
    }
  }

  .message-tool-calls {
    width: 100%;
    margin-bottom: 8px;
  }

  .message-error-box {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    padding: 6px 10px;
    border-radius: 6px;
    background-color: #fef0f0;
    color: #f56c6c;
    font-size: 12px;
    border: 1px solid #fde2e2;
  }

  .message-meta-footer {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    padding: 0 4px;

    .message-time {
      font-size: 11px;
      color: #a8abb2;
    }

    .copy-action-btn {
      background: none;
      border: none;
      color: #a8abb2;
      cursor: pointer;
      padding: 2px;
      display: flex;
      align-items: center;
      font-size: 12px;

      &:hover {
        color: #409eff;
      }
    }
  }
}

:deep(.typing-placeholder) {
  font-size: 12px;
  color: #909399;
  font-style: italic;
}

:deep(.typing-cursor) {
  display: inline-block;
  width: 7px;
  height: 14px;
  background-color: #409eff;
  margin-left: 4px;
  vertical-align: middle;
  animation: blink 0.8s infinite;
}

.reasoning-cursor {
  display: inline-block;
  width: 6px;
  height: 12px;
  background-color: #6366f1;
  margin-left: 4px;
  vertical-align: middle;
  animation: blink 0.8s infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0; }
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
