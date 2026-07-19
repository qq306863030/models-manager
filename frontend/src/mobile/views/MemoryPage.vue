<template>
  <div class="mobile-memory-page">
    <!-- 顶部导航 -->
    <van-nav-bar
      :title="isUser ? '模型记忆' : '处置方案'"
      left-text="返回"
      left-arrow
      @click-left="goHome">
      <template #right>
        <van-icon name="info-o" size="18" style="margin-right: 12px;" @click="showMcpConfig = true" />
        <van-icon name="plus" size="20" @click="openAddDialog" />
      </template>
    </van-nav-bar>

    <!-- 类型切换 tabs -->
    <van-tabs v-model:active="activeTab" @change="onTabChange">
      <van-tab title="模型记忆" name="user" />
      <van-tab title="处置方案" name="skills" />
    </van-tabs>

    <!-- 列表 -->
    <div class="content">
      <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
        <div class="memory-list" v-if="list.length > 0">
          <div
            class="mobile-memory-card"
            v-for="item in list"
            :key="item.id">
            <div class="card-body">
              <div class="card-title">{{ item.description || '（无标题）' }}</div>
              <div class="card-content">{{ item.content || '（无内容）' }}</div>
            </div>
            <div class="card-actions">
              <van-button size="small" type="primary" plain @click="handleDetail(item)">查看详情</van-button>
              <van-button size="small" type="danger" plain @click="handleDelete(item)">删除</van-button>
            </div>
          </div>
        </div>
        <van-empty v-else description="暂无数据" />
      </van-pull-refresh>
    </div>

    <!-- 新增弹窗 -->
    <van-popup v-model:show="addDialogVisible" position="bottom" round style="height: 60%">
      <div class="popup-container">
        <van-nav-bar
          title="新增记录"
          left-text="取消"
          right-text="提交"
          @click-left="addDialogVisible = false"
          @click-right="handleAddSubmit" />
        <van-cell-group inset style="margin-top: 12px;">
          <van-field v-model="addForm.description" label="标题" placeholder="输入标题（description）" />
          <van-field
            v-model="addForm.content"
            type="textarea"
            label="内容"
            placeholder="输入内容（content）"
            rows="6"
            autosize />
        </van-cell-group>
      </div>
    </van-popup>

    <!-- 详情弹窗 -->
    <van-popup v-model:show="detailVisible" position="bottom" round style="height: 70%">
      <div class="popup-container" v-if="currentItem">
        <van-nav-bar
          :title="isEditing ? '编辑记录' : '详情'"
          left-text="关闭"
          @click-left="closeDetail">
          <template #right>
            <span v-if="!isEditing" @click="enterEdit" style="color: #1989fa;">编辑</span>
            <span v-else @click="handleSave" style="color: #1989fa;">保存</span>
          </template>
        </van-nav-bar>
        <div class="detail-body" style="padding: 16px;">
          <van-cell-group inset>
            <van-field
              v-model="editForm.description"
              label="标题"
              :readonly="!isEditing"
              :border="false" />
            <van-field
              v-model="editForm.content"
              type="textarea"
              label="内容"
              :readonly="!isEditing"
              rows="10"
              autosize
              :border="false" />
          </van-cell-group>
        </div>
      </div>
    </van-popup>

    <!-- MCP 配置说明 -->
    <van-popup v-model:show="showMcpConfig" position="bottom" round style="height: 60%">
      <div class="popup-container">
        <van-nav-bar title="MCP 配置说明" left-text="关闭" @click-left="showMcpConfig = false">
          <template #right>
            <span @click="copyMcpConfig" style="color: #1989fa;">复制</span>
          </template>
        </van-nav-bar>
        <div class="mcp-config-body" style="padding: 12px 16px; overflow-y: auto; flex: 1;">
          <p style="font-size: 13px; color: #646566; line-height: 1.5; margin-bottom: 12px;">
            在支持 MCP 的客户端中添加以下配置，即可通过 MCP 协议访问
            <strong>{{ isUser ? '模型记忆' : '处置方案' }}</strong>数据：
          </p>
          <van-notice-bar
            text="使用约定：AI 模型仅当用户明确提到「记忆」或「处置方案」文字时才会触发此 MCP 服务，例如「添加记忆」「从处置方案中搜索」等。"
            color="#409eff"
            background="#ecf5ff"
            style="margin-bottom: 8px;" />
          <van-notice-bar v-if="mcpApiKey" text="已检测到 API Key，配置中已自动添加 Authorization 头。" color="#e6a23c" background="#fdf6ec" style="margin-bottom: 8px;" />
          <pre class="mcp-config-pre">{{ mcpConfigJson }}</pre>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { showToast, showConfirmDialog, showLoadingToast, closeToast } from 'vant';
import {
  getMemoryList,
  createMemory,
  updateMemory,
  deleteMemory,
  type AgentMemoryItem,
} from '@/api/agentMemoryService';

