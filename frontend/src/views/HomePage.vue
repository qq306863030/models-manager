<template>
  <div class="home-container">
    <!-- ========== 顶部导航栏 ========== -->
    <el-header class="app-header">
      <div class="header-left">
        <h1 class="app-title">AI 模型管理平台</h1>
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

    <!-- ========== 主内容区 ========== -->
    <el-main class="app-main">
      <el-card class="model-list-card">
        <template #header>
          <div class="card-header">
            <div class="left">
              <el-checkbox
                v-model="isAllChecked"
                :indeterminate="isIndeterminate"
                @change="handleToggleAll">
                全选
              </el-checkbox>
              <span class="model-count">已选择 {{ checkedModelIds.length }} 个模型</span>
            </div>
            <div class="right">
              <el-button
                v-if="checkedModelIds.length > 0"
                type="danger"
                size="small"
                @click="handleBatchDelete">
                <el-icon><Delete /></el-icon>
                批量删除
              </el-button>
              <el-button type="primary" size="small" @click="openAddDialog">
                <el-icon><Plus /></el-icon>
                添加模型
              </el-button>
              <el-button size="small" @click="openApiDialog">
                <el-icon><DocumentChecked /></el-icon>
                查看接口
              </el-button>
              <el-button size="small" @click="openSettingsDialog">
                <el-icon><Setting /></el-icon>
                设置
              </el-button>
            </div>
          </div>
        </template>

        <!-- 模型列表（可拖拽排序） -->
        <draggable
          v-model="modelList"
          item-key="id"
          handle=".card-actions"
          class="model-list-draggable"
          :style="{ maxHeight: '630px', overflowY: 'auto' }"
          @end="onDragEnd">
          <template #item="{ element }">
            <ModelCard
              :model="element"
              :is-selected="selectedModelId === element.id"
              :checked="checkedModelIds.includes(element.id)"
              :stat-summary="modelStatMap.get(element.id)"
              @select="selectModel"
              @edit="openEditDialog(element)"
              @check-change="(id, checked) => handleCheckChange(id, checked)"
              @copy="handleCopy"
              @delete="handleDelete"
              @toggle-lock="handleToggleLock"
              @toggle-disable="handleToggleDisable" />
          </template>
        </draggable>

        <el-empty
          v-if="modelList.length === 0"
          description="暂无模型，请点击上方「添加模型」按钮添加" />
      </el-card>

      <!-- 统计图表 -->
      <el-card class="stats-card">
        <template #header>
          <div class="card-header">
            <span>使用统计</span>
          </div>
        </template>
        <div class="stats-charts">
          <div class="stat-chart">
            <div class="stat-chart-title">全部模型</div>
            <TokenLineChart
              :data="allStats"
              :loading="statsLoading" />
          </div>
          <div class="stat-chart" v-if="selectedModelId && selectedModelName">
            <div class="stat-chart-title">{{ selectedModelName }}</div>
            <TokenLineChart
              :data="selectedModelStats"
              :loading="statsLoading" />
          </div>
        </div>
      </el-card>
    </el-main>

    <!-- ========== 添加模型弹窗 ========== -->
    <AddModelDialog ref="addDialogRef" @submit="handleAddSubmit" />

    <!-- ========== 查看接口弹窗 ========== -->
    <el-dialog v-model="apiDialogVisible" title="代理接口地址" width="800px" class="api-dialog">
      <!-- API Key 配置 -->
      <el-form label-width="100px" class="api-key-form">
        <el-form-item label="API Key">
          <div class="api-key-row">
            <el-input
              v-model="customApiKey"
              placeholder="输入自定义 API Key（可选，留空则使用模型的 API Key）"
              show-password
              clearable
              style="flex: 1" />
            <el-button @click="generateApiKey">生成</el-button>
            <el-button v-if="customApiKey" @click="copyText(customApiKey)">复制</el-button>
            <el-button @click="clearApiKey">清除</el-button>
          </div>
        </el-form-item>
        <el-form-item label="说明">
          <div class="api-key-hint">
            <div>调用地址：<code class="address-text" @click="copyText(currentOrigin + '/admin/v1')">{{ currentOrigin }}/admin/v1</code><el-icon class="copy-icon-small" @click="copyText(currentOrigin + '/admin/v1')"><CopyDocument /></el-icon></div>
            <div>API Key：如果生成了Key，调用接口时需要填写 apiKey，如果为空则不需要验证</div>
          </div>
        </el-form-item>
      </el-form>

      <el-divider />

      <!-- 接口列表 -->
      <el-table :data="proxyEndpoints" stripe size="small" class="api-table">
        <el-table-column label="方法" width="70" align="center">
          <template #default="{ row }">
            <el-tag :type="row.method === 'GET' ? 'success' : 'primary'" size="small" round>
              {{ row.method }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="完整地址" min-width="0" align="center">
          <template #default="{ row }">
            <div class="url-cell">
              <el-icon class="copy-icon" @click="copyText(copyEndpointWithKey(row.path))">
                <CopyDocument />
              </el-icon>
              <code class="endpoint-url" @click="copyText(copyEndpointWithKey(row.path))">{{ userProxyBaseUrl }}{{ row.path }}</code>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="说明" width="180" header-align="center" align="left">
          <template #default="{ row }">
            <span class="endpoint-desc">{{ row.desc }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div style="height: 20px;"></div>
    </el-dialog>

    <!-- ========== 设置弹窗 ========== -->
    <SettingsDialog ref="settingsDialogRef" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { DocumentChecked, Plus, Setting, Delete, Lock, SwitchButton, User, CopyDocument } from '@element-plus/icons-vue'
import draggable from 'vuedraggable'

// 组件
import ModelCard from '@/components/ModelCard/index.vue'
import TokenLineChart from '@/components/TokenLineChart/index.vue'
import SettingsDialog from '@/components/SettingsDialog/index.vue'
import AddModelDialog from '@/components/AddModelDialog/index.vue'

// 逻辑
import {
  modelLoading,
  statsLoading,
  modelList,
  checkedModelIds,
  selectedModelId,
  selectedModelName,
  dateRange,
  allStats,
  selectedModelStats,
  modelStatMap,
  modelLabelOptions,
  addDialogRef,
  openAddDialog,
  handleAddSubmit,
  handleCheckChange,
  handleToggleAll,
  handleBatchDelete,
  isAllChecked,
  handleReorder,
  selectModel,
  apiDialogVisible,
  proxyBaseUrl,
  userProxyBaseUrl,
  customApiKey,
  proxyEndpoints,
  openApiDialog,
  generateApiKey,
  clearApiKey,
  copyEndpointWithKey,
  onMountedCallback,
  loadStats,
  loadLockDuration,
  checkAndRefreshLockStatus,
} from '@/App'

const router = useRouter()

// 当前域名（用于动态地址显示）
const currentOrigin = window.location.origin

// 用户信息
const username = localStorage.getItem('auth_username') || ''
const isAdmin = computed(() => localStorage.getItem('auth_is_admin') === '1')

// 编辑弹窗 ref（暂未使用，后续可扩展）
const settingsDialogRef = ref<InstanceType<typeof SettingsDialog>>()
const openSettingsDialog = () => {
  settingsDialogRef.value?.openDialog()
}

const isIndeterminate = computed(() => {
  const len = checkedModelIds.value.length
  return len > 0 && len < modelList.value.length
})

const onModelFilterChange = () => {
  loadStats()
}

// 拖拽排序
const onDragEnd = () => {
  handleReorder(modelList.value)
}

// 复制文本（支持 http 协议）
const fallbackCopy = (text: string) => {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  try {
    document.execCommand('copy')
    ElMessage.success('已复制到剪贴板')
  } catch {
    ElMessage.error('复制失败')
  }
  document.body.removeChild(textarea)
}

const copyText = (text: string) => {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => {
      ElMessage.success('已复制到剪贴板')
    }).catch(() => {
      fallbackCopy(text)
    })
  } else {
    fallbackCopy(text)
  }
}

