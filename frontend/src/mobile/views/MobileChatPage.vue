<template>
  <div class="mobile-chat-page" :style="pageStyle">
    <!-- 顶部导航 -->
    <van-nav-bar title="AI 聊天" @click-left="showSessionDrawer = true">
      <template #left>
        <van-icon name="bars" size="20" />
      </template>
      <template #right>
        <div class="nav-right-actions">
          <van-icon name="plus" size="20" style="margin-right: 12px" @click="handleNewSession" />
          <MobileNavDropdown :show-add-action="false" compact />
        </div>
      </template>
    </van-nav-bar>

    <!-- 当前会话信息条 -->
    <div class="session-info-bar" v-if="currentSession">
      <van-tag type="primary" size="medium" class="session-title-tag" @click="showSessionDrawer = true">
        <van-icon name="chat-o" style="margin-right: 4px" />
        {{ currentSession.title }}
      </van-tag>
      <div class="model-selector" @click="showModelPicker = true">
        <van-icon name="cluster-o" size="14" style="margin-right: 4px" />
        <span class="model-name-text">{{ currentSession.modelName || '选择模型' }}</span>
        <van-icon name="arrow-down" size="12" />
      </div>
    </div>

    <!-- 消息列表区域 -->
    <div ref="messageListRef" class="message-list-area">
      <!-- 空状态 -->
      <div v-if="!currentSession || !currentSession.messages || currentSession.messages.length === 0" class="empty-chat-state">
        <van-icon name="chat-o" size="56" color="#c8c9cc" />
        <p class="empty-chat-hint">开始与 AI 助手对话</p>
        <p class="empty-chat-sub">选择模型，输入问题即可开始</p>
      </div>

      <!-- 消息列表 -->
      <div v-else class="messages-inner">
        <div
          v-for="(msg, index) in currentSession.messages"
          :key="msg.id || index"
          class="message-item"
          :class="`message-${msg.role}`"
        >
          <!-- 用户消息 -->
          <template v-if="msg.role === 'user'">
            <div class="message-bubble user-bubble">
              <div class="bubble-content">{{ msg.content }}</div>
            </div>
            <div class="avatar user-avatar-icon">我</div>
          </template>

          <!-- AI 消息 -->
          <template v-else-if="msg.role === 'assistant'">
            <div class="avatar ai-avatar-icon">AI</div>
            <div class="message-bubble ai-bubble">
              <!-- 错误提示 -->
              <div v-if="msg.error" class="bubble-error">
                <van-icon name="warning-o" /> {{ msg.error }}
              </div>

              <!-- 思考过程 -->
              <div v-if="msg.reasoning" class="reasoning-section">
                <div
                  class="reasoning-header"
                  @click="toggleReasoning(msg.id)"
                >
                  <van-icon
                    :name="isStreaming && index === currentSession!.messages.length - 1 ? 'more-o' : 'bulb-o'"
                    size="14"
                  />
                  <span>思考过程</span>
                  <span class="reasoning-word-count">({{ msg.reasoning.length }}字)</span>
                  <van-icon :name="expandedReasoning.has(msg.id) ? 'arrow-up' : 'arrow-down'" size="12" />
                </div>
                <div v-if="expandedReasoning.has(msg.id)" class="reasoning-content">{{ msg.reasoning }}</div>
              </div>

              <!-- 工具调用展示 -->
              <div v-if="msg.toolCalls && msg.toolCalls.length > 0" class="tool-calls-section">
                <div
                  v-for="call in msg.toolCalls"
                  :key="call.id"
                  class="tool-call-item"
                  :class="`status-${call.status || 'pending'}`"
                >
                  <div class="tool-call-header">
                    <van-icon
                      :name="call.status === 'done' ? 'success' : call.status === 'error' ? 'warning' : 'more-o'"
                      size="13"
                      :class="`tool-icon-${call.status || 'pending'}`"
                    />
                    <span class="tool-name">{{ call.name }}</span>
                    <span v-if="call.status === 'done'" class="tool-done-label">完成</span>
                    <span v-else-if="call.status === 'error'" class="tool-error-label">失败</span>
                    <span v-else class="tool-running-label">执行中</span>
                  </div>
                  <div v-if="call.summary" class="tool-call-summary">{{ call.summary }}</div>
                </div>
              </div>

              <!-- 正文（流式光标） -->
              <div class="bubble-content ai-content">
                <span>{{ msg.content }}</span>
                <span
                  v-if="isStreaming && index === currentSession!.messages.length - 1 && msg.role === 'assistant' && !msg.content && !msg.reasoning"
                  class="typing-cursor"
                >▋</span>
              </div>
            </div>
          </template>
        </div>

        <!-- 流式加载指示 -->
        <div v-if="isStreaming" class="streaming-indicator">
          <van-loading size="16" type="spinner" color="#1989fa" />
          <span>AI 正在思考中...</span>
        </div>
      </div>
    </div>

    <!-- 底部输入区 -->
    <div class="composer-area">
      <div class="composer-inner">
        <van-field
          v-model="inputText"
          type="textarea"
          rows="2"
          autosize
          :maxlength="4000"
          placeholder="输入消息，Shift+Enter 换行..."
          class="composer-field"
          :disabled="isStreaming"
          @keydown.enter.exact.prevent="handleSend"
        />
        <div class="composer-actions">
          <van-button
            v-if="isStreaming"
            type="danger"
            size="small"
            icon="stop-circle-o"
            class="stop-btn"
            @click="stopGeneration"
          >
          </van-button>
          <van-button
            v-else
            type="primary"
            size="small"
            icon="guide-o"
            class="send-btn"
            :disabled="!inputText.trim()"
            @click="handleSend"
          >
          </van-button>
          <van-button
            size="small"
            icon="delete-o"
            plain
            class="clear-btn"
            :disabled="isStreaming"
            @click="clearCurrentMessages"
          />
        </div>
      </div>
    </div>

    <!-- 会话列表抽屉 -->
    <van-popup
      v-model:show="showSessionDrawer"
      position="left"
      :style="{ width: '75%', height: '100%' }"
    >
      <div class="session-drawer">
        <div class="drawer-header">
          <span class="drawer-title">会话列表</span>
          <van-button type="primary" size="small" icon="plus" @click="handleNewSessionFromDrawer">
            新对话
          </van-button>
        </div>
        <div class="session-list">
          <div
            v-for="session in sessions"
            :key="session.id"
            class="session-list-item"
            :class="{ 'is-active': session.id === currentSessionId }"
            @click="handleSwitchSession(session.id)"
          >
            <div class="session-item-content">
              <van-icon name="chat-o" size="16" class="session-icon" />
              <div class="session-item-info">
                <div class="session-item-title">{{ session.title }}</div>
                <div class="session-item-meta">{{ formatTime(session.updatedAt) }} · {{ session.messages.length }} 条</div>
              </div>
            </div>
            <van-button
              size="mini"
              type="danger"
              plain
              icon="delete-o"
              class="session-delete-btn"
              @click.stop="handleDeleteSession(session.id)"
            />
          </div>
          <van-empty v-if="sessions.length === 0" description="暂无会话" />
        </div>
      </div>
    </van-popup>

    <!-- 模型选择器 -->
    <van-action-sheet
      v-model:show="showModelPicker"
      title="选择模型"
      :actions="modelActions"
      cancel-text="取消"
      @select="handleModelSelect"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue';
