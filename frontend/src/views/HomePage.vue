<template>
  <div class="home-container">
    <!-- ========== 顶部导航栏 ========== -->
    <el-header class="app-header">
      <div class="header-left">
        <h1 class="app-title">AI 模型管理平台</h1>
        <el-menu
          :default-active="'home'"
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
              <span class="model-count">已选择 {{ checkedModelIds.length }} 个模型</span>
            </div>
            <div class="right">
              <el-button
                v-if="checkedModelIds.length > 0"
                type="danger"
                size="small"
                class="header-btn"
                @click="handleBatchDelete">
                <el-icon><Delete /></el-icon>
                批量删除
              </el-button>
              <el-button type="primary" size="small" class="header-btn" @click="openAddDialog">
                <el-icon><Plus /></el-icon>
                添加模型
              </el-button>
              <el-button size="small" class="header-btn" @click="handleExport">
                <el-icon><Download /></el-icon>
                导出
              </el-button>
              <el-button size="small" class="header-btn" @click="handleImportClick">
                <el-icon><Upload /></el-icon>
                导入
              </el-button>
              <input ref="importFileRef" type="file" accept=".json" style="display:none" @change="handleImportFile" />
              <el-button size="small" class="header-btn" @click="openApiDialog">
                <el-icon><DocumentChecked /></el-icon>
                查看接口
              </el-button>
              <el-button size="small" class="header-btn" @click="mcpRecordDialogRef?.openDialog()">
                <el-icon><Memo /></el-icon>
                MCP记录
              </el-button>
              <el-button size="small" class="header-btn" @click="openSettingsDialog">
                <el-icon><Setting /></el-icon>
                设置
              </el-button>
              <el-button size="small" class="header-btn" @click="errorLogVisible = true">
                <el-icon><Notebook /></el-icon>
                错误日志
              </el-button>
            </div>
          </div>
        </template>

        <!-- 模型列表（可拖拽排序） -->
        <div class="model-list-wrapper">
          <!-- 滚动容器：表头 sticky + 内容 -->
          <div class="model-list-scroll">
            <!-- 表头 -->
            <div class="model-table-header">
              <div class="header-cell header-drag"></div>
              <div class="header-cell header-checkbox">
                <el-checkbox
                  v-model="isAllChecked"
                  :indeterminate="isIndeterminate"
                  @change="handleToggleAll" />
              </div>
              <div class="header-cell header-name">模型名称</div>
              <div class="header-cell header-model-name">模型ID</div>
              <div class="header-cell header-url">URL</div>
              <div class="header-cell header-capabilities">模态能力</div>
              <div class="header-cell header-context-length">最大上下文长度</div>
              <div class="header-cell header-consume">今日消耗</div>
              <div class="header-cell header-call-count">调用次数</div>
              <div class="header-cell header-status">状态</div>
              <div class="header-cell header-actions">操作</div>
            </div>

            <!-- 数据行 -->
            <draggable
              v-model="modelList"
              item-key="id"
              handle=".row-drag-handle"
              class="model-list-draggable"
              :animation="150"
              ghost-class="sortable-ghost"
              chosen-class="sortable-chosen"
              drag-class="sortable-drag"
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

                  @toggle-disable="handleToggleDisable"
                  @submit-edit="handleEditSubmit" />
              </template>
            </draggable>
          </div>
        </div>

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
              title="全部模型"
              :data="allStats" />
          </div>
          <div class="stat-chart" v-if="selectedModelId && selectedModelName">
            <div class="stat-chart-title">{{ selectedModelName }}</div>
            <TokenLineChart
              :title="selectedModelName"
              :data="selectedModelStats" />
          </div>
        </div>
      </el-card>
    </el-main>

    <!-- ========== 添加模型弹窗 ========== -->
    <AddModelDialog ref="addDialogRef" @submit="handleAddSubmit" />

    <!-- ========== 查看接口弹窗 ========== -->
    <el-dialog v-model="apiDialogVisible" title="代理接口地址" width="800px" class="api-dialog">
      <!-- API Key 配置 -->
      <el-form label-width="100px" class="api-key-form" style="margin-bottom: 0px;">
        <el-form-item label="API Key" style="margin-bottom: 0px;">
          <div class="api-key-row">
            <el-input
              v-model="customApiKey"
              placeholder="输入自定义 API Key（可选，留空则使用模型的 API Key）"
              show-password
              clearable
              style="flex: 1" />
            <el-button @click="generateApiKey">生成</el-button>
            <el-button v-if="customApiKey" @click="copyText(customApiKey)">复制</el-button>
            <el-button @click="clearApiKey" style="margin-left:0">清除</el-button>
          </div>
        </el-form-item>
        <el-form-item label="说明" style="align-items: baseline;">
          <div class="api-key-hint">
            <div>调用地址：<code class="address-text" @click="copyText(currentOrigin + '/admin/v1')">{{ currentOrigin }}/admin/v1</code><el-icon class="copy-icon-small" @click="copyText(currentOrigin + '/admin/v1')"><CopyDocument /></el-icon></div>
            <div>如果生成了Key，调用接口时需要填写 apiKey，如果为空则不需要验证</div>
          </div>
        </el-form-item>
      </el-form>

      <el-divider style="margin: 15px 0;" />

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
        <el-table-column label="说明" width="340" header-align="center" align="left">
          <template #default="{ row }">
            <span class="endpoint-desc">{{ row.desc }}</span>
          </template>
        </el-table-column>
      </el-table>
      <div style="height: 20px;"></div>
    </el-dialog>

    <!-- ========== 设置弹窗 ========== -->
    <SettingsDialog ref="settingsDialogRef" />

    <!-- ========== 编辑模型弹窗 ========== -->
    <EditModelDialog ref="editDialogRef" @submit="handleEditSubmit" />

    <!-- ========== 导入冲突对话框 ========== -->
    <ImportConflictDialog
      ref="importConflictRef"
      @resolve="handleImportConflictResolve" />

    <!-- ========== 错误日志抽屉 ========== -->
    <ErrorLogDrawer v-model:visible="errorLogVisible" />

    <!-- ========== MCP记录弹窗 ========== -->
    <McpRecordDialog ref="mcpRecordDialogRef" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { DocumentChecked, Plus, Setting, Delete, Lock, SwitchButton, User, CopyDocument, Notebook, Download, Upload, Memo, Management, Tools, Document } from '@element-plus/icons-vue'
