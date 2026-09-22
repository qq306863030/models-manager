<template>
  <aside class="chat-sidebar">
    <!-- 顶部新建按钮 -->
    <div class="sidebar-header">
      <button type="button" class="new-chat-btn" @click="$emit('new-session')">
        <el-icon><Plus /></el-icon>
        <span>新建对话</span>
      </button>
    </div>

    <!-- 搜索框 -->
    <div class="search-box-wrap">
      <el-input
        v-model="searchKeyword"
        placeholder="搜索会话..."
        size="small"
        clearable
        :prefix-icon="Search"
      />
    </div>

    <!-- 会话列表 -->
    <div class="session-list">
      <div
        v-for="session in filteredSessions"
        :key="session.id"
        class="session-item"
        :class="{ 'is-active': session.id === currentSessionId }"
        @click="$emit('switch-session', session.id)"
      >
        <div class="item-icon">
          <el-icon><ChatDotRound /></el-icon>
        </div>

        <div class="item-content">
          <div class="item-title" :title="getSessionDisplayTitle(session)">
            {{ getSessionDisplayTitle(session) }}
          </div>
          <div class="item-desc" :title="getLastMessageSnippet(session)">
            {{ getLastMessageSnippet(session) }}
          </div>
        </div>

        <!-- 悬停操作按钮 -->
        <div class="item-actions" @click.stop>
          <el-dropdown trigger="click" @command="(cmd: string) => handleCommand(cmd, session)">
            <button type="button" class="more-btn">
              <el-icon><MoreFilled /></el-icon>
            </button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="rename">
                  <el-icon><Edit /></el-icon> 重命名
                </el-dropdown-item>
                <el-dropdown-item command="delete" divided style="color: #f56c6c">
                  <el-icon><Delete /></el-icon> 删除会话
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </div>

      <div v-if="filteredSessions.length === 0" class="empty-sessions">
        <span>无匹配会话</span>
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { Plus, Search, ChatDotRound, MoreFilled, Edit, Delete } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import type { IChatSession } from '../composables/useChatStore';
import {
  getSessionDisplayTitle,
  getLastMessageSnippet,
  matchSessionKeyword,
} from '../utils/sessionDisplay';

const props = defineProps<{
  sessions: IChatSession[];
  currentSessionId: string;
}>();

const emit = defineEmits<{
  (e: 'new-session'): void;
  (e: 'switch-session', id: string): void;
  (e: 'delete-session', id: string): void;
  (e: 'rename-session', id: string, newTitle: string): void;
}>();

const searchKeyword = ref('');

const filteredSessions = computed(() => {
  if (!searchKeyword.value.trim()) return props.sessions;
  return props.sessions.filter((s) => matchSessionKeyword(s, searchKeyword.value));
});

function handleCommand(command: string, session: IChatSession) {
  if (command === 'rename') {
    ElMessageBox.prompt('请输入新的会话标题', '重命名会话', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      inputValue: session.title,
    })
      .then(({ value }) => {
        if (value && value.trim()) {
          emit('rename-session', session.id, value.trim());
        }
      })
      .catch(() => {});
  } else if (command === 'delete') {
    ElMessageBox.confirm(`确定删除会话 "${session.title}" 吗？此操作不可撤销。`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
      .then(() => {
        emit('delete-session', session.id);
      })
      .catch(() => {});
  }
}
</script>

<style scoped lang="less">
.chat-sidebar {
  width: 260px;
  height: 100%;
  background-color: #ffffff;
  border-right: 1px solid #e4e7ed;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;

  .sidebar-header {
    padding: 14px 14px 10px;

    .new-chat-btn {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 14px;
      background-color: #ecf5ff;
      border: 1px dashed #409eff;
      color: #409eff;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s;

      &:hover {
        background-color: #409eff;
        color: #ffffff;
      }
    }
  }

  .search-box-wrap {
    padding: 0 14px 10px;
  }

  .session-list {
    flex: 1;
    overflow-y: auto;
    padding: 0 8px 14px;

    .session-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 10px;
      margin-bottom: 4px;
      border-radius: 6px;
      cursor: pointer;
      position: relative;
      transition: background-color 0.2s;

      &:hover {
        background-color: #f2f6fc;

        .item-actions {
          opacity: 1;
        }
      }

      &.is-active {
        background-color: #e6f1fc;
        .item-icon {
          color: #409eff;
        }
        .item-title {
          color: #409eff;
          font-weight: 600;
        }
      }

      .item-icon {
        font-size: 16px;
        color: #909399;
        flex-shrink: 0;
      }

      .item-content {
        flex: 1;
        min-width: 0;

        .item-title {
          font-size: 13px;
          color: #303133;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          margin-bottom: 2px;
        }

        .item-desc {
          font-size: 11px;
          color: #909399;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
      }

      .item-actions {
        opacity: 0;
        transition: opacity 0.2s;

        .more-btn {
          background: none;
          border: none;
          color: #909399;
          cursor: pointer;
          padding: 2px;
          display: flex;
          align-items: center;
          border-radius: 4px;

          &:hover {
            color: #303133;
          }
        }
      }
    }

    .empty-sessions {
      padding: 30px 0;
      text-align: center;
      font-size: 12px;
      color: #909399;
    }
  }
}
</style>
