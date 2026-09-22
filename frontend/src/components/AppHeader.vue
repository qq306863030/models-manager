<template>
  <el-header class="app-header">
    <div class="header-left">
      <h1 class="app-title">AI 模型管理平台</h1>
      <div class="header-nav-links">
        <el-button
          :type="currentNav === 'home' ? 'primary' : 'text'"
          @click="handleNavSelect('home')">
          <el-icon><Management /></el-icon>
          模型管理
        </el-button>
        <el-button
          :type="currentNav === 'memory-user' ? 'primary' : 'text'"
          @click="handleNavSelect('memory-user')">
          <el-icon><Document /></el-icon>
          模型记忆
        </el-button>
        <el-button
          :type="currentNav === 'memory-skills' ? 'primary' : 'text'"
          @click="handleNavSelect('memory-skills')">
          <el-icon><Tools /></el-icon>
          处置方案
        </el-button>
        <el-button
          :type="currentNav === 'memory-docs' ? 'primary' : 'text'"
          @click="handleNavSelect('memory-docs')">
          <el-icon><Reading /></el-icon>
          我的文档
        </el-button>
        <el-button
          :type="currentNav === 'files' ? 'primary' : 'text'"
          @click="handleNavSelect('files')">
          <el-icon><FolderOpened /></el-icon>
          我的文件
        </el-button>
        <el-button
          :type="currentNav === 'chat' ? 'primary' : 'text'"
          @click="handleNavSelect('chat')">
          <el-icon><ChatDotRound /></el-icon>
          AI聊天
        </el-button>
      </div>
    </div>
    <div class="header-right">
      <!-- 用户管理入口（仅管理员显示） -->
      <el-button
        v-if="isAdmin"
        text
        @click="$router.push('/user-manage')">
        <el-icon><User /></el-icon>
        用户管理
      </el-button>

      <!-- 修改密码 -->
      <el-button text @click="$router.push('/change-password')">
        <el-icon><Lock /></el-icon>
        修改密码
      </el-button>

      <!-- 注销 -->
      <el-button text type="danger" @click="handleLogout">
        <el-icon><SwitchButton /></el-icon>
        注销
      </el-button>

      <!-- 用户名显示 -->
      <span class="username">{{ username }}</span>
    </div>
  </el-header>
</template>

<script setup lang="ts">
import { computed } from 'vue';
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

const props = defineProps<{
  currentNav: string;
}>();

const router = useRouter();

const username = computed(() => localStorage.getItem('auth_username') || '');
const isAdmin = computed(() => {
  const role = localStorage.getItem('auth_role');
  return role === 'admin' || username.value === 'admin';
});

function handleNavSelect(key: string) {
  if (key === props.currentNav) return;
  if (key === 'home') router.push('/');
  else if (key === 'memory-user') router.push('/memory/user');
  else if (key === 'memory-skills') router.push('/memory/skills');
  else if (key === 'memory-docs') router.push('/memory/docs');
  else if (key === 'files') router.push('/files');
  else if (key === 'chat') router.push('/chat');
}

function handleLogout() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_username');
  localStorage.removeItem('auth_role');
  localStorage.removeItem('auth_expire_at');
  router.push('/login');
}
</script>

<style scoped lang="less">
.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  padding: 0 24px;
  height: 56px;
  box-sizing: border-box;
  flex-shrink: 0;

  .header-left {
    display: flex;
    align-items: center;
    gap: 16px;

    .app-title {
      font-size: 18px;
      font-weight: 600;
      color: #303133;
      margin: 0;
      white-space: nowrap;
    }

    .header-nav-links {
      display: flex;
      align-items: center;
      gap: 2px;

      :deep(.el-button),
      .el-button {
        height: 56px;
        border: none;
        border-radius: 0;
        font-size: 14px;
        padding: 0 16px;
        transition: background 0.2s;
        margin: 0;

        .el-icon {
          margin-right: 5px;
        }

        &.el-button--primary {
          background: #f0f2f5;
          color: #303133;
          font-weight: 500;
          --el-button-bg-color: #f0f2f5;
          --el-button-border-color: transparent;
          --el-button-hover-bg-color: #f0f2f5;
          --el-button-hover-border-color: transparent;
          --el-button-active-bg-color: #f0f2f5;
          --el-button-active-border-color: transparent;
        }

        &.el-button--text {
          color: #606266;
          font-weight: 400;
          --el-button-text-color: #606266;
          --el-button-hover-text-color: #303133;
        }
      }
    }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 8px;

    .username {
      margin-left: 12px;
      padding-left: 12px;
      border-left: 1px solid #e4e7ed;
      color: #606266;
      font-size: 14px;
    }
  }
}
</style>
