<template>
  <el-drawer
    v-model="visible"
    title="请求日志"
    direction="rtl"
    size="500px"
    :before-close="handleClose">
    <template #header>
      <div class="drawer-header">
        <span class="drawer-title">请求日志</span>
        <el-tag type="info" size="small" round effect="plain">
          {{ requestLogs.length }} / 100
        </el-tag>
      </div>
    </template>

    <div class="request-log-container" ref="listRef" v-loading="loading">
      <el-empty v-if="requestLogs.length === 0" description="暂无请求记录" :image-size="80" />

      <div
        v-for="item in reversedLogs"
        :key="item.id"
        class="request-log-item"
        @click="openDetail(item)">
        <div class="item-header">
          <el-tag :type="getStatusType(item.status, item.statusCode)" size="small" round effect="dark">
            {{ getStatusText(item.status, item.statusCode) }}
          </el-tag>
          <span class="model-name" :title="item.model">{{ item.model || '-' }}</span>
          <span class="duration">{{ formatDuration(item) }}</span>
          <span class="time">{{ formatTime(item.timestamp) }}</span>
        </div>

        <div class="item-meta">
          <span class="endpoint-badge">{{ item.method }} {{ cleanEndpoint(item.endpoint) }}</span>
          <el-tag v-if="item.stream" size="small" type="info" effect="plain" class="mini-tag">流式</el-tag>
          <template v-if="item.toolNames && item.toolNames.length > 0">
            <el-tag
              v-if="item.tools && item.tools.length > 0"
              size="small"
              type="warning"
              effect="plain"
              class="mini-tag">
              {{ item.tools.length }} 直接工具
            </el-tag>
            <el-tag
              v-if="item.toolNames.length > (item.tools?.length || 0)"
              size="small"
              type="success"
              effect="plain"
              class="mini-tag">
              +{{ item.toolNames.length - (item.tools?.length || 0) }} 延迟MCP
            </el-tag>
          </template>
        </div>

        <div v-if="item.systemPrompt" class="item-prompt-preview">
          <span class="prompt-label">系统提示:</span>
          <span class="prompt-text">{{ truncate(item.systemPrompt, 60) }}</span>
        </div>

        <div v-if="item.error" class="item-error-preview">
          <el-icon><Warning /></el-icon>
          <span>{{ item.error }}</span>
        </div>

        <div class="item-hover-tip">
          <el-icon><ArrowRight /></el-icon>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="drawer-footer">
        <el-button size="small" @click="handleRefresh" :loading="loading">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
        <el-button size="small" @click="handleClear" :disabled="requestLogs.length === 0">
          <el-icon><Delete /></el-icon>
          清空
        </el-button>
      </div>
    </template>
  </el-drawer>

  <!-- 请求详情弹窗 -->
  <el-dialog
    v-model="detailVisible"
    :title="'请求详情 - ' + (activeItem?.model || '')"
    width="820px"
    top="6vh"
    append-to-body
    :close-on-click-modal="false"
    class="request-detail-dialog">
    <div v-if="activeItem" class="detail-dialog-body">
      <el-tabs v-model="activeTab">
        <!-- Tab 1: 概览与基础指标 -->
        <el-tab-pane label="基本概览" name="overview">
          <div class="overview-grid">
            <div class="overview-cell">
              <span class="label">请求 ID:</span>
              <span class="value code-font">{{ activeItem.id }}</span>
            </div>
            <div class="overview-cell">
              <span class="label">状态:</span>
              <el-tag :type="getStatusType(activeItem.status, activeItem.statusCode)" size="small">
                {{ getStatusText(activeItem.status, activeItem.statusCode) }}
              </el-tag>
            </div>
            <div class="overview-cell">
              <span class="label">请求模型:</span>
              <span class="value font-bold">{{ activeItem.model }}</span>
            </div>
            <div class="overview-cell" v-if="activeItem.actualModel">
              <span class="label">实际命中模型:</span>
              <span class="value font-bold text-primary">{{ activeItem.actualModel }}</span>
            </div>
            <div class="overview-cell">
              <span class="label">请求方法与路径:</span>
              <span class="value code-font">{{ activeItem.method }} {{ activeItem.endpoint }}</span>
            </div>
            <div class="overview-cell">
              <span class="label">响应耗时:</span>
              <span class="value font-bold">{{ formatDuration(activeItem) }}</span>
            </div>
            <div class="overview-cell">
              <span class="label">时间戳:</span>
              <span class="value">{{ activeItem.timestamp }}</span>
            </div>
            <div class="overview-cell">
              <span class="label">传输模式:</span>
              <span class="value">{{ activeItem.stream ? '流式响应 (SSE)' : '常规非流式' }}</span>
            </div>
            <div class="overview-cell" v-if="activeItem.username">
              <span class="label">所属用户:</span>
              <span class="value">{{ activeItem.username }}</span>
            </div>
            <div class="overview-cell" v-if="activeItem.clientIp">
              <span class="label">客户端 IP:</span>
              <span class="value code-font">{{ activeItem.clientIp }}</span>
            </div>
          </div>

          <div v-if="activeItem.error" class="error-banner">
            <div class="error-banner-title">
              <el-icon><Warning /></el-icon>
              <span>错误详情</span>
            </div>
            <div class="error-banner-content">{{ activeItem.error }}</div>
          </div>
        </el-tab-pane>

        <!-- Tab 2: 系统提示词 (System Prompt) -->
        <el-tab-pane label="系统提示词" name="system">
          <div class="tab-section-header">
            <span class="section-title">
              系统提示词
              <el-tag size="small" type="info">{{ activeItem.systemPrompt.length }} 字符</el-tag>
            </span>
            <el-button
              v-if="activeItem.systemPrompt"
              size="small"
              type="primary"
              link
              @click="copyText(activeItem.systemPrompt)">
              <el-icon><CopyDocument /></el-icon>
              复制提示词
            </el-button>
          </div>

          <div v-if="activeItem.systemPrompt" class="code-block-container">
            <pre class="code-block">{{ activeItem.systemPrompt }}</pre>
          </div>
          <el-empty v-else description="本次请求未包含系统提示词" :image-size="60" />
        </el-tab-pane>

        <!-- Tab 3: 调用的工具 (Tools) -->
        <el-tab-pane label="携带工具" name="tools">
          <div class="tab-section-header">
            <span class="section-title">
              携带工具列表
              <el-tag size="small" type="primary">共 {{ totalToolCount }} 个工具</el-tag>
              <el-tag v-if="directTools.length > 0" size="small" type="warning">{{ directTools.length }} 个直接定义</el-tag>
              <el-tag v-if="deferredToolNames.length > 0" size="small" type="success">{{ deferredToolNames.length }} 个延迟加载 MCP</el-tag>
            </span>
          </div>

          <!-- 1. 直接定义工具 (Direct Tools) -->
          <div v-if="directTools.length > 0" class="tool-sub-section">
            <div class="sub-section-title">
              <span class="main-title">直接声明工具 (Direct Tools, {{ directTools.length }})</span>
              <span class="sub-desc">已将完整的 JSON Schema 声明注入到 tools 列表中</span>
            </div>
            <div class="tools-container">
              <div
                v-for="(t, idx) in directTools"
                :key="idx"
                class="tool-card">
                <div class="tool-card-header">
                  <span class="tool-name">{{ getToolName(t) }}</span>
                  <el-button size="small" link type="primary" @click="copyText(JSON.stringify(t, null, 2))">
                    <el-icon><CopyDocument /></el-icon>
                    复制 Schema
                  </el-button>
                </div>
                <div v-if="getToolDesc(t)" class="tool-desc">{{ getToolDesc(t) }}</div>
                <div class="tool-schema">
                  <pre class="code-block mini">{{ JSON.stringify(getToolParams(t), null, 2) }}</pre>
                </div>
              </div>
            </div>
          </div>

          <!-- 2. 延迟加载 MCP 工具 (Deferred Tools) -->
          <div v-if="deferredToolNames.length > 0" class="tool-sub-section deferred-section">
            <div class="sub-section-title flex-between">
              <div>
                <span class="main-title">延迟加载 MCP 工具 (Deferred Tools, {{ deferredToolNames.length }})</span>
                <span class="sub-desc">客户端为节约上下文 Token，声明在 ToolSearch/上下文中的按需检索工具</span>
              </div>
              <div class="search-actions">
                <el-input
                  v-model="deferredSearchKeyword"
                  size="small"
                  placeholder="搜索 MCP 工具名..."
                  clearable
                  style="width: 170px;"
                />
                <el-button size="small" type="primary" link @click="copyAllDeferredTools">
                  <el-icon><CopyDocument /></el-icon>
                  复制全部名称
                </el-button>
              </div>
            </div>

            <div class="deferred-tools-grid">
              <div
                v-for="name in filteredDeferredToolNames"
                :key="name"
                class="deferred-tool-item"
                :class="{ 'is-platform-mcp': isPlatformMcpTool(name) }"
                :title="'点击复制工具名: ' + name"
                @click="copyText(name)">
                <span class="deferred-name">{{ name }}</span>
                <el-tag v-if="isPlatformMcpTool(name)" size="small" type="warning" effect="dark" class="mcp-badge">平台专属</el-tag>
                <el-icon class="copy-icon"><CopyDocument /></el-icon>
              </div>
            </div>
          </div>

          <el-empty v-if="totalToolCount === 0" description="本次请求未携带工具 (Tools)" :image-size="60" />
        </el-tab-pane>

        <!-- Tab 4: 完整消息历史 (Messages) -->
        <el-tab-pane label="消息上下文" name="messages">
          <div class="tab-section-header">
            <span class="section-title">
              对话消息历史
              <el-tag size="small" type="info">{{ (activeItem.messages && activeItem.messages.length) || 0 }} 条</el-tag>
            </span>
          </div>

          <div v-if="activeItem.messages && activeItem.messages.length > 0" class="messages-container">
            <div
              v-for="(msg, mIdx) in activeItem.messages"
              :key="mIdx"
              :class="['message-bubble', 'role-' + msg.role]">
              <div class="bubble-header">
                <span class="bubble-role">{{ msg.role?.toUpperCase() || 'UNKNOWN' }}</span>
                <el-button size="small" link @click="copyText(getMessageContent(msg))">
                  <el-icon><CopyDocument /></el-icon>
                </el-button>
              </div>
              <div class="bubble-content">
                <pre class="message-pre">{{ getMessageContent(msg) }}</pre>
              </div>
            </div>
          </div>
          <el-empty v-else description="无对话上下文消息" :image-size="60" />
        </el-tab-pane>

        <!-- Tab 5: 完整原始数据 (Raw) -->
        <el-tab-pane label="原始 JSON" name="raw">
          <div class="tab-section-header">
            <span class="section-title">完整记录数据</span>
            <el-button size="small" type="primary" link @click="copyText(JSON.stringify(activeItem, null, 2))">
              <el-icon><CopyDocument /></el-icon>
              复制 JSON
            </el-button>
          </div>
          <div class="code-block-container">
            <pre class="code-block">{{ JSON.stringify(activeItem, null, 2) }}</pre>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  Warning,
  Refresh,
  Delete,
  ArrowRight,
  CopyDocument,
} from '@element-plus/icons-vue';
import { useRequestLog } from '@/composables/useRequestLog';
import type { RequestLogItem } from '@/api/requestLogService';

