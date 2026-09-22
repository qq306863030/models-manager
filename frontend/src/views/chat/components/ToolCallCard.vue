<template>
  <div class="tool-call-card" :class="`status-${tool.status}`">
    <div class="tool-call-header" @click="isExpanded = !isExpanded">
      <div class="tool-call-title-row">
        <el-icon class="tool-icon" :class="{ 'is-loading': tool.status === 'running' }">
          <Loading v-if="tool.status === 'running'" />
          <CircleCheckFilled v-else-if="tool.status === 'done'" />
          <CircleCloseFilled v-else-if="tool.status === 'failed'" />
          <Clock v-else />
        </el-icon>
        <span class="tool-title">{{ tool.title || tool.name }}</span>
        <span class="tool-name-code">({{ tool.name }})</span>
      </div>

      <div class="tool-call-status-badge">
        <span class="badge-text">{{ statusText }}</span>
        <el-icon class="arrow-icon" :class="{ 'is-open': isExpanded }">
          <ArrowDown />
        </el-icon>
      </div>
    </div>

    <!-- 摘要信息 -->
    <div class="tool-call-preview" v-if="tool.preview && !isExpanded">
      <span class="preview-label">参数：</span>{{ tool.preview }}
    </div>

    <!-- 生成文件快捷下载栏 -->
    <div v-if="downloadInfo" class="tool-download-bar">
      <el-button
        type="success"
        size="small"
        plain
        class="download-btn"
        @click.stop="handleDownload"
      >
        <el-icon><Download /></el-icon>
        下载生成的文件 ({{ downloadInfo.fileName }})
      </el-button>
    </div>

    <!-- 展开详情 -->
    <el-collapse-transition>
      <div v-show="isExpanded" class="tool-call-body">
        <div class="detail-section">
          <div class="section-title">调用参数 (Arguments)</div>
          <pre class="code-block">{{ formattedArgs }}</pre>
        </div>

        <div v-if="tool.summary" class="detail-section">
          <div class="section-title">执行结论 (Result)</div>
          <pre class="code-block result-block">{{ tool.summary }}</pre>
        </div>
      </div>
    </el-collapse-transition>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  Loading,
  CircleCheckFilled,
  CircleCloseFilled,
  Clock,
  ArrowDown,
  Download,
} from '@element-plus/icons-vue';
import type { IToolCallView } from '../core/AgentLoop';

const props = defineProps<{
  tool: IToolCallView;
}>();

const isExpanded = ref(false);

const statusText = computed(() => {
  switch (props.tool.status) {
    case 'pending':
      return '等待中';
    case 'running':
      return '执行中...';
    case 'done':
      return '完成';
    case 'failed':
      return '失败';
    default:
      return '';
  }
});

const formattedArgs = computed(() => {
  try {
    const obj = JSON.parse(props.tool.argsText || '{}');
    return JSON.stringify(obj, null, 2);
  } catch {
    return props.tool.argsText || '{}';
  }
});

// 从工具结果中检测下载链接
const downloadInfo = computed(() => {
  if (!props.tool.summary) return null;

  // 1. 优先尝试直接从工具结果的 JSON 结构中精准解析 downloadUrl 和 fileName
  try {
    const parsed = JSON.parse(props.tool.summary);
    if (parsed && typeof parsed === 'object') {
      const url = parsed.downloadUrl || parsed.data?.downloadUrl;
      const fileName = parsed.fileName || parsed.data?.fileName;
      if (url && fileName) {
        return {
          url: String(url).trim(),
          fileName: String(fileName).trim(),
        };
      }
    }
  } catch {}

  // 2. 匹配平台用户文件接口: /api/user-files/{id}/download?username=...
  const userFileMatch = props.tool.summary.match(/\/api\/user-files\/\d+\/download(?:\?[^"'\s\n\)\<]+)?/);
  if (userFileMatch) {
    let name = '下载文件';
    const nameMatch = props.tool.summary.match(/[-*]\s*文件名称:\s*([^\r\n]+)/);
    if (nameMatch) name = nameMatch[1].trim();
    return {
      url: userFileMatch[0],
      fileName: name,
    };
  }

  // 3. 匹配 MCP 下载接口: /api/mcp/download?file=...
  const mcpMatch = props.tool.summary.match(/\/api\/mcp\/download\?file=([a-zA-Z0-9_\-\.\%]+)/);
  if (mcpMatch) {
    const rawFileName = decodeURIComponent(mcpMatch[1]);
    return {
      url: mcpMatch[0],
      fileName: rawFileName,
    };
  }

  return null;
});

function handleDownload() {
  if (!downloadInfo.value) return;
  const { url, fileName } = downloadInfo.value;
  const a = document.createElement('a');
  a.href = url;
  if (fileName) a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
</script>

<style scoped lang="less">
.tool-call-card {
  margin: 8px 0;
  border-radius: 8px;
  border: 1px solid #e4e7ed;
  background-color: #f8fafc;
  font-size: 13px;
  overflow: hidden;
  transition: all 0.2s ease;

  &.status-running {
    border-color: #409eff;
    background-color: #ecf5ff;
    .tool-icon {
      color: #409eff;
    }
  }

  &.status-done {
    border-color: #e1f3d8;
    background-color: #f0f9eb;
    .tool-icon {
      color: #67c23a;
    }
  }

  &.status-failed {
    border-color: #fde2e2;
    background-color: #fef0f0;
    .tool-icon {
      color: #f56c6c;
    }
  }

  .tool-call-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;

    &:hover {
      background-color: rgba(0, 0, 0, 0.02);
    }
  }

  .tool-call-title-row {
    display: flex;
    align-items: center;
    gap: 6px;

    .tool-icon {
      font-size: 15px;
    }

    .tool-title {
      font-weight: 600;
      color: #303133;
    }

    .tool-name-code {
      font-size: 11px;
      color: #909399;
      font-family: monospace;
    }
  }

  .tool-call-status-badge {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: #606266;

    .arrow-icon {
      transition: transform 0.2s;
      &.is-open {
        transform: rotate(180deg);
      }
    }
  }

  .tool-call-preview {
    padding: 0 12px 6px;
    color: #606266;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    .preview-label {
      color: #909399;
    }
  }

  .tool-download-bar {
    padding: 2px 12px 8px;
    display: flex;
    align-items: center;

    .download-btn {
      font-weight: 500;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
    }
  }

  .tool-call-body {
    padding: 8px 12px 10px;
    border-top: 1px dashed #dcdfe6;
    background-color: #ffffff;

    .detail-section {
      margin-top: 6px;
      &:first-child {
        margin-top: 0;
      }

      .section-title {
        font-size: 11px;
        font-weight: 600;
        color: #909399;
        margin-bottom: 4px;
        text-transform: uppercase;
      }

      .code-block {
        margin: 0;
        padding: 6px 10px;
        background-color: #282c34;
        color: #abb2bf;
        border-radius: 4px;
        font-family: Consolas, Monaco, monospace;
        font-size: 11px;
        white-space: pre-wrap;
        word-break: break-all;
        max-height: 180px;
        overflow-y: auto;

        &.result-block {
          background-color: #f4f4f5;
          color: #303133;
          border: 1px solid #e4e7ed;
        }
      }
    }
  }
}
</style>