import draggable from 'vuedraggable'

// 组件
import ModelCard from '@/components/ModelCard/index.vue'
import TokenLineChart from '@/components/TokenLineChart/index.vue'
import SettingsDialog from '@/components/SettingsDialog/index.vue'
import AddModelDialog from '@/components/AddModelDialog/index.vue'
import EditModelDialog from '@/components/EditModelDialog/index.vue'
import ErrorLogDrawer from '@/components/ErrorLogDrawer/index.vue'
import ImportConflictDialog from '@/components/ImportConflictDialog/index.vue'
import McpRecordDialog from '@/components/McpRecordDialog/index.vue'
import { useErrorLog } from '@/composables/useErrorLog'
import { createModel, updateModel, type Model, type ModelForm } from '@/api/modelService'

// 逻辑
import {
  statsLoading,
  modelList,
  checkedModelIds,
  selectedModelId,
  selectedModelName,
  allStats,
  selectedModelStats,
  modelStatMap,
  openAddDialog,
  handleAddSubmit,
  handleEditSubmit,
  handleCheckChange,
  handleToggleAll,
  handleBatchDelete,
  isAllChecked,
  handleReorder,
  selectModel,
  apiDialogVisible,
  userProxyBaseUrl,
  customApiKey,
  proxyEndpoints,
  openApiDialog,
  generateApiKey,
  clearApiKey,
  copyEndpointWithKey,
  onMountedCallback,
  fetchModels,
  loadStats,
  loadLockDuration,
  checkAndRefreshLockStatus,
  addDialogRef,
} from '@/App'