import { showToast, showConfirmDialog } from 'vant';
import MobileNavDropdown from '@/mobile/components/MobileNavDropdown.vue';
import { useChatStore } from '@/views/chat/composables/useChatStore';

const {
  sessions,
  currentSessionId,
  currentSession,
  isStreaming,
  availableModels,
  isModelsLoading,
  loadModels,
  initSessions,
  createNewSession,
  switchSession,
  deleteSession,
  clearCurrentMessages,
  setSessionModel,
  sendMessage,
  stopGeneration,
} = useChatStore();

// UI 状态
const inputText = ref('');
const showSessionDrawer = ref(false);
const showModelPicker = ref(false);

// VisualViewport：动态跟踪键盘弹出后的实际可视高度，消除底部空白
const pageStyle = ref<Record<string, string>>({});

function updateViewportSize() {
  const vv = window.visualViewport;
  if (!vv) return;
  pageStyle.value = {
    height: vv.height + 'px',
    top: vv.offsetTop + 'px',
    left: vv.offsetLeft + 'px',
    width: vv.width + 'px',
  };
}
const messageListRef = ref<HTMLDivElement | null>(null);
const expandedReasoning = ref<Set<string>>(new Set());

// 模型选项（供 ActionSheet 使用）
const modelActions = computed(() =>
  availableModels.value.map((m) => ({
    name: m.name,
    subname: m.url || '',
    value: m.name,
  }))
);

