<template>
  <div class="memory-page">
    <!-- ========== 顶部导航栏 ========== -->
    <el-header class="app-header">
      <div class="header-left">
        <h1 class="app-title">AI 模型管理平台</h1>
        <el-menu
          :default-active="'memory-' + memoryType"
          mode="horizontal"
          :ellipsis="false"
          class="header-nav-menu"
          @select="handleNavSelect">
          <el-menu-item index="home">
            <el-icon><Management /></el-icon>
            模型管理
          </el-menu-item>
          <el-menu-item index="memory-user">
            <el-icon><Document /></el-icon>
            模型记忆
          </el-menu-item>
          <el-menu-item index="memory-skills">
            <el-icon><Tools /></el-icon>
            处置方案
          </el-menu-item>
        </el-menu>
      </div>
      <div class="header-right">
        <el-button text @click="$router.push('/change-password')">
          <el-icon><Lock /></el-icon>
          修改密码
        </el-button>
        <el-button text type="danger" @click="handleLogout">
          <el-icon><SwitchButton /></el-icon>
          注销
        </el-button>
        <span class="username">{{ username }}</span>
      </div>
    </el-header>

    <!-- ========== 主内容区 ========== -->
    <el-main class="app-main">
      <el-card class="memory-card-wrapper">
        <template #header>
          <div class="card-header">
            <div class="left">
              <span class="section-title">{{ isUser ? '模型记忆' : '处置方案' }}列表</span>
              <span class="item-count">共 {{ list.length }} 条</span>
            </div>
            <div class="right">
              <el-button size="small" class="header-btn" @click="showMcpConfig = true">
                <el-icon><InfoFilled /></el-icon>
                使用说明
              </el-button>
              <el-button type="primary" size="small" class="header-btn" @click="openAddDialog">
                <el-icon><Plus /></el-icon>
                新增
              </el-button>
            </div>
          </div>
        </template>

        <!-- 新增弹窗 -->
        <el-dialog
          v-model="addDialogVisible"
          title="新增记录"
          width="500px"
          :close-on-click-modal="false"
          @close="resetAddForm">
          <el-form :model="addForm" label-width="100px">
            <el-form-item label="标题">
              <el-input v-model="addForm.description" placeholder="输入标题（description）" maxlength="500" />
            </el-form-item>
            <el-form-item label="内容">
              <el-input
                v-model="addForm.content"
                type="textarea"
                :rows="8"
                placeholder="输入内容（content）"
                maxlength="100000"
                show-word-limit />
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="addDialogVisible = false">取消</el-button>
            <el-button type="primary" @click="handleAddSubmit" :loading="addLoading">提交</el-button>
          </template>
        </el-dialog>

        <!-- 数据卡片网格 -->
        <div v-if="list.length > 0" class="memory-grid">
          <MemoryCard
            v-for="item in list"
            :key="item.id"
            :item="item"
            @detail="handleDetail"
            @delete="handleDelete" />
        </div>
        <el-empty v-else description="暂无数据" />

        <!-- 暂无数据或加载中 -->
        <div v-if="loading" class="loading-mask">
          <el-icon class="loading-icon" :size="24"><Loading /></el-icon>
          <span>加载中...</span>
        </div>
      </el-card>
    </el-main>

    <!-- 详情对话框 -->
    <MemoryDetailDialog
      ref="detailDialogRef"
      :memory-type="memoryType"
      @saved="onItemSaved" />

    <!-- MCP 配置说明 -->
    <el-dialog
      v-model="showMcpConfig"
      title="MCP 配置说明"
      width="680px"
      :close-on-click-modal="false">
      <div class="mcp-config-body">
        <p class="mcp-config-desc">
          在支持 MCP 的客户端（如 Claude Desktop）中添加以下配置，即可通过 MCP 协议访问
          <strong>{{ isUser ? '模型记忆' : '处置方案' }}</strong>数据：
        </p>
        <el-alert
          title="使用约定"
          type="info"
          :description="'AI 模型仅当用户明确提到「' + (isUser ? '记忆' : '处置方案') + '」文字时才会触发此 MCP 服务，例如「添加' + (isUser ? '记忆' : '处置方案') + '」「从' + (isUser ? '记忆中查询' : '处置方案中搜索') + '」等。'"
          show-icon
          closable
          style="margin-bottom: 12px;" />
        <el-alert
          v-if="mcpApiKey"
          title="已检测到 API Key"
          type="warning"
          :description="'当前已设置 API Key，MCP 配置中已自动添加 Authorization 头。如果后续修改了 API Key，请更新此配置。'"
          show-icon
          closable
          style="margin-bottom: 12px;" />
        <el-input
          type="textarea"
          :rows="12"
          :model-value="mcpConfigJson"
          readonly
          class="mcp-config-textarea" />
        <div style="margin-top: 12px; text-align: right;">
          <el-button type="primary" @click="copyMcpConfig">
            <el-icon><CopyDocument /></el-icon>
            复制配置
          </el-button>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  getMemoryList,
  createMemory,
  deleteMemory,
  type AgentMemoryItem,
} from '@/api/agentMemoryService';
import MemoryCard from '@/components/MemoryCard/index.vue';
import MemoryDetailDialog from '@/components/MemoryDetailDialog/index.vue';
import { Management, Tools, Document, ArrowLeft, Plus, Delete, Edit, Check, View, Lock, SwitchButton, User, Loading, Folder, InfoFilled, CopyDocument } from '@element-plus/icons-vue';

const route = useRoute();
const router = useRouter();

const memoryType = computed(() => (route.params.type === 'skills' ? 'skills' : 'user'));
const isUser = computed(() => memoryType.value === 'user');