const props = defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:visible', value: boolean): void;
}>();

const visible = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val),
});

const { requestLogs, loading, fetchLogs, clearLogs } = useRequestLog();
const listRef = ref<HTMLElement>();

// 倒序展示（最新在顶部）
const reversedLogs = computed(() => [...requestLogs.value].reverse());

// 详情弹窗状态
const detailVisible = ref(false);
const activeItem = ref<RequestLogItem | null>(null);
const activeTab = ref('overview');

// 打开抽屉时拉取最新日志
watch(
  () => props.visible,
  (val) => {
    if (val) {
      fetchLogs();
    }
  }
);

const handleClose = () => {
  emit('update:visible', false);
};

const handleRefresh = () => {
  fetchLogs();
};

const handleClear = async () => {
  await clearLogs();
  ElMessage.success('请求日志已清空');
};

const openDetail = (item: RequestLogItem) => {
  activeItem.value = item;
  activeTab.value = 'overview';
  detailVisible.value = true;
};

const formatTime = (timeStr?: string): string => {
  if (!timeStr) return '-';
  try {
    const parts = timeStr.split(' ');
    return parts[1] || timeStr;
  } catch {
    return timeStr;
  }
};

const formatDuration = (item: RequestLogItem): string => {
  if (item.status === 'pending') return '请求中...';
  if (!item.durationMs && item.durationMs !== 0) return '-';
  if (item.durationMs < 1000) return `${item.durationMs}ms`;
  return `${(item.durationMs / 1000).toFixed(2)}s`;
};