// 工具函数
function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
}

function toggleReasoning(msgId: string) {
  if (expandedReasoning.value.has(msgId)) {
    expandedReasoning.value.delete(msgId);
  } else {
    expandedReasoning.value.add(msgId);
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (messageListRef.value) {
      messageListRef.value.scrollTo({
        top: messageListRef.value.scrollHeight,
        behavior: 'smooth',
      });
    }
  });
}

// 发送消息
async function handleSend() {
  const text = inputText.value.trim();
  if (!text || isStreaming.value) return;

  if (!currentSession.value?.modelName) {
    showToast('请先选择一个模型');
    showModelPicker.value = true;
    return;
  }

  inputText.value = '';
  scrollToBottom();

  try {
    await sendMessage(text);
  } catch (err: any) {
    showToast({ type: 'fail', message: err.message || '发送失败' });
  }
}

// 新建会话
function handleNewSession() {
  createNewSession();
  showToast({ type: 'success', message: '已创建新对话' });
}

function handleNewSessionFromDrawer() {
  createNewSession();
  showSessionDrawer.value = false;
  showToast({ type: 'success', message: '已创建新对话' });
}

// 切换会话
function handleSwitchSession(id: string) {
  switchSession(id);
  showSessionDrawer.value = false;
}

// 删除会话
async function handleDeleteSession(id: string) {
  try {
    await showConfirmDialog({ title: '确认删除', message: '删除后无法恢复此对话' });
    deleteSession(id);
  } catch {
    // 用户取消
  }
}

// 选择模型
function handleModelSelect(action: { name: string }) {
  setSessionModel(action.name);
  showModelPicker.value = false;
}

// 监听消息变化自动滚底
watch(
  () => currentSession.value?.messages.length,
  () => scrollToBottom()
);
watch(
  () => {
    const last = currentSession.value?.messages[currentSession.value.messages.length - 1];
    return last ? `${last.id}_${(last.content || '').length}` : '';
  },
  () => {
    if (isStreaming.value) scrollToBottom();
  }
);

onMounted(async () => {
  // 初始化 visualViewport 监听，修复键盘弹出时底部空白问题
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateViewportSize);
    window.visualViewport.addEventListener('scroll', updateViewportSize);
    updateViewportSize();
  }

  initSessions();
  await loadModels();
  scrollToBottom();
});

onUnmounted(() => {
  if (window.visualViewport) {
    window.visualViewport.removeEventListener('resize', updateViewportSize);
    window.visualViewport.removeEventListener('scroll', updateViewportSize);
  }
});
</script>

<style scoped lang="less">
.mobile-chat-page {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
  overflow: hidden;
  /* 通过 JS :style 绑定动态覆盖 height/top，以适配键盘弹出场景 */
}

// 顶部导航右侧
.nav-right-actions {
  display: flex;
  align-items: center;
}

// 会话信息条
.session-info-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: #fff;
  border-bottom: 1px solid #ebedf0;
  gap: 8px;
  flex-shrink: 0;

  .session-title-tag {
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .model-selector {
    display: flex;
    align-items: center;
    font-size: 12px;
    color: #646566;
    cursor: pointer;
    padding: 3px 8px;
    border-radius: 12px;
    border: 1px solid #dcdee0;
    background: #fafafa;

    .model-name-text {
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin: 0 3px;
    }
  }
}

// 消息列表
.message-list-area {
  flex: 1;
  overflow-y: auto;
  padding: 12px 12px 0;
  -webkit-overflow-scrolling: touch;
}

.empty-chat-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 24px 40px;
  color: #c8c9cc;

  .empty-chat-hint {
    font-size: 16px;
    color: #969799;
    margin: 12px 0 4px;
  }
  .empty-chat-sub {
    font-size: 13px;
    color: #c8c9cc;
    margin: 0;
  }
}

.messages-inner {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 12px;
}

// 消息项
.message-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 100%;

  &.message-user {
    flex-direction: row-reverse;
  }
}

// 头像
.avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}

.user-avatar-icon {
  background: #1989fa;
  color: #fff;
}

