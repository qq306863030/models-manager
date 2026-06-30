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
          <el-button type="primary" size="small" @click="openAddDialog">
            <el-icon><Plus /></el-icon>
            添加用户
          </el-button>
        </div>
      </template>

      <el-table :data="userList" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="60" align="center" />
        <el-table-column prop="name" label="用户名" min-width="120" />
        <el-table-column label="角色" width="120" align="center">
          <template #default="{ row }">
            <el-tag :type="roleTagType(row.role)" size="small">
              {{ roleLabel(row.role) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="email" label="邮箱" min-width="150">
          <template #default="{ row }">
            {{ row.email || '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="created_at" label="创建时间" width="170">
          <template #default="{ row }">
            {{ formatDate(row.created_at) }}
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140" align="center" fixed="right">
          <template #default="{ row }">
            <el-button
              size="small"
              text
              @click="openEditDialog(row)">
              编辑
            </el-button>
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
    <el-dialog v-model="addDialogVisible" title="添加用户" width="420px">
      <el-form ref="addFormRef" :model="addFormData" :rules="addFormRules" label-width="80px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="addFormData.username" placeholder="请输入用户名" />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input v-model="addFormData.password" type="password" placeholder="请输入密码" show-password />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="addFormData.role" style="width: 100%">
            <el-option label="普通用户" value="user" />
            <el-option label="管理员" value="admin" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="addDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="addLoading" @click="handleAdd">确定</el-button>
      </template>
    </el-dialog>

    <!-- 编辑用户对话框 -->
    <el-dialog v-model="editDialogVisible" title="编辑用户" width="420px">
      <el-form ref="editFormRef" :model="editFormData" :rules="editFormRules" label-width="80px">
        <el-form-item label="用户名" prop="username">
          <el-input v-model="editFormData.username" placeholder="请输入用户名" />
        </el-form-item>
        <el-form-item label="新密码" prop="password">
          <el-input v-model="editFormData.password" type="password" placeholder="留空则不修改密码" show-password />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select v-model="editFormData.role" style="width: 100%">
            <el-option label="普通用户" value="user" />
            <el-option label="管理员" value="admin" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="editLoading" @click="handleEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Back, Plus } from '@element-plus/icons-vue'
import { getUserList, deleteUser, createUser, updateUser } from '@/api/authService'
import type { UserItem } from '@/api/authService'

const router = useRouter()
const loading = ref(false)
const userList = ref<UserItem[]>([])
const currentUserId = ref<number>(0)

// ========== 添加用户 ==========
const addDialogVisible = ref(false)
const addFormRef = ref<FormInstance>()
const addLoading = ref(false)
const addFormData = reactive({
  username: '',
  password: '',
  role: 'user',
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
  role: [
    { required: true, message: '请选择角色', trigger: 'change' },
  ],
}

// ========== 编辑用户 ==========
const editDialogVisible = ref(false)
const editFormRef = ref<FormInstance>()
const editLoading = ref(false)
const editingUser = ref<UserItem | null>(null)
const editFormData = reactive({
  username: '',
  password: '',
  role: 'user',
})

const editFormRules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 20, message: '用户名长度为 3-20 个字符', trigger: 'blur' },
  ],
  role: [
    { required: true, message: '请选择角色', trigger: 'change' },
  ],
}

// ========== 工具函数 ==========

const roleLabel = (role: string) => {
  const map: Record<string, string> = {
    super_admin: '超级管理员',
    admin: '管理员',
    user: '普通用户',
  }
  return map[role] || role
}

const roleTagType = (role: string) => {
  const map: Record<string, string> = {
    super_admin: 'danger',
    admin: 'warning',
    user: 'info',
  }
  return map[role] || 'info'
}

const formatDate = (dateStr: string) => {
  if (!dateStr) return '-'
  const date = new Date(dateStr)
  return date.toLocaleString('zh-CN')
}

const goBack = () => {
  router.back()
}

// ========== 数据加载 ==========

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

// ========== 添加用户 ==========

const openAddDialog = () => {
  addFormData.username = ''
  addFormData.password = ''
  addFormData.role = 'user'
  addDialogVisible.value = true
}

const handleAdd = async () => {
  const formValid = await addFormRef.value?.validate().catch(() => false)
  if (!formValid) return

  addLoading.value = true
  try {
    const res = await createUser(addFormData.username, addFormData.password, addFormData.role)
    if (res.success) {
      ElMessage.success('添加成功')
      addDialogVisible.value = false
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

// ========== 编辑用户 ==========

const openEditDialog = (row: UserItem) => {
  editingUser.value = row
  editFormData.username = row.name
  editFormData.password = ''
  editFormData.role = row.role === 'super_admin' ? 'admin' : row.role
  editDialogVisible.value = true
}

const handleEdit = async () => {
  const formValid = await editFormRef.value?.validate().catch(() => false)
  if (!formValid) return
  if (!editingUser.value) return

  editLoading.value = true
  try {
    const data: any = {
      name: editFormData.username,
      role: editFormData.role,
    }
    if (editFormData.password) {
      data.password = editFormData.password
    }
    const res = await updateUser(editingUser.value.id, data)
    if (res.success) {
      ElMessage.success('更新成功')
      editDialogVisible.value = false
      loadUsers()
    } else {
      ElMessage.error(res.message || '更新失败')
    }
  } catch (error: any) {
    ElMessage.error(error?.message || '更新失败')
  } finally {
    editLoading.value = false
  }
}

// ========== 删除用户 ==========

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

// ========== 初始化 ==========

onMounted(() => {
  loadUsers()
  // 从 localStorage 获取当前用户ID
  const userId = localStorage.getItem('auth_userId')
  if (userId) {
    currentUserId.value = parseInt(userId)
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
  max-width: 900px;

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