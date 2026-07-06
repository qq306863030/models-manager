<template>
  <div class="home-page">
    <div class="custom-navbar">
      <div class="navbar-title">AI模型管理</div>
      <div class="navbar-actions">
        <van-button type="primary" size="small" @click="openAddDialog">添加</van-button>
        <van-button size="small" @click="openApiDialog">接口</van-button>
        <van-button size="small" @click="settingsDialogVisible = true">设置</van-button>
        <van-button size="small" type="danger" @click="handleLogout">注销</van-button>
      </div>
    </div>

    <div class="content">
      <div class="model-section">
        <div class="section-header">
          <span class="section-title">模型列表</span>
          <span class="model-count">共 {{ modelList.length }} 个</span>
        </div>
        <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
          <div class="model-list">
            <MobileModelCard
              v-for="(model, index) in modelList"
              :key="model.id"
              :model="model"
              :is-selected="selectedModelId === model.id"
              :stat-summary="modelStatMap.get(model.id)"
              @select="selectModel"
              @copy="handleCopy"
              @delete="handleDelete"
              @toggle-lock="handleToggleLock"
              @toggle-disable="handleToggleDisable"
              @submit-edit="handleEditSubmit"
              @move-up="handleMoveUp(index)"
              @move-down="handleMoveDown(index)"
            />
            <van-empty v-if="modelList.length === 0" description="暂无模型" />
          </div>
        </van-pull-refresh>
      </div>

      <!-- 总体统计图表 -->
      <MobileTokenChart :data="allStats" :loading="statsLoading" title="总体消耗趋势" />

      <!-- 当前选中模型统计图表 -->
      <MobileTokenChart
        v-if="selectedModelId && selectedModelStats.length > 0"
        :data="selectedModelStats"
        :loading="statsLoading"
        :title="`【${selectedModelName}】消耗趋势`"
      />
      <div v-else-if="selectedModelId" class="no-stat-hint">
        暂无 {{ selectedModelName }} 的统计数据
      </div>
    </div>

    <!-- 添加模型弹窗 -->
    <van-popup v-model:show="addDialogVisible" position="bottom" round style="height: 80%">
      <div class="popup-container">
        <van-nav-bar title="添加模型" left-text="取消" right-text="保存" @click-left="addDialogVisible = false" @click-right="handleAddSubmit" />
        <van-cell-group inset>
          <van-field v-model="addForm.url" label="URL" placeholder="如: https://api.deepseek.com" />
          <van-field v-model="addForm.api_key" type="password" label="API Key" placeholder="请输入 API Key" />
          <van-field v-model="newItem.name" label="显示名称" placeholder="如: DeepSeek_V3" />
          <van-field v-model="newItem.model_name" label="模型名称" placeholder="如: deepseek-v3-20250620" />
          <van-field v-model.number="newItem.max_content_length" type="number" label="Max Content" />
          <van-field v-model.number="newItem.max_token" type="number" label="Max Token" />
        </van-cell-group>
      </div>
    </van-popup>

    <!-- 设置弹窗 -->
    <van-popup v-model:show="settingsDialogVisible" position="bottom" round style="height: 60%">
      <div class="popup-container">
        <van-nav-bar title="设置" left-text="关闭" @click-left="settingsDialogVisible = false" />
        <van-cell-group inset>
          <van-cell title="用户名" :value="username" />
          <van-cell title="角色" :value="isAdmin ? '管理员' : '普通用户'" />
          <van-cell title="模型数量" :value="String(modelList.length)" />
        </van-cell-group>
        <div style="padding: 16px;">
          <van-button block type="primary" @click="router.push('/m/change-password')">修改密码</van-button>
          <van-button v-if="isAdmin" block type="primary" style="margin-top: 12px;" @click="router.push('/m/user-manage')">用户管理</van-button>
        </div>
      </div>
    </van-popup>

    <!-- API 设置弹窗 -->
    <van-popup v-model:show="apiDialogVisible" position="bottom" round style="height: 75%">
      <div class="popup-container">
        <van-nav-bar title="代理接口地址" left-text="关闭" @click-left="apiDialogVisible = false" />
        <div class="api-content">
          <!-- API Key 配置 -->
          <van-cell-group inset style="margin-bottom: 8px;">
            <van-field v-model="customApiKey" type="password" label="API Key" placeholder="可选，留空则使用模型的 Key" />
          </van-cell-group>
          <div style="padding: 0 16px 8px; display: flex; gap: 8px;">
            <van-button size="small" @click="handleGenerateKey">生成</van-button>
            <van-button v-if="customApiKey" size="small" @click="handleCopyKey">复制 Key</van-button>
            <van-button size="small" @click="handleClearKey">清除</van-button>
          </div>

          <!-- 调用地址 -->
          <div class="api-base-url">
            <span class="base-url-label">调用地址：</span>
            <code class="base-url-value" @click="copyText(currentOrigin + '/' + (username || 'default'))">
              {{ currentOrigin }}/{{ username || 'default' }}
            </code>
            <van-icon name="copy-o" size="14" style="margin-left:4px;color:#1989fa;" @click="copyText(currentOrigin + '/' + (username || 'default'))" />
            <div class="base-url-hint">如果生成了 Key，调用时需要填写 Authorization: Bearer &lt;Key&gt;</div>
          </div>

          <!-- 接口列表 -->
          <div class="endpoints-section">
            <div class="endpoints-title">可用接口</div>
            <div v-for="ep in proxyEndpoints" :key="ep.path" class="endpoint-item" @click="copyText(userProxyBaseUrl + ep.path)">
              <van-tag :type="ep.method === 'GET' ? 'success' : 'primary'" size="small" round>
                {{ ep.method }}
              </van-tag>
              <span class="endpoint-desc">{{ ep.desc }}</span>
              <van-icon name="copy-o" size="14" style="margin-left:auto;color:#c8c9cc;flex-shrink:0;" />
            </div>
          </div>
        </div>
      </div>
    </van-popup>

    <!-- 删除确认弹窗 -->
    <van-dialog v-model:show="deleteDialogVisible" title="删除模型" show-cancel-button :before-close="onDeleteConfirm">
      <div style="padding: 20px;">确定要删除模型 "{{ deletingModel?.name }}" 吗？此操作不可恢复。</div>
    </van-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from 'vant';
