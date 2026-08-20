<template>
  <div class="files-page">
    <van-nav-bar title="我的文件" left-arrow @click-left="router.back()" />

    <div class="content">
      <!-- 上传按钮 -->
      <div class="upload-section">
        <van-button block type="primary" size="small" @click="triggerUpload">
          上传文件
        </van-button>
        <input
          ref="fileInputRef"
          type="file"
          multiple
          style="display: none"
          @change="handleFileSelect"
        />
        <div class="upload-tip">单个文件最大 200MB</div>
      </div>

      <!-- 上传进度 -->
      <div v-if="uploading" class="upload-progress">
        <van-progress :percentage="uploadProgress" :stroke-width="6" />
        <span class="progress-text">{{ uploadStatusText }}</span>
      </div>

      <!-- 文件列表 -->
      <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
        <van-cell-group inset v-if="fileList.length > 0">
          <van-cell
            v-for="file in fileList"
            :key="file.id"
            :title="file.original_name"
            :label="formatSize(file.file_size) + ' · ' + file.created_at"
          >
            <template #right-icon>
              <div class="cell-actions">
                <van-button size="mini" type="primary" @click="handleDownload(file)">下载</van-button>
                <van-button size="mini" type="danger" @click="handleDelete(file)">删除</van-button>
              </div>
            </template>
          </van-cell>
        </van-cell-group>
        <van-empty v-else-if="!loading" description="暂无文件" />
      </van-pull-refresh>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { showToast, showConfirmDialog } from 'vant';
import { getUserFiles, uploadFile, downloadFile, deleteFile, type UserFileItem } from '@/api/userFilesService';

const router = useRouter();
const loading = ref(false);
const refreshing = ref(false);
const fileList = ref<UserFileItem[]>([]);
const fileInputRef = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const uploadProgress = ref(0);
const uploadStatusText = ref('');

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
};

const fetchFiles = async () => {
  loading.value = true;
  try {
    const res = await getUserFiles();
    if (res.success) {
      fileList.value = res.data || [];
    }
  } catch {
    showToast('获取文件列表失败');
  } finally {
    loading.value = false;
  }
};

const onRefresh = async () => {
  await fetchFiles();
  refreshing.value = false;
};

const triggerUpload = () => {
  fileInputRef.value?.click();
};

const handleFileSelect = async (e: Event) => {
  const input = e.target as HTMLInputElement;
  const files = input.files;
  if (!files || files.length === 0) return;

  const maxSize = 200 * 1024 * 1024;
  const validFiles: File[] = [];
  for (let i = 0; i < files.length; i++) {
    if (files[i].size > maxSize) {
      showToast(`文件 "${files[i].name}" 超过 200MB 限制`);
    } else {
      validFiles.push(files[i]);
    }
  }

  if (validFiles.length === 0) {
    input.value = '';
    return;
  }

  uploading.value = true;
  uploadProgress.value = 0;
  const total = validFiles.length;
  let completed = 0;
  let successCount = 0;

  for (const file of validFiles) {
    uploadStatusText.value = `正在上传: ${file.name} (${completed + 1}/${total})`;
    try {
      await uploadFile(file);
      successCount++;
    } catch (err: any) {
      showToast(`上传失败: ${file.name}`);
    }
    completed++;
    uploadProgress.value = Math.round((completed / total) * 100);
  }

  uploading.value = false;
  uploadStatusText.value = '';
  input.value = '';

  if (successCount > 0) {
    showToast(`成功上传 ${successCount} 个文件`);
    fetchFiles();
  }
};

const handleDownload = async (file: UserFileItem) => {
  try {
    await downloadFile(file.id, file.original_name);
  } catch (err: any) {
    showToast(err.message || '下载失败');
  }
};

const handleDelete = async (file: UserFileItem) => {
  try {
    await showConfirmDialog({
      title: '确认删除',
      message: `确定要删除文件「${file.original_name}」吗？`,
    });
    const res = await deleteFile(file.id);
    if (res.success) {
      showToast('删除成功');
      fetchFiles();
    }
  } catch {
    // 用户取消
  }
};

onMounted(() => {
  fetchFiles();
});
</script>

<style scoped lang="less">
.files-page {
  min-height: 100vh;
  background: #f7f8fa;
}

.content {
  padding: 12px 0;
}

.upload-section {
  padding: 0 16px 12px;

  .upload-tip {
    font-size: 12px;
    color: #969799;
    margin-top: 4px;
    text-align: center;
  }
}

.upload-progress {
  padding: 0 16px 12px;

  .progress-text {
    font-size: 12px;
    color: #969799;
    display: block;
    margin-top: 4px;
  }
}

.cell-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
</style>