const getStatusType = (status: string, code?: number): 'success' | 'danger' | 'primary' | 'info' => {
  if (status === 'pending') return 'primary';
  if (status === 'success' || (code && code >= 200 && code < 400)) return 'success';
  return 'danger';
};

const getStatusText = (status: string, code?: number): string => {
  if (status === 'pending') return '请求中';
  if (code) return String(code);
  return status === 'success' ? '200' : '500';
};

const cleanEndpoint = (url?: string): string => {
  if (!url) return '';
  // 移除开头的用户名前缀展示更紧凑
  const parts = url.split('/v1/');
  if (parts.length > 1) {
    return `/v1/${parts[1]}`;
  }
  return url;
};

const truncate = (str: string, maxLen: number): string => {
  if (!str) return '';
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
};

const getToolName = (tool: any): string => {
  return tool?.function?.name || tool?.name || '未知工具';
};

const getToolDesc = (tool: any): string => {
  return tool?.function?.description || tool?.description || '';
};

const getToolParams = (tool: any): any => {
  return tool?.function?.parameters || tool?.input_schema || {};
};

// 工具分组计算属性
const directTools = computed(() => {
  return activeItem.value?.tools || [];
});

const directToolNames = computed(() => {
  return new Set(directTools.value.map((t: any) => getToolName(t)).filter(Boolean));
});