// 打开编辑弹窗
const openEditDialog = (model: any) => {
  // 触发编辑事件
  window.dispatchEvent(new CustomEvent('open-edit-model', { detail: model }))
}

// 处理函数（从 App.ts 导入）
import {
  handleCopy,
  handleDelete,
  handleToggleLock,
  handleToggleDisable,
} from '@/App'

// 注销
const handleLogout = () => {
  localStorage.removeItem('auth_token')
  localStorage.removeItem('auth_username')
  localStorage.removeItem('auth_expire_at')
  localStorage.removeItem('auth_is_admin')
  localStorage.removeItem('auth_role')
  localStorage.removeItem('auth_userId')
  router.push('/login')
}

// 初始化
onMountedCallback()

// 定时刷新统计数据和锁定状态（每 20 秒）
let statsRefreshTimer: number | null = null
onMounted(() => {
  loadLockDuration()
  statsRefreshTimer = window.setInterval(() => {
    loadStats()
    checkAndRefreshLockStatus()
  }, 20000)
})
onUnmounted(() => {
  if (statsRefreshTimer !== null) {
    clearInterval(statsRefreshTimer)
    statsRefreshTimer = null
  }
})
</script>

<style scoped lang="less">
.home-container {
  min-height: 100vh;
  background: #f5f7fa;
}

