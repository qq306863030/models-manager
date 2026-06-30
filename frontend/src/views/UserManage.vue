<template>
  <div class="page-container">
    <el-card class="page-card">
      <template #header>
        <div class="card-header">
          <el-button text @click="goBack">
            <el-icon><Back /></el-icon>
            返回
          </el-button>
          <span>用户管理</span>
          <el-button type="primary" size="small" @click="showAddDialog = true">
            <el-icon><Plus /></el-icon>
            添加用户
          </el-button>
        </div>
      </template>

      <el-table :data="userList" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" align="center" />
        <el-table-column prop="name" label="用户名" min-width="150" />
        <el-table-column label="角色" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.is_admin === 1 ? 'danger' : 'info'" size="small">
              {{ row.is_admin === 1 ? '管理员' : '普通用户' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="180">
          <template #default="{ row }">
            {{ formatDate(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="120" align="center">
          <template #default="{ row }">
            <el-button
              type="danger"
              size="small"
              text
              :disabled="row.id === currentUserId"
              @click="handleDelete(row)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 添加用户对话框 -->
    <el-dialog v-model="showAddDialog" title="添加用户" width="400px">
      <el-form ref="addFormRef" :model="addFormData" :rules="addFormRules" label-width="80px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="addFormData.username" placeholder="请输入用户名" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="addFormData.password" type="password" placeholder="请输入密码" show-password />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="showAddDialog = false">取消</el-button>
        <el-button type="primary" :loading="addLoading" @click="handleAdd">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Back, Plus } from '@element-plus/icons-vue'
import { getUserList, deleteUser, createUser } from '@/api/authService'
import type { UserItem } from '@/api/authService'

const router = useRouter()
const loading = ref(false)
const userList = ref<UserItem[]>([])
const currentUserId = ref<number>(0)

const showAddDialog = ref(false)
const addFormRef = ref<FormInstance>()
const addLoading = ref(false)
const addFormData = reactive({
  username: '',
  password: '',
})

const addFormRules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 20, message: '用户名长度为 3-20 个字符', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少为 6 个字符', trigger: 'blur' },
  ],
}

const formatDate = (dateStr: string) => {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN')
}

const goBack = () => {
  router.back()
}

const loadUsers = async () => {
  loading.value = true
  try {
    const res = await getUserList()
    if (res.success && res.data) {
      userList.value = res.data
    }
  } catch (error) {
    ElMessage.error('加载用户列表失败')
  } finally {
    loading.value = false
  }
}

const handleDelete = async (row: UserItem) => {
  try {
    await ElMessageBox.confirm(`确定要删除用户 "${row.name}" 吗？`, '提示', {
      confirmButtonText: '确定',
      cancelButtonText: '取消',
      type: 'warning',
    })

    const res = await deleteUser(row.id)
    if (res.success) {
      ElMessage.success('删除成功')
      loadUsers()
    } else {
      ElMessage.error(res.message || '删除失败')
    }
  } catch (error: any) {
    if (error !== 'cancel') {
      ElMessage.error(error?.message || '删除失败')
    }
  }
}

const handleAdd = async () => {
  const formValid = await addFormRef.value?.validate().catch(() => false)
  if (!formValid) return

  addLoading.value = true
  try {
    const res = await createUser(addFormData.username, addFormData.password)
    if (res.success) {
      ElMessage.success('添加成功')
      showAddDialog.value = false
      addFormRef.value?.resetFields()
      loadUsers()
    } else {
      ElMessage.error(res.message || '添加失败')
    }
  } catch (error: any) {
    ElMessage.error(error?.message || '添加失败')
  } finally {
    addLoading.value = false
  }
}

onMounted(() => {
  loadUsers()
  // 从 localStorage 获取当前用户ID（暂时用用户名匹配）
  const username = localStorage.getItem('auth_username')
  const isAdmin = localStorage.getItem('auth_is_admin')
  if (isAdmin === '1' && username === 'admin') {
    currentUserId.value = 1 // 默认管理员ID
  }
})
</script>

<style scoped lang="less">
.page-container {
  display: flex;
  justify-content: center;
  padding: 40px 20px;
  background: #f5f7fa;
  min-height: calc(100vh - 60px);
}

.page-card {
  width: 100%;
  max-width: 800px;

  .card-header {
    display: flex;
    align-items: center;
    gap: 12px;

    span {
      flex: 1;
      font-size: 16px;
      font-weight: 500;
    }
  }
}
</style>