const router = useRouter()

// 当前域名（用于动态地址显示）
const currentOrigin = window.location.origin

// 用户信息
const username = localStorage.getItem('auth_username') || ''
const isAdmin = computed(() => localStorage.getItem('auth_is_admin') === '1')

// 编辑弹窗 ref
const settingsDialogRef = ref<InstanceType<typeof SettingsDialog>>()
const openSettingsDialog = () => {
  settingsDialogRef.value?.openDialog()
}

const editDialogRef = ref<InstanceType<typeof EditModelDialog>>()
const openEditDialog = (model: any) => {
  editDialogRef.value?.openDialog(model)
}

// 错误日志
const errorLogVisible = ref(false)

// MCP记录弹窗 ref
const mcpRecordDialogRef = ref<InstanceType<typeof McpRecordDialog>>()

const { connect: connectErrorLog, disconnect: disconnectErrorLog } = useErrorLog()

const isIndeterminate = computed(() => {
  const len = checkedModelIds.value.length
  return len > 0 && len < modelList.value.length
})

// 导航选择
const handleNavSelect = (index: string) => {
  if (index === 'home') {
    router.push('/');
  } else if (index === 'memory-user') {
    router.push('/memory/user');
  } else if (index === 'memory-skills') {
    router.push('/memory/skills');
  }
};

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

// ========== 导入/导出功能 ==========
const importFileRef = ref<HTMLInputElement>()
const importConflictRef = ref<InstanceType<typeof ImportConflictDialog>>()
const importQueue = ref<Model[]>([])
const importIndex = ref(0)
const importAllAction = ref<'overwrite' | 'skip' | null>(null)

