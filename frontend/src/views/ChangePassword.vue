<template>
  <div class="page-container">
    <el-card class="page-card">
      <template #header>
        <div class="card-header">
          <el-button text @click="goBack">
            <el-icon><Back /></el-icon>
            返回
          </el-button>
          <span>修改密码</span>
        </div>
      </template>

      <el-form
        ref="formRef"
        :model="formData"
        :rules="formRules"
        label-width="100px"
        class="change-password-form">
        <el-form-item label="当前密码" prop="oldPassword">
          <el-input
            v-model="formData.oldPassword"
            type="password"
            placeholder="请输入当前密码"
            show-password
            size="large" />
        </el-form-item>

        <el-form-item label="新密码" prop="newPassword">
          <el-input
            v-model="formData.newPassword"
            type="password"
            placeholder="请输入新密码（至少6个字符）"
            show-password
            size="large" />
        </el-form-item>

        <el-form-item label="确认密码" prop="confirmPassword">
          <el-input
            v-model="formData.confirmPassword"
            type="password"
            placeholder="请再次输入新密码"
            show-password
            size="large" />
        </el-form-item>

        <el-form-item>
          <el-button
            type="primary"
            size="large"
            :loading="loading"
            @click="handleSubmit">
            确认修改
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { Back } from '@element-plus/icons-vue'
import { changePassword } from '@/api/authService'

const router = useRouter()
const formRef = ref<FormInstance>()
const loading = ref(false)

const formData = reactive({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
})

// 自定义验证：确认密码
const validateConfirm = (_rule: any, value: string, callback: any) => {
  if (value !== formData.newPassword) {
    callback(new Error('两次输入的密码不一致'))
  } else {
    callback()
  }
}

const formRules: FormRules = {
  oldPassword: [
    { required: true, message: '请输入当前密码', trigger: 'blur' },
  ],
  newPassword: [
    { required: true, message: '请输入新密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少为 6 个字符', trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入新密码', trigger: 'blur' },
    { validator: validateConfirm, trigger: 'blur' },
  ],
}

const goBack = () => {
  router.back()
}

const handleSubmit = async () => {
  const formValid = await formRef.value?.validate().catch(() => false)
  if (!formValid) return

  const username = localStorage.getItem('auth_username') || ''

  loading.value = true
  try {
    const res = await changePassword(username, formData.oldPassword, formData.newPassword)

    if (res.success) {
      ElMessage.success('密码修改成功，请重新登录')
      // 清除登录信息
      localStorage.removeItem('auth_token')
      localStorage.removeItem('auth_username')
      localStorage.removeItem('auth_expire_at')
      localStorage.removeItem('auth_is_admin')
      localStorage.removeItem('auth_role')
      localStorage.removeItem('auth_userId')
      router.push('/login')
    } else {
      ElMessage.error(res.message || '修改失败')
    }
  } catch (error: any) {
    ElMessage.error(error?.message || '修改失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped lang="less">
.page-container {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 40px 20px;
  background: #f5f7fa;
  min-height: calc(100vh - 60px);
}

.page-card {
  width: 500px;

  .card-header {
    display: flex;
    align-items: center;
    gap: 12px;

    span {
      font-size: 16px;
      font-weight: 500;
    }
  }
}

.change-password-form {
  max-width: 400px;
  margin: 0 auto;
}
</style>