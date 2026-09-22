<template>
  <section class="composer-container" @dragover.prevent @drop.prevent="handleDrop">
    <!-- 待发附件列表 -->
    <div v-if="attachments.length > 0" class="attachments-preview">
      <AttachmentList :attachments="attachments" :removable="!isStreaming" @remove="removeAttachment" />
    </div>

    <!-- 输入主体 -->
    <div class="composer-main">
      <textarea
        ref="textareaRef"
        v-model="text"
        class="composer-textarea"
        rows="3"
        :placeholder="placeholderText"
        :disabled="isStreaming"
        @keydown="handleKeyDown"
        @paste="handlePaste"
      ></textarea>

      <!-- 操作工具栏 -->
      <div class="composer-toolbar">
        <div class="toolbar-left">
          <!-- 上传附件按钮 -->
          <button
            type="button"
            class="toolbar-btn"
            title="插入图片或文档 (PDF/DOCX/PPTX/XLSX)"
            :disabled="isStreaming || isUploading"
            @click="triggerFileInput"
          >
            <el-icon v-if="isUploading" class="is-loading"><Loading /></el-icon>
            <el-icon v-else><Paperclip /></el-icon>
            <span class="btn-text">插入图片/文档</span>
          </button>
          <input
            ref="fileInputRef"
            type="file"
            multiple
            accept="image/*,.pdf,.docx,.pptx,.xlsx"
            style="display: none"
            @change="handleFileSelected"
          />

          <span v-if="isUploading" class="upload-tip">正在提取文档内容...</span>
        </div>

        <div class="toolbar-right">
          <button
            v-if="isStreaming"
            type="button"
            class="composer-btn is-stop"
            @click="$emit('stop')"
          >
            <el-icon><VideoPause /></el-icon>
            停止生成
          </button>
          <template v-else>
            <button
              type="button"
              class="composer-btn is-clear"
              title="清空当前会话历史"
              @click="$emit('clear')"
            >
              清空
            </button>
            <button
              type="button"
              class="composer-btn is-send"
              :disabled="!canSend"
              @click="handleSend"
            >
              <el-icon><Promotion /></el-icon>
              发送
            </button>
          </template>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { Paperclip, Promotion, VideoPause, Loading } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import AttachmentList from './AttachmentList.vue';
import type { IAttachmentView } from '../composables/useChatStore';
import { parseDocumentToMarkdown } from '../../../api/chatMcpService';
import { generateUUID } from '../../../utils/uuid';

const props = defineProps<{
  isStreaming: boolean;
}>();

const emit = defineEmits<{
  (e: 'send', text: string, attachments: IAttachmentView[]): void;
  (e: 'stop'): void;
  (e: 'clear'): void;
}>();

const text = ref('');
const attachments = ref<IAttachmentView[]>([]);
const isUploading = ref(false);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

const canSend = computed(() => {
  return (text.value.trim().length > 0 || attachments.value.length > 0) && !isUploading.value && !props.isStreaming;
});

const placeholderText = computed(() => {
  return '输入消息或问题，Enter 发送，Shift + Enter 换行；支持拖入或粘贴图片与文档 (PDF/DOCX/PPTX/XLSX)';
});

function triggerFileInput() {
  fileInputRef.value?.click();
}

function removeAttachment(index: number) {
  attachments.value.splice(index, 1);
}

/** 键盘发送事件 */
function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  // 中文输入法组合态确认拼音时不发送
  if (event.isComposing) return;

  event.preventDefault();
  handleSend();
}

function handleSend() {
  if (!canSend.value) return;

  emit('send', text.value, [...attachments.value]);
  text.value = '';
  attachments.value = [];

  nextTick(() => {
    textareaRef.value?.focus();
  });
}

/** 处理选择的文件 */
async function handleFileSelected(e: Event) {
  const target = e.target as HTMLInputElement;
  if (!target.files || target.files.length === 0) return;

  await processFiles(Array.from(target.files));
  target.value = '';
}

/** 处理拖拽放入 */
async function handleDrop(e: DragEvent) {
  if (props.isStreaming) return;
  if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
    await processFiles(Array.from(e.dataTransfer.files));
  }
}

/** 处理剪贴板粘贴 */
async function handlePaste(e: ClipboardEvent) {
  if (props.isStreaming) return;
  const items = e.clipboardData?.items;
  if (!items || items.length === 0) return;

  const filesToProcess: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) filesToProcess.push(file);
    }
  }

  if (filesToProcess.length > 0) {
    await processFiles(filesToProcess);
  }
}