const username = localStorage.getItem('auth_username') || '';
const currentOrigin = window.location.origin;
const mcpApiKey = computed(() => localStorage.getItem('custom_api_key') || '');

const showMcpConfig = ref(false);

const mcpConfigJson = computed(() => {
  const key = isUser.value ? 'memory' : 'skills';
  const serverName = `ai-models-manager-${key}`;
  const label = isUser.value ? '模型记忆' : '处置方案';
  const url = `${currentOrigin}/${username}/${key}/mcp`;
  const config: Record<string, any> = {
    mcpServers: {
      [serverName]: {
        type: 'http',
        url,
      },
    },
  };
  if (mcpApiKey.value) {
    config.mcpServers[serverName].headers = {
      Authorization: `Bearer ${mcpApiKey.value}`,
    };
  }
  return JSON.stringify(config, null, 2);
});

const copyMcpConfig = () => {
  const text = mcpConfigJson.value;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      ElMessage.success('已复制到剪贴板');
    }).catch(() => {
      fallbackCopy(text);
    });
  } else {
    fallbackCopy(text);
  }
};

const fallbackCopy = (text: string) => {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    document.execCommand('copy');
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.error('复制失败');
  }
  document.body.removeChild(textarea);
};
const list = ref<AgentMemoryItem[]>([]);
const loading = ref(false);
const addDialogVisible = ref(false);
const addLoading = ref(false);
const addForm = ref({ description: '', content: '' });
const detailDialogRef = ref<InstanceType<typeof MemoryDetailDialog> | null>(null);

const handleNavSelect = (index: string) => {
  if (index === 'home') {
    router.push('/');
  } else if (index === 'memory-user') {
    router.push('/memory/user');
  } else if (index === 'memory-skills') {
    router.push('/memory/skills');
  }
};

const fetchList = async () => {
  loading.value = true;
  try {
    const res = await getMemoryList(memoryType.value);
    if (res.success) {
      list.value = res.data as AgentMemoryItem[];
    }
  } catch (err: any) {
    // ignore
  } finally {
    loading.value = false;
  }
};

const handleDetail = (item: AgentMemoryItem) => {
  detailDialogRef.value?.openDialog(item);
};

const handleDelete = async (item: AgentMemoryItem) => {
  try {
    await ElMessageBox.confirm('确定要删除这条记录吗？', '确认删除', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    });
    const res = await deleteMemory(memoryType.value, item.id);
    if (res.success) {
      ElMessage.success('删除成功');
      list.value = list.value.filter((i) => i.id !== item.id);
    } else {
      ElMessage.error(res.message || '删除失败');
    }
  } catch {
    // cancelled
  }
};

const openAddDialog = () => {
  addForm.value = { description: '', content: '' };
  addDialogVisible.value = true;
};

const resetAddForm = () => {
  addForm.value = { description: '', content: '' };
};

const handleAddSubmit = async () => {
  if (!addForm.value.description?.trim() && !addForm.value.content?.trim()) {
    ElMessage.warning('标题和内容不能同时为空');
    return;
  }
  addLoading.value = true;
  try {
    const res = await createMemory(
      memoryType.value,
      addForm.value.description || null,
      addForm.value.content || null
    );
    if (res.success) {
      ElMessage.success('新增成功');
      addDialogVisible.value = false;
      await fetchList();
    } else {
      ElMessage.error(res.message || '新增失败');
    }
  } catch (err: any) {
    ElMessage.error(err?.response?.data?.message || '新增失败');
  } finally {
    addLoading.value = false;
  }
};

const onItemSaved = (item: AgentMemoryItem) => {
  const idx = list.value.findIndex((i) => i.id === item.id);
  if (idx >= 0) {
    list.value[idx] = item;
  }
};

const goHome = () => {
  router.push('/');
};

const handleLogout = () => {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_username');
  localStorage.removeItem('auth_expire_at');
  localStorage.removeItem('auth_role');
  router.push('/login');
};

onMounted(() => {
  fetchList();
});
</script>

<style scoped lang="less">
.memory-page {
  min-height: 100vh;
  background: #f0f2f5;
  display: flex;
  flex-direction: column;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  padding: 0 24px;
  height: 56px;

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

    .header-nav-menu {
      border-bottom: none;
      background: transparent;

      .el-menu-item {
        height: 56px;
        line-height: 56px;
        font-size: 14px;
      }
    }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 4px;

    .username {
      margin-left: 8px;
      font-size: 13px;
      color: #909399;
    }
  }
}

.app-main {
  flex: 1;
  padding: 20px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.memory-card-wrapper {
  position: relative;
  flex: 1;
  min-height: 0;

  :deep(.el-card__body) {
    height: calc(100% - 56px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;

    .left {
      display: flex;
      align-items: center;
      gap: 10px;

      .section-title {
        font-size: 15px;
        font-weight: 600;
      }

      .item-count {
        font-size: 13px;
        color: #909399;
      }
    }

    .right {
      display: flex;
      gap: 8px;
      align-items: center;

      .header-btn {
        --el-button-size: 32px;
        height: 32px;
        padding: 8px 15px;
        margin-left: 0 !important;
      }
    }
  }
}

.memory-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
  align-items: stretch;
  flex: 1;
  align-content: start;

  > * {
    height: 100%;
    width: 100%;
  }
}

.loading-mask {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 0;
  color: #909399;
  gap: 8px;

  .loading-icon {
    animation: rotating 1.5s linear infinite;
  }
}

@keyframes rotating {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.mcp-config-body {
  .mcp-config-desc {
    font-size: 14px;
    color: #606266;
    line-height: 1.6;
    margin-bottom: 16px;
  }
}

.mcp-config-textarea :deep(textarea) {
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.5;
  color: #303133;
}
</style>