.app-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: #fff;
  border-bottom: 1px solid #e4e7ed;
  padding: 0 24px;

  .header-left {
    .app-title {
      font-size: 18px;
      font-weight: 600;
      color: #303133;
      margin: 0;
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

.app-main {
  padding: 20px 24px;

  .model-list-card,
.stats-card {
  margin-bottom: 20px;
}

.model-list-card :deep(.el-card__body) {
  padding: 20px;
}
}

.model-list-draggable {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.stats-charts {
  display: flex;
  gap: 24px;
  height: 340px;

  .stat-chart {
    flex: 1;
    min-width: 0;

    .stat-chart-title {
      font-size: 14px;
      font-weight: 600;
      color: #606266;
      margin-bottom: 12px;
      padding-left: 4px;
    }
  }
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;

  .left {
    display: flex;
    align-items: center;
    gap: 16px;

    .model-count {
      font-size: 14px;
      color: #909399;
    }
  }

  .right {
    display: flex;
    gap: 8px;
  }
}

// API Key 表单
.api-key-form {
  margin-bottom: 16px;
}

.api-key-row {
  display: flex;
  gap: 8px;
  align-items: center;
  width: 100%;
}

.api-key-hint {
  font-size: 13px;
  color: #909399;

  code {
    background: #f0f7ff;
    padding: 2px 6px;
    border-radius: 4px;
    font-family: 'Consolas', 'Monaco', monospace;
    font-size: 12px;
    color: #409eff;
  }
}

.api-table {
  .url-cell {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .copy-icon {
    cursor: pointer;
    color: #409eff;

    &:hover {
      color: #66b1ff;
    }
  }

  .endpoint-url {
    font-size: 12px;
    color: #606266;
    cursor: pointer;

    &:hover {
      color: #409eff;
    }
  }

  .endpoint-desc {
    font-size: 12px;
    color: #909399;
  }
}

.api-key-hint {
  display: flex;
  flex-direction: column;
  align-items: baseline;
  font-size: 13px;
  color: #606266;
  line-height: 1.8;

  .address-text {
    color: #409eff;
    cursor: pointer;
    padding: 2px 6px;
    background: #ecf5ff;
    border-radius: 4px;
    font-size: 12px;

    &:hover {
      color: #66b1ff;
      background: #d9ecff;
    }
  }

  .copy-icon-small {
    margin-left: 6px;
    cursor: pointer;
    color: #909399;
    font-size: 14px;
    vertical-align: middle;

    &:hover {
      color: #409eff;
    }
  }
}

.filters {
  display: flex;
  align-items: center;
}

.api-dialog {
  :deep(.el-dialog__body) {
    padding-bottom: 30px !important;
  }
}
</style>