const deferredToolNames = computed(() => {
  if (!activeItem.value?.toolNames) return [];
  const directSet = directToolNames.value;
  return activeItem.value.toolNames.filter((name: string) => !directSet.has(name));
});

const totalToolCount = computed(() => {
  return directTools.value.length + deferredToolNames.value.length;
});

const deferredSearchKeyword = ref('');
const filteredDeferredToolNames = computed(() => {
  const kw = deferredSearchKeyword.value.trim().toLowerCase();
  if (!kw) return deferredToolNames.value;
  return deferredToolNames.value.filter((name: string) => name.toLowerCase().includes(kw));
});

const isPlatformMcpTool = (name: string): boolean => {
  return /ai_mm_|ai-models-manager/i.test(name);
};

const copyAllDeferredTools = () => {
  if (deferredToolNames.value.length === 0) return;
  copyText(deferredToolNames.value.join('\n'));
};

const getMessageContent = (msg: any): string => {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return JSON.stringify(msg.content, null, 2);
  }
  if (msg.tool_calls) {
    return `[Tool Calls]\n${JSON.stringify(msg.tool_calls, null, 2)}`;
  }
  return JSON.stringify(msg.content || '', null, 2);
};

import { copyToClipboard } from '../../utils/clipboard';

const copyText = async (text: string) => {
  if (!text) return;
  const success = await copyToClipboard(text);
  if (success) {
    ElMessage.success('已复制到剪贴板');
  } else {
    ElMessage.error('复制失败，请手动选择复制');
  }
};
</script>

<style scoped lang="less">
:deep(.el-drawer__body) {
  display: flex;
  flex-direction: column;
  padding: 12px;
}

.drawer-header {
  display: flex;
  align-items: center;
  gap: 10px;

  .drawer-title {
    font-size: 16px;
    font-weight: 600;
    color: #303133;
  }
}

.request-log-container {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.request-log-item {
  position: relative;
  background: #ffffff;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  padding: 12px;
  cursor: pointer;
  transition: all 0.2s ease;

  &:hover {
    border-color: #409eff;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
    transform: translateY(-1px);

    .item-hover-tip {
      opacity: 1;
      transform: translateX(0);
    }
  }

  .item-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;

    .model-name {
      font-size: 13px;
      font-weight: 600;
      color: #303133;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .duration {
      font-size: 11px;
      font-weight: 600;
      color: #67c23a;
      margin-left: auto;
    }

    .time {
      font-size: 11px;
      color: #909399;
    }
  }

  .item-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 6px;
    flex-wrap: wrap;

    .endpoint-badge {
      font-size: 11px;
      font-family: monospace;
      color: #606266;
      background: #f4f4f5;
      padding: 2px 6px;
      border-radius: 4px;
    }

    .mini-tag {
      font-size: 10px;
      height: 20px;
      line-height: 18px;
      padding: 0 5px;
    }
  }

  .item-prompt-preview {
    font-size: 12px;
    color: #909399;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 4px;

    .prompt-label {
      color: #606266;
      font-weight: 500;
      margin-right: 4px;
    }
  }

  .item-error-preview {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #f56c6c;
    margin-top: 6px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-hover-tip {
    position: absolute;
    right: 10px;
    bottom: 10px;
    font-size: 14px;
    color: #409eff;
    opacity: 0;
    transform: translateX(-4px);
    transition: all 0.2s ease;
  }
}

.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

// 详情弹窗样式
.detail-dialog-body {
  max-height: 65vh;
  overflow-y: auto;
  padding-right: 4px;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px 20px;
  background: #fafafa;
  padding: 16px;
  border-radius: 8px;
  margin-bottom: 16px;

  .overview-cell {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;

    .label {
      color: #909399;
      font-weight: 500;
      min-width: 90px;
    }

    .value {
      color: #303133;
      word-break: break-all;
    }

    .code-font {
      font-family: monospace;
    }

    .font-bold {
      font-weight: 600;
    }

    .text-primary {
      color: #409eff;
    }
  }
}