import MobileModelCard from '@/mobile/components/MobileModelCard.vue';
import MobileTokenChart from '@/mobile/components/MobileTokenChart.vue';
import {
  modelList, selectedModelId, statsLoading, allStats, modelStatMap,
  selectModel, handleCopy, handleDelete as doDelete, handleToggleLock,
  handleToggleDisable, handleEditSubmit, apiDialogVisible, customApiKey,
  openApiDialog, loadApiSettings, fetchModels, loadStats, loadLockDuration,
  checkAndRefreshLockStatus, selectedModelStats, selectedModelName, handleReorder
} from '@/composables/useModels';
import type { Model } from '@/api/modelService';

const router = useRouter();
const username = localStorage.getItem('auth_username') || '';
const isAdmin = computed(() => localStorage.getItem('auth_is_admin') === '1');

// 代理接口端点列表（与桌面端一致）
const currentOrigin = window.location.origin;
const proxyBaseUrl = ref(currentOrigin);
const userProxyBaseUrl = computed(() => {
  return `${proxyBaseUrl.value}/${username || 'default'}`;
});

const proxyEndpoints = [
  { method: 'GET',  path: '/v1/models',              desc: '获取模型列表' },
  { method: 'POST', path: '/v1/chat/completions',    desc: 'Chat Completions API（OpenAI 兼容）' },
  { method: 'POST', path: '/v1/responses',           desc: 'Responses API（OpenAI 兼容）' },
  { method: 'POST', path: '/v1/messages',            desc: 'Messages API（Anthropic 兼容）' },
  { method: 'GET',  path: '/api/tags',               desc: '获取模型列表（Ollama 兼容）' },
  { method: 'POST', path: '/api/show',               desc: '获取模型详情（Ollama 兼容）' },
  { method: 'GET',  path: '/api/version',            desc: '版本信息' },
  { method: 'GET',  path: '/v1/test',                desc: '测试接口' },
];

// 剪贴板复制
const copyText = async (text: string) => {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制');
  } catch {
    // 兼容旧浏览器
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('已复制');
  }
};