// 导出：将模型配置导出为 JSON 文件
const handleExport = () => {
  const exportData = modelList.value.map(m => ({
    name: m.name,
    model_name: m.model_name,
    url: m.url,
    api_key: m.api_key,
    max_content_length: m.max_content_length,
    max_token: m.max_token,
    sort_index: m.sort_index,
    api_format: m.api_format,
    model_label_id: m.model_label_id,
    capabilities: m.capabilities,
  }))
  const json = JSON.stringify(exportData, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `models-export-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
  ElMessage.success(`已导出 ${exportData.length} 个模型配置`)
}

// 导入：触发文件选择
const handleImportClick = () => {
  importFileRef.value?.click()
}

// 处理导入文件
const handleImportFile = (e: Event) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  input.value = ''

  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result as string)
      if (!Array.isArray(data)) {
        ElMessage.error('导入文件格式错误：应为 JSON 数组')
        return
      }
      importQueue.value = data as Model[]
      importIndex.value = 0
      importAllAction.value = null
      processNextImport()
    } catch {
      ElMessage.error('导入文件解析失败')
    }
  }
  reader.readAsText(file)
}

// 逐条处理导入
const processNextImport = async () => {
  if (importIndex.value >= importQueue.value.length) {
    ElMessage.success(`导入完成：共 ${importQueue.value.length} 个模型`)
    fetchModels()
    return
  }

  const item = importQueue.value[importIndex.value]

  // 检查是否有重复（按 name 匹配）
  const existing = modelList.value.find(m => m.name === item.name)

  if (existing && importAllAction.value === 'overwrite') {
    await doImportOverwrite(item, existing.id)
    importIndex.value++
    processNextImport()
    return
  }

  if (existing && importAllAction.value === 'skip') {
    importIndex.value++
    processNextImport()
    return
  }

  if (existing) {
    // 弹出冲突对话框
    importConflictRef.value?.open({
      modelName: item.name,
      current: importIndex.value + 1,
      total: importQueue.value.length,
    })
    return
  }

  // 无重复，直接导入
  await doImportCreate(item)
  importIndex.value++
  processNextImport()
}

// 创建新模型
const doImportCreate = async (item: Model) => {
  try {
    const data: ModelForm = {
      name: item.name,
      model_name: item.model_name,
      url: item.url,
      api_key: item.api_key,
      max_content_length: item.max_content_length,
      max_token: item.max_token,
      sort_index: item.sort_index,
      api_format: item.api_format,
      model_label_id: item.model_label_id,
      capabilities: item.capabilities,
    }
    await createModel(data)
  } catch {
    // ignore
  }
}

// 覆盖已有模型
const doImportOverwrite = async (item: Model, existingId: number) => {
  try {
    const data: ModelForm = {
      name: item.name,
      model_name: item.model_name,
      url: item.url,
      api_key: item.api_key,
      max_content_length: item.max_content_length,
      max_token: item.max_token,
      sort_index: item.sort_index,
      api_format: item.api_format,
      model_label_id: item.model_label_id,
      capabilities: item.capabilities,
    }
    await updateModel(existingId, data)
  } catch {
    // ignore
  }
}

// 处理冲突对话框的结果
const handleImportConflictResolve = (action: 'overwrite' | 'skip' | 'cancel' | 'all-overwrite' | 'all-skip') => {
  if (action === 'cancel') {
    ElMessage.info('导入已取消')
    return
  }

  if (action === 'all-overwrite') {
    importAllAction.value = 'overwrite'
    processNextImport()
    return
  }

  if (action === 'all-skip') {
    importAllAction.value = 'skip'
    processNextImport()
    return
  }

  const item = importQueue.value[importIndex.value]
  const existing = modelList.value.find(m => m.name === item.name)

  if (action === 'overwrite' && existing) {
    doImportOverwrite(item, existing.id)
  }

  importIndex.value++
  processNextImport()
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
  // 连接错误日志 WebSocket
  connectErrorLog()
})
onUnmounted(() => {
  if (statsRefreshTimer !== null) {
    clearInterval(statsRefreshTimer)
    statsRefreshTimer = null
  }
  disconnectErrorLog()
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
  padding: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
}

.model-list-draggable {
  display: flex;
  flex-direction: column;
  gap: 0;
}

// ========== 模型列表容器 ==========
.model-list-wrapper {
  display: flex;
  flex-direction: column;
  height: 630px;
  padding: 0 20px 20px;
  background: #fff;
}

// ========== 滚动容器 ==========
.model-list-scroll {
  flex: 1;
  overflow: auto;
  border: 1px solid #ebeef5;
  border-radius: 4px;
}

.model-table-header,
.model-list-draggable {
  width: max-content;
  min-width: 100%;
}

// ========== 表头 ==========
.model-table-header {
  display: flex;
  align-items: center;
  height: 40px;
  background: #fafafa;
  border-bottom: 2px solid #ebeef5;
  font-size: 12px;
  font-weight: 600;
  color: #606266;
  user-select: none;
  position: sticky;
  top: 0;
  z-index: 10;

  .header-cell {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 0 5px;
  }

  .header-drag {
    width: 36px;
    flex-shrink: 0;
  }

  .header-checkbox {
    width: 36px;
    flex-shrink: 0;
    justify-content: center;
  }

  .header-name {
    width: 290px;
    flex-shrink: 0;
  }

  .header-model-name {
    width: 150px;
    flex-shrink: 0;
  }

  .header-url {
    width: 300px;
    flex-shrink: 0;
  }

  .header-capabilities {
    width: 250px;
    flex-shrink: 0;
  }

  .header-context-length {
    width: 120px;
    flex-shrink: 0;
  }

  .header-consume,
  .header-call-count {
    width: 110px;
    flex-shrink: 0;
  }

  .header-status {
    width: 120px;
    flex-shrink: 0;
    justify-content: center;
  }

  .header-actions {
    width: 145px;
    flex-shrink: 0;
    justify-content: center;
  }
}

.stats-charts {
  display: flex;
  gap: 24px;
  height: 345px;

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
    align-items: center;

    .header-btn {
      --el-button-size: 32px;
      height: 32px;
      padding: 8px 15px;
      margin-left: 0 !important;
    }
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