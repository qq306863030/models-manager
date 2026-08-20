<template>
  <div class="files-page">
    <!-- ========== 顶部导航栏 ========== -->
    <el-header class="app-header">
      <div class="header-left">
        <h1 class="app-title">AI 模型管理平台</h1>
        <div class="header-nav-links">
          <el-button
            :type="currentNav === 'home' ? 'primary' : 'text'"
            @click="handleNavSelect('home')">
            <el-icon><Management /></el-icon>
            模型管理
          </el-button>
          <el-button
            :type="currentNav === 'memory-user' ? 'primary' : 'text'"
            @click="handleNavSelect('memory-user')">
            <el-icon><Document /></el-icon>
            模型记忆
          </el-button>
          <el-button
            :type="currentNav === 'memory-skills' ? 'primary' : 'text'"
            @click="handleNavSelect('memory-skills')">
            <el-icon><Tools /></el-icon>
            处置方案
          </el-button>
          <el-button
            :type="currentNav === 'memory-docs' ? 'primary' : 'text'"
            @click="handleNavSelect('memory-docs')">
            <el-icon><Reading /></el-icon>
            我的文档
          </el-button>
          <el-button
            :type="currentNav === 'files' ? 'primary' : 'text'"
            @click="handleNavSelect('files')">
            <el-icon><FolderOpened /></el-icon>
            我的文件
          </el-button>
        </div>
      </div>
      <div class="header-right">
        <el-button v-if="isAdmin" text @click="$router.push('/user-manage')">
          <el-icon><User /></el-icon>
          用户管理
        </el-button>
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
      <el-card class="files-card-wrapper">
        <template #header>
          <div class="card-header">
            <div class="left">
              <span class="section-title">我的文件</span>
              <span class="item-count">共 {{ fileList.length }} 个文件，{{ formatSize(totalSize) }}</span>
            </div>
          </div>
        </template>

        <!-- 上传区域 -->
        <el-upload
          class="file-upload-area"
          drag
          multiple
          :auto-upload="false"
          :file-list="uploadQueue"
          :on-change="handleFileChange"
          :on-remove="handleRemoveFromQueue"
          :before-upload="beforeUpload"
          :limit="10"
          :on-exceed="handleExceed"
          accept="*"
        >
          <el-icon class="upload-icon"><UploadFilled /></el-icon>
          <div class="el-upload__text">
            将文件拖到此处，或<em>点击上传</em>
          </div>
          <template #tip>
            <div class="el-upload__tip">
              单个文件最大 200MB，最多同时选择 10 个文件
            </div>
          </template>
        </el-upload>

        <!-- 上传按钮 -->
        <div v-if="uploadQueue.length > 0" class="upload-actions">
          <el-button type="primary" :loading="uploading" @click="handleUploadAll">
            <el-icon><Upload /></el-icon>
            开始上传 ({{ uploadQueue.length }} 个文件)
          </el-button>
          <el-button @click="clearUploadQueue">清空</el-button>
        </div>

        <!-- 上传进度 -->
        <div v-if="uploading" class="upload-progress">
          <el-progress :percentage="uploadProgress" :status="uploadProgress === 100 ? 'success' : undefined" />
          <span class="progress-text">{{ uploadStatusText }}</span>
        </div>

        <!-- 文件列表 -->
        <el-table
          v-if="fileList.length > 0"
          :data="fileList"
          stripe
          style="width: 100%"
          v-loading="loading"
        >
          <el-table-column label="文件名" min-width="300">
            <template #default="{ row }">
              <div class="file-name-cell">
                <el-icon class="file-icon"><Document /></el-icon>
                <span class="file-name" :title="row.original_name">{{ row.original_name }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="大小" width="120" align="right">
            <template #default="{ row }">
              <span class="file-size">{{ formatSize(row.file_size) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="上传时间" width="180" align="center">
            <template #default="{ row }">
              <span>{{ row.created_at }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="160" align="center" fixed="right">
            <template #default="{ row }">
              <el-button type="primary" link size="small" @click="handleDownload(row)">
                <el-icon><Download /></el-icon> 下载
              </el-button>
              <el-button type="danger" link size="small" @click="handleDelete(row)">
                <el-icon><Delete /></el-icon> 删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-empty v-if="!loading && fileList.length === 0" description="暂无文件，拖拽文件到上方区域上传" />
      </el-card>
    </el-main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { UploadFile, UploadRawFile } from 'element-plus';
import { getUserFiles, uploadFile, downloadFile, deleteFile, type UserFileItem } from '@/api/userFilesService';
import {
  Management, Document, Tools, Reading, FolderOpened,
  UploadFilled, Upload, Download, Delete, Lock, SwitchButton, User
} from '@element-plus/icons-vue';

const router = useRouter();
const username = localStorage.getItem('auth_username') || '';
const isAdmin = computed(() => {
  const role = localStorage.getItem('auth_role') || '';
  return role === 'super_admin' || role === 'admin';
});

const currentNav = ref('files');
const loading = ref(false);
const fileList = ref<UserFileItem[]>([]);
const uploadQueue = ref<UploadFile[]>([]);
const uploading = ref(false);
const uploadProgress = ref(0);
const uploadStatusText = ref('');

const totalSize = computed(() => fileList.value.reduce((sum, f) => sum + f.file_size, 0));

const handleNavSelect = (index: string) => {
  if (index === 'home') router.push('/');
  else if (index === 'memory-user') router.push('/memory/user');
  else if (index === 'memory-skills') router.push('/memory/skills');
  else if (index === 'memory-docs') router.push('/memory/docs');
  else if (index === 'files') router.push('/files');
};

const handleLogout = () => {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_expire_at');
  localStorage.removeItem('auth_username');
  localStorage.removeItem('auth_role');
  router.push('/login');
};

// 格式化文件大小
const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
};

// 获取文件列表
const fetchFiles = async () => {
  loading.value = true;
  try {
    const res = await getUserFiles();
    if (res.success) {
      fileList.value = res.data || [];
    }
  } catch (err: any) {
    ElMessage.error('获取文件列表失败');
  } finally {
    loading.value = false;
  }
};

// 上传前校验
const beforeUpload = (rawFile: UploadRawFile) => {
  const maxSize = 200 * 1024 * 1024;
  if (rawFile.size > maxSize) {
    ElMessage.error(`文件 "${rawFile.name}" 超过 200MB 限制`);
    return false;
  }
  return true;
};

const handleFileChange = (file: UploadFile) => {
  if (file.raw && file.raw.size > 200 * 1024 * 1024) {
    ElMessage.error(`文件 "${file.name}" 超过 200MB 限制`);
    uploadQueue.value = uploadQueue.value.filter(f => f.uid !== file.uid);
  }
};

const handleRemoveFromQueue = (file: UploadFile) => {
  uploadQueue.value = uploadQueue.value.filter(f => f.uid !== file.uid);
};

const handleExceed = () => {
  ElMessage.warning('最多同时选择 10 个文件');
};

const clearUploadQueue = () => {
  uploadQueue.value = [];
};

// 批量上传
const handleUploadAll = async () => {
  if (uploadQueue.value.length === 0) return;
  uploading.value = true;
  uploadProgress.value = 0;
  const total = uploadQueue.value.length;
  let completed = 0;
  let successCount = 0;
  let failCount = 0;

  for (const file of uploadQueue.value) {
    if (!file.raw) continue;
    uploadStatusText.value = `正在上传: ${file.name} (${completed + 1}/${total})`;
    try {
      await uploadFile(file.raw);
      successCount++;
    } catch (err: any) {
      failCount++;
      ElMessage.error(`上传失败: ${file.name} - ${err.message || '未知错误'}`);
    }
    completed++;
    uploadProgress.value = Math.round((completed / total) * 100);
  }

  uploading.value = false;
  uploadQueue.value = [];
  uploadStatusText.value = '';

  if (successCount > 0) {
    ElMessage.success(`成功上传 ${successCount} 个文件${failCount > 0 ? `，失败 ${failCount} 个` : ''}`);
    fetchFiles();
  }
};

// 下载
const handleDownload = async (file: UserFileItem) => {
  try {
    await downloadFile(file.id, file.original_name);
  } catch (err: any) {
    ElMessage.error(err.message || '下载失败');
  }
};

// 删除
const handleDelete = async (file: UserFileItem) => {
  try {
    await ElMessageBox.confirm(
      `确定要删除文件「${file.original_name}」吗？此操作不可恢复。`,
      '确认删除',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    );
    const res = await deleteFile(file.id);
    if (res.success) {
      ElMessage.success('删除成功');
      fetchFiles();
    }
  } catch (err: any) {
    if (err !== 'cancel') {
      ElMessage.error(err.message || '删除失败');
    }
  }
};

onMounted(() => {
  fetchFiles();
});
</script>

<style scoped lang="less">
.files-page {
  min-height: 100vh;
  background: #f5f7fa;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 60px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  position: sticky;
  top: 0;
  z-index: 100;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 24px;
}

.app-title {
  font-size: 18px;
  font-weight: 600;
  color: #303133;
  margin: 0;
  white-space: nowrap;
}

.header-nav-links {
  display: flex;
  gap: 4px;

  :deep(.el-button) {
    height: 60px;
    border: none;
    border-radius: 0;
    font-size: 14px;
    padding: 0 16px;
    transition: background 0.2s;

    .el-icon {
      margin-right: 5px;
    }

    &.el-button--primary {
      background: #f0f2f5;
      color: #303133;
      font-weight: 500;
      --el-button-bg-color: #f0f2f5;
      --el-button-border-color: transparent;
      --el-button-hover-bg-color: #f0f2f5;
      --el-button-hover-border-color: transparent;
      --el-button-active-bg-color: #f0f2f5;
      --el-button-active-border-color: transparent;
    }

    &.el-button--text {
      color: #606266;
      font-weight: 400;
      --el-button-text-color: #606266;
      --el-button-hover-text-color: #303133;
    }
  }
}

.header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.username {
  font-size: 14px;
  color: #606266;
  margin-left: 8px;
}

.app-main {
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}

.files-card-wrapper {
  border-radius: 8px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;

  .left {
    display: flex;
    align-items: center;
    gap: 12px;
  }
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #303133;
}

.item-count {
  font-size: 13px;
  color: #909399;
}

.file-upload-area {
  margin-bottom: 16px;

  :deep(.el-upload-dragger) {
    padding: 32px 0;
  }

  .upload-icon {
    font-size: 48px;
    color: #c0c4cc;
    margin-bottom: 8px;
  }
}

.upload-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.upload-progress {
  margin-bottom: 16px;

  .progress-text {
    font-size: 13px;
    color: #909399;
    margin-top: 4px;
    display: block;
  }
}

.file-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;

  .file-icon {
    font-size: 16px;
    color: #909399;
    flex-shrink: 0;
  }

  .file-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.file-size {
  color: #606266;
  font-size: 13px;
}
</style>
