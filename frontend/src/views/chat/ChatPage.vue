<template>
  <div class="ai-chat-page">
    <!-- ========== 顶部统一导航栏 ========== -->
    <AppHeader current-nav="chat" />

    <!-- ========== 聊天工作台主内容区 ========== -->
    <div class="chat-workspace-body">
      <!-- 左侧多会话列表抽屉 -->
      <ChatSidebar
        v-show="!sidebarCollapsed"
        :sessions="sessions"
        :current-session-id="currentSessionId"
        @new-session="handleNewSession"
        @switch-session="switchSession"
        @delete-session="deleteSession"
        @rename-session="updateSessionTitle"
      />

      <!-- 右侧对话视口 -->
      <main class="chat-main-viewport">
        <ChatHeader
          :title="currentSession?.title || '新对话'"
          :model-name="currentSession?.modelName || ''"
          :available-models="availableModels"
          :is-models-loading="isModelsLoading"
          :sidebar-collapsed="sidebarCollapsed"
          @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
          @update-title="(t) => updateSessionTitle(currentSessionId, t)"
          @change-model="setSessionModel"
        />

        <ChatMessageList
          :messages="currentSession?.messages || []"
          :is-streaming="isStreaming"
        />

        <ChatComposer
          :is-streaming="isStreaming"
          @send="handleSendMessage"
          @stop="stopGeneration"
          @clear="clearCurrentMessages"
        />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import {
  Management,
  Document,
  Tools,
  Reading,
  FolderOpened,
  ChatDotRound,
  User,
  Lock,
  SwitchButton,
} from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import AppHeader from '@/components/AppHeader.vue';
import { useChatStore, type IAttachmentView } from './composables/useChatStore';
import ChatSidebar from './components/ChatSidebar.vue';
import ChatHeader from './components/ChatHeader.vue';
import ChatMessageList from './components/ChatMessageList.vue';
import ChatComposer from './components/ChatComposer.vue';

const router = useRouter();
const currentNav = ref('chat');
const sidebarCollapsed = ref(false);

const username = computed(() => localStorage.getItem('auth_username') || '未知用户');
const isAdmin = computed(() => {
  const role = localStorage.getItem('auth_role');
  return role === 'admin' || username.value === 'admin';
});

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
  updateSessionTitle,
  clearCurrentMessages,
  setSessionModel,
  sendMessage,
  stopGeneration,
} = useChatStore();

function handleNavSelect(key: string) {
  if (key === 'home') router.push('/');
  else if (key === 'memory-user') router.push('/memory?type=user');
  else if (key === 'memory-skills') router.push('/memory?type=skills');
  else if (key === 'memory-docs') router.push('/memory?type=docs');
  else if (key === 'files') router.push('/files');
  else if (key === 'chat') router.push('/chat');
}

function handleLogout() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_username');
  localStorage.removeItem('auth_role');
  router.push('/login');
}

function handleNewSession() {
  createNewSession();
}

async function handleSendMessage(text: string, attachments: IAttachmentView[]) {
  try {
    await sendMessage(text, attachments);
  } catch (err: any) {
    ElMessage.error(err.message || '发送失败');
  }
}

onMounted(async () => {
  await loadModels();
  initSessions();
});
</script>

<style scoped lang="less">
.ai-chat-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background-color: #f5f7fa;


  .chat-workspace-body {
    flex: 1;
    display: flex;
    overflow: hidden;
    position: relative;

    .chat-main-viewport {
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100%;
      min-width: 0;
      background-color: #ffffff;
    }
  }
}
</style>