.ai-avatar-icon {
  background: #07c160;
  color: #fff;
}

// 气泡
.message-bubble {
  max-width: calc(100% - 50px);
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 14px;
  line-height: 1.6;
  word-break: break-word;
}

.user-bubble {
  background: #1989fa;
  color: #fff;
  border-bottom-right-radius: 4px;

  .bubble-content {
    white-space: pre-wrap;
  }
}

.ai-bubble {
  background: #fff;
  color: #323233;
  border-bottom-left-radius: 4px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
}

.bubble-error {
  color: #ee0a24;
  font-size: 13px;
  padding: 4px 0 8px;
  display: flex;
  align-items: center;
  gap: 4px;
}

// AI 消息正文
.ai-content {
  white-space: pre-wrap;
}

// 思考过程
.reasoning-section {
  margin-bottom: 8px;
  border-bottom: 1px solid #ebedf0;
  padding-bottom: 8px;

  .reasoning-header {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #969799;
    cursor: pointer;
    padding: 2px 0;

    .reasoning-word-count {
      flex: 1;
      color: #c8c9cc;
    }
  }

  .reasoning-content {
    margin-top: 6px;
    font-size: 12px;
    color: #646566;
    background: #f7f8fa;
    padding: 8px;
    border-radius: 6px;
    white-space: pre-wrap;
    max-height: 200px;
    overflow-y: auto;
    line-height: 1.5;
  }
}

// 工具调用
.tool-calls-section {
  margin-bottom: 8px;
}

.tool-call-item {
  background: #f7f8fa;
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 4px;
  border-left: 3px solid #dcdee0;

  &.status-done { border-left-color: #07c160; }
  &.status-error { border-left-color: #ee0a24; }
  &.status-pending, &.status-running { border-left-color: #1989fa; }

  .tool-call-header {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 500;

    .tool-name {
      flex: 1;
      color: #323233;
      font-family: monospace;
    }

    .tool-done-label { color: #07c160; font-size: 11px; }
    .tool-error-label { color: #ee0a24; font-size: 11px; }
    .tool-running-label { color: #1989fa; font-size: 11px; }
  }

  .tool-call-summary {
    margin-top: 4px;
    font-size: 11px;
    color: #646566;
    white-space: pre-wrap;
    max-height: 80px;
    overflow: hidden;
  }
}

// 流式指示
.streaming-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  font-size: 12px;
  color: #969799;
}

// 打字光标
.typing-cursor {
  animation: blink 1s step-end infinite;
  color: #1989fa;
}

@keyframes blink {
  50% { opacity: 0; }
}

// 输入区
.composer-area {
  flex-shrink: 0;
  background: #fff;
  border-top: 1px solid #ebedf0;
  padding: 3px 4px;
  padding-bottom: max(3px, env(safe-area-inset-bottom));
}

.composer-inner {
  display: flex;
  align-items: flex-end;
  gap: 8px;

  .composer-field {
    flex: 1;
    background: #f7f8fa;
    border-radius: 8px;
    border: 1px solid #ebedf0;

    :deep(.van-field__body) {
      padding: 2px 3px;
    }

    :deep(textarea) {
      font-size: 14px;
      max-height: 100px;
    }
  }

  .composer-actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
    align-items: center;

    .send-btn, .stop-btn {
      width: 56px;
    }

    .clear-btn {
      width: 56px;
    }
  }
}

// 会话抽屉
.session-drawer {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid #ebedf0;

    .drawer-title {
      font-size: 16px;
      font-weight: 600;
      color: #323233;
    }
  }

  .session-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
  }
}

.session-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  cursor: pointer;
  border-radius: 0;
  transition: background 0.2s;

  &:active, &.is-active {
    background: #f0f7ff;
  }

  &.is-active .session-item-title {
    color: #1989fa;
    font-weight: 500;
  }

  .session-item-content {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;

    .session-icon {
      color: #c8c9cc;
      flex-shrink: 0;
    }
  }

  .session-item-info {
    flex: 1;
    min-width: 0;

    .session-item-title {
      font-size: 14px;
      color: #323233;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-item-meta {
      font-size: 11px;
      color: #c8c9cc;
      margin-top: 2px;
    }
  }

  .session-delete-btn {
    flex-shrink: 0;
    margin-left: 8px;
  }
}
</style>