/** 核心文件处理逻辑 */
async function processFiles(files: File[]) {
  isUploading.value = true;

  for (const file of files) {
    const fileName = file.name;
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();

    // 1. 图片文件处理
    if (file.type.startsWith('image/')) {
      try {
        const base64 = await fileToBase64(file);
        attachments.value.push({
          id: generateUUID(),
          name: fileName,
          size: file.size,
          type: 'image',
          url: base64,
        });
      } catch (err: any) {
        ElMessage.error(`读取图片 ${fileName} 失败: ${err.message}`);
      }
      continue;
    }

    // 2. 文档文件处理 (PDF, DOCX, PPTX, XLSX)
    let docType: 'pdf' | 'docx' | 'pptx' | 'xlsx' | 'file' = 'file';
    if (ext === '.pdf') docType = 'pdf';
    else if (ext === '.docx' || ext === '.doc') docType = 'docx';
    else if (ext === '.pptx' || ext === '.ppt') docType = 'pptx';
    else if (ext === '.xlsx' || ext === '.xls') docType = 'xlsx';

    const item: IAttachmentView = {
      id: generateUUID(),
      name: fileName,
      size: file.size,
      type: docType,
    };

    attachments.value.push(item);

    // 调用后端利用 doc-processor 提取 Markdown 纯文本
    try {
      const res = await parseDocumentToMarkdown(file);
      if (res.success && res.data?.markdown) {
        item.extractedText = res.data.markdown;
        if (res.data.serverFilePath) {
          item.serverFilePath = res.data.serverFilePath;
        }
        ElMessage.success(`文档《${fileName}》内容提取完成`);
      }
    } catch (err: any) {
      console.warn(`[Composer] 解析文档 ${fileName} 警告:`, err);
      ElMessage.warning(`文档《${fileName}》未能提取纯文本，将作为普通参考提交`);
    }
  }

  isUploading.value = false;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
</script>

<style scoped lang="less">
.composer-container {
  padding: 12px 16px;
  background-color: #ffffff;
  border-top: 1px solid #e4e7ed;

  .attachments-preview {
    margin-bottom: 8px;
  }

  .composer-main {
    border: 1px solid #dcdfe6;
    border-radius: 8px;
    padding: 8px 12px 6px;
    background-color: #fafbfc;
    transition: border-color 0.2s;

    &:focus-within {
      border-color: #409eff;
      background-color: #ffffff;
    }
  }

  .composer-textarea {
    width: 100%;
    border: none;
    outline: none;
    resize: none;
    font-family: inherit;
    font-size: 14px;
    line-height: 1.5;
    background-color: transparent;
    color: #303133;

    &::placeholder {
      color: #a8abb2;
      font-size: 13px;
    }
  }

  .composer-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 4px;
    padding-top: 4px;

    .toolbar-left {
      display: flex;
      align-items: center;
      gap: 10px;

      .toolbar-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        background: transparent;
        border: 1px dashed #dcdfe6;
        border-radius: 4px;
        color: #606266;
        font-size: 12px;
        cursor: pointer;
        transition: all 0.2s;

        &:hover:not(:disabled) {
          border-color: #409eff;
          color: #409eff;
        }

        &:disabled {
          cursor: not-allowed;
          opacity: 0.5;
        }
      }

      .upload-tip {
        font-size: 12px;
        color: #409eff;
      }
    }

    .toolbar-right {
      display: flex;
      align-items: center;
      gap: 8px;

      .composer-btn {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 6px 14px;
        font-size: 13px;
        font-weight: 500;
        border-radius: 6px;
        border: none;
        cursor: pointer;
        transition: all 0.2s;

        &.is-send {
          background-color: #409eff;
          color: #ffffff;

          &:hover:not(:disabled) {
            background-color: #66b1ff;
          }

          &:disabled {
            background-color: #a0cfff;
            cursor: not-allowed;
          }
        }

        &.is-stop {
          background-color: #f56c6c;
          color: #ffffff;

          &:hover {
            background-color: #f78989;
          }
        }

        &.is-clear {
          background-color: transparent;
          color: #909399;

          &:hover {
            color: #f56c6c;
          }
        }
      }
    }
  }
}
</style>