.error-banner {
  background: #fef0f0;
  border: 1px solid #fde2e2;
  border-radius: 8px;
  padding: 12px;
  margin-top: 12px;

  .error-banner-title {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 600;
    color: #f56c6c;
    margin-bottom: 6px;
  }

  .error-banner-content {
    font-size: 12px;
    color: #f56c6c;
    font-family: monospace;
    line-height: 1.5;
    word-break: break-all;
  }
}

.tab-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: #303133;
    display: flex;
    align-items: center;
    gap: 8px;
  }
}

.code-block-container,
.tool-schema {
  background: #1e1e1e;
  border-radius: 6px;
  padding: 12px;
  box-sizing: border-box;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: auto;

  /* 优雅的自定义滚动条（横向与纵向） */
  &::-webkit-scrollbar {
    width: 6px;
    height: 6px;
  }
  &::-webkit-scrollbar-thumb {
    background: #4a4a4a;
    border-radius: 3px;
    &:hover {
      background: #6e6e6e;
    }
  }
  &::-webkit-scrollbar-track {
    background: #1e1e1e;
    border-radius: 3px;
  }
}

.code-block-container {
  max-height: 420px;
}

.tool-schema {
  max-height: 240px;
}

.code-block {
  margin: 0;
  font-family: Consolas, Monaco, "Courier New", monospace;
  font-size: 12px;
  line-height: 1.5;
  color: #d4d4d4;
  white-space: pre; // 保持代码/JSON格式与缩进，超长行触发横向滚动条
  word-break: normal;

  &.mini {
    font-size: 11.5px;
  }
}

.tool-sub-section {
  margin-bottom: 16px;

  .sub-section-title {
    margin-bottom: 10px;

    &.flex-between {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
    }

    .main-title {
      font-size: 13px;
      font-weight: 600;
      color: #303133;
      margin-right: 8px;
    }

    .sub-desc {
      font-size: 12px;
      color: #909399;
    }

    .search-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
  }

  &.deferred-section {
    background: #fdfdfd;
    border: 1px dashed #dcdfe6;
    border-radius: 8px;
    padding: 12px;
  }
}

.deferred-tools-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  max-height: 260px;
  overflow-y: auto;
  padding: 4px;

  .deferred-tool-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: #f4f4f5;
    border: 1px solid #e9e9eb;
    border-radius: 6px;
    font-size: 12px;
    font-family: Consolas, Monaco, monospace;
    color: #606266;
    cursor: pointer;
    transition: all 0.15s ease;

    .copy-icon {
      font-size: 11px;
      opacity: 0.5;
      transition: opacity 0.15s;
    }

    .mcp-badge {
      font-size: 10px;
      height: 18px;
      line-height: 16px;
      padding: 0 4px;
    }

    &:hover {
      background: #ecf5ff;
      border-color: #b3d8ff;
      color: #409eff;

      .copy-icon {
        opacity: 1;
      }
    }

    &.is-platform-mcp {
      background: #fdf6ec;
      border-color: #faecd8;
      color: #e6a23c;
      font-weight: 600;

      &:hover {
        background: #faecd8;
        border-color: #e6a23c;
      }
    }
  }
}

.tools-container {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .tool-card {
    border: 1px solid #ebeef5;
    border-radius: 8px;
    padding: 12px;
    background: #fcfcfc;
    min-width: 0;
    max-width: 100%;
    box-sizing: border-box;
    width: 100%;

    .tool-card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;

      .tool-name {
        font-family: monospace;
        font-size: 14px;
        font-weight: 600;
        color: #409eff;
      }
    }

    .tool-desc {
      font-size: 12px;
      color: #606266;
      margin-bottom: 8px;
      line-height: 1.4;
    }
  }
}

.messages-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 420px;
  overflow-y: auto;

  .message-bubble {
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 13px;
    line-height: 1.5;

    .bubble-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;

      .bubble-role {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.5px;
      }
    }

    .bubble-content {
      .message-pre {
        margin: 0;
        font-family: inherit;
        white-space: pre-wrap;
        word-break: break-word;
      }
    }

    &.role-system {
      background: #f4f4f5;
      border-left: 4px solid #909399;
      .bubble-role { color: #909399; }
    }

    &.role-user {
      background: #ecf5ff;
      border-left: 4px solid #409eff;
      .bubble-role { color: #409eff; }
    }

    &.role-assistant {
      background: #f0f9eb;
      border-left: 4px solid #67c23a;
      .bubble-role { color: #67c23a; }
    }

    &.role-tool {
      background: #fdf6ec;
      border-left: 4px solid #e6a23c;
      .bubble-role { color: #e6a23c; }
    }
  }
}
</style>