const router = useRouter();
const list = ref<AgentMemoryItem[]>([]);
const refreshing = ref(false);
const activeTab = ref<'user' | 'skills'>('user');
const addDialogVisible = ref(false);
const detailVisible = ref(false);
const isEditing = ref(false);
const currentItem = ref<AgentMemoryItem | null>(null);
const addForm = ref({ description: '', content: '' });
const editForm = ref({ description: '', content: '' });
const showMcpConfig = ref(false);

const isUser = computed(() => activeTab.value === 'user');
const username = localStorage.getItem('auth_username') || '';
const currentOrigin = window.location.origin;
const mcpApiKey = computed(() => localStorage.getItem('custom_api_key') || '');

const mcpConfigJson = computed(() => {
  const key = activeTab.value;
  const serverName = `ai-models-manager-${key === 'user' ? 'memory' : 'skills'}`;
  const label = key === 'user' ? '模型记忆' : '处置方案';
  const url = `${currentOrigin}/${username}/${key === 'user' ? 'memory' : 'skills'}/mcp`;
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
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('已复制');
  } catch {
    showToast('复制失败');
  }
};

const fetchList = async () => {
  try {
    const res = await getMemoryList(activeTab.value);
    if (res.success) {
      list.value = res.data as AgentMemoryItem[];
    }
  } catch {
    // ignore
  }
};

const onRefresh = async () => {
  await fetchList();
  refreshing.value = false;
};

const onTabChange = () => {
  fetchList();
};

const goHome = () => {
  router.push('/m/');
};

const openAddDialog = () => {
  addForm.value = { description: '', content: '' };
  addDialogVisible.value = true;
};

const handleAddSubmit = async () => {
  if (!addForm.value.description?.trim() && !addForm.value.content?.trim()) {
    showToast('标题和内容不能同时为空');
    return;
  }
  addDialogVisible.value = false;
  showLoadingToast({ message: '提交中...', forbidClick: true });
  try {
    const res = await createMemory(
      activeTab.value,
      addForm.value.description || null,
      addForm.value.content || null
    );
    closeToast();
    if (res.success) {
      showToast('新增成功');
      await fetchList();
    } else {
      showToast(res.message || '新增失败');
    }
  } catch {
    closeToast();
    showToast('新增失败');
  }
};

const handleDetail = (item: AgentMemoryItem) => {
  currentItem.value = { ...item };
  editForm.value = {
    description: item.description || '',
    content: item.content || '',
  };
  isEditing.value = false;
  detailVisible.value = true;
};

const enterEdit = () => {
  isEditing.value = true;
};

const closeDetail = () => {
  detailVisible.value = false;
  isEditing.value = false;
  currentItem.value = null;
};

const handleSave = async () => {
  if (!currentItem.value) return;
  const id = currentItem.value.id;
  detailVisible.value = false;
  showLoadingToast({ message: '保存中...', forbidClick: true });
  try {
    const res = await updateMemory(
      activeTab.value,
      id,
      editForm.value.description || null,
      editForm.value.content || null
    );
    closeToast();
    if (res.success) {
      showToast('保存成功');
      await fetchList();
    } else {
      showToast(res.message || '保存失败');
    }
  } catch {
    closeToast();
    showToast('保存失败');
  }
  isEditing.value = false;
  currentItem.value = null;
};

const handleDelete = async (item: AgentMemoryItem) => {
  try {
    await showConfirmDialog({ title: '提示', message: '确定要删除这条记录吗？' });
    showLoadingToast({ message: '删除中...', forbidClick: true });
    const res = await deleteMemory(activeTab.value, item.id);
    closeToast();
    if (res.success) {
      showToast('删除成功');
      list.value = list.value.filter((i) => i.id !== item.id);
    } else {
      showToast(res.message || '删除失败');
    }
  } catch {
    // cancelled
  }
};

onMounted(() => {
  fetchList();
});
</script>

<style scoped lang="less">
.mobile-memory-page {
  min-height: 100vh;
  background: #f7f8fa;
}

.content {
  padding: 0 0 16px;
}

.memory-list {
  padding: 8px 12px;
  width: 100%;
  box-sizing: border-box;
}

.mobile-memory-card {
  background: #fff;
  border-radius: 8px;
  padding: 14px;
  margin-bottom: 10px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
  width: 100%;

  .card-body {
    width: 100%;

    .card-title {
      font-size: 15px;
      font-weight: 600;
      color: #323233;
      line-height: 1.4;
      margin-bottom: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      width: 100%;
    }

    .card-content {
      font-size: 13px;
      color: #646566;
      line-height: 1.5;
      word-break: break-all;
      width: 100%;
    }
  }

  .card-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 12px;
    padding-top: 10px;
    border-top: 1px solid #f0f0f0;
  }
}

.popup-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.detail-body {
  flex: 1;
  overflow-y: auto;
}

.mcp-config-pre {
  background: #f5f5f5;
  border: 1px solid #e8e8e8;
  border-radius: 6px;
  padding: 12px;
  font-size: 12px;
  font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
  line-height: 1.5;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-all;
  margin: 8px 0;
}
</style>