// API Key 操作
const handleGenerateKey = async () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const key = 'sk-' + Array.from({ length: 48 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  customApiKey.value = key;
  localStorage.setItem('custom_api_key', key);
  showToast('已生成新 Key');
  // 保存到后端
  const { updateUserSettings } = await import('@/api/userSettingsService');
  await updateUserSettings({ api_key: key });
};

const handleCopyKey = () => copyText(customApiKey.value);
const handleClearKey = () => {
  customApiKey.value = '';
  localStorage.removeItem('custom_api_key');
  showToast('已清除');
};

const refreshing = ref(false);
const settingsDialogVisible = ref(false);
const addDialogVisible = ref(false);

// 删除相关
const deleteDialogVisible = ref(false);
const deletingModel = ref<Model | null>(null);

const addForm = reactive({ url: '', api_key: '' });
const newItem = reactive({
  name: '',
  model_name: '',
  max_content_length: 4096,
  max_token: 2048
});

const openAddDialog = () => {
  addForm.url = '';
  addForm.api_key = '';
  newItem.name = '';
  newItem.model_name = '';
  newItem.max_content_length = 4096;
  newItem.max_token = 2048;
  addDialogVisible.value = true;
};

const handleAddSubmit = async () => {
  if (!addForm.url.trim()) { showToast('请输入 URL'); return; }
  if (!addForm.api_key.trim()) { showToast('请输入 API Key'); return; }
  if (!newItem.name.trim()) { showToast('请输入显示名称'); return; }
  if (!newItem.model_name.trim()) { showToast('请输入模型名称'); return; }

  const { batchCreateModels } = await import('@/api/modelService');
  try {
    const res = await batchCreateModels({
      url: addForm.url.trim(),
      api_key: addForm.api_key.trim(),
      api_format: 1,
      items: [{
        name: newItem.name.trim(),
        model_name: newItem.model_name.trim(),
        max_content_length: newItem.max_content_length || 4096,
        max_token: newItem.max_token || 2048,
        capabilities: ['completion']
      }]
    });
    if (res.success) {
      showToast('添加成功');
      addDialogVisible.value = false;
      fetchModels();
    } else {
      showToast(res.message || '添加失败');
    }
  } catch (e) {
    showToast('添加失败');
  }
};

const handleDelete = (model: Model) => {
  deletingModel.value = model;
  deleteDialogVisible.value = true;
};

const onDeleteConfirm = async (action: string) => {
  if (action === 'confirm' && deletingModel.value) {
    try {
      await doDelete(deletingModel.value);
      deleteDialogVisible.value = false;
      deletingModel.value = null;
    } catch (e) {
      // 错误已在 composable 中处理
    }
  }
  return true;
};

// 排序功能
const handleMoveUp = async (index: number) => {
  if (index <= 0) {
    showToast('已是第一个');
    return;
  }
  await handleReorder(index, index - 1);
};

const handleMoveDown = async (index: number) => {
  if (index >= modelList.value.length - 1) {
    showToast('已是最后一个');
    return;
  }
  await handleReorder(index, index + 1);
};

const onRefresh = async () => {
  await fetchModels();
  refreshing.value = false;
};

const handleLogout = () => {
  ['auth_token', 'auth_username', 'auth_expire_at', 'auth_is_admin', 'auth_role', 'auth_userId']
    .forEach((k: string) => localStorage.removeItem(k));
  router.push('/m/login');
};

let statsRefreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  fetchModels();
  loadLockDuration();
  statsRefreshTimer = window.setInterval(() => {
    loadStats();
    checkAndRefreshLockStatus();
  }, 20000);
});

onUnmounted(() => {
  if (statsRefreshTimer) clearInterval(statsRefreshTimer);
});
</script>

<style scoped lang="less">
.home-page {
  min-height: 100vh;
  background: #f7f8fa;
  padding-top: 50px;
}

.custom-navbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 50px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid #ebedf0;
  z-index: 100;
}

.navbar-title {
  font-size: 16px;
  font-weight: 600;
  color: #323233;
  white-space: nowrap;
}

.navbar-actions {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: nowrap;

  .van-button {
    padding: 0 10px;
    height: 28px;
    font-size: 12px;

    &::after {
      border-radius: 4px;
    }
  }
}

.content {
  padding-bottom: 16px;
}

.model-section {
  background: #fff;
  margin-bottom: 12px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #ebedf0;

  .section-title {
    font-size: 14px;
    font-weight: 600;
  }

  .model-count {
    font-size: 12px;
    color: #969799;
  }
}

.model-list {
  padding-bottom: 8px;
}

.no-stat-hint {
  text-align: center;
  padding: 20px;
  color: #969799;
  font-size: 14px;
}

.popup-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
}

/* API 弹窗样式 */
.api-content {
  flex: 1;
  overflow-y: auto;
  padding: 12px 0;
}

.api-base-url {
  padding: 8px 16px 12px;
  font-size: 12px;
  color: #666;
  line-height: 1.6;
}
.base-url-label {
  display: block;
  margin-bottom: 2px;
}
.base-url-value {
  background: #f0f0f0;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: 12px;
  word-break: break-all;
}
.base-url-hint {
  color: #999;
  font-size: 11px;
  margin-top: 4px;
}

.endpoints-section {
  padding: 0 16px;
}
.endpoints-title {
  font-size: 13px;
  font-weight: 600;
  color: #333;
  margin-bottom: 8px;
  padding-left: 4px;
}
.endpoint-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 8px;
  background: #fff;
  border-radius: 6px;
  margin-bottom: 6px;
  cursor: pointer;
  transition: background 0.2s;
}
.endpoint-item:active {
  background: #f5f5f5;
}
.endpoint-desc {
  font-size: 12px;
  color: #333;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
