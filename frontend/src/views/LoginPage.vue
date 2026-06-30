<template>
  <div class="login-container">
    <div class="login-card">
      <h1 class="title">AI 模型管理平台</h1>
      <p class="subtitle">统一管理多模型 API 代理服务</p>

      <el-form
        ref="formRef"
        :model="formData"
        :rules="formRules"
        class="login-form">
        <el-form-item prop="username">
          <el-input
            v-model="formData.username"
            placeholder="请输入用户名"
            prefix-icon="User"
            size="large" />
        </el-form-item>

        <el-form-item prop="password">
          <el-input
            v-model="formData.password"
            type="password"
            placeholder="请输入密码"
            prefix-icon="Lock"
            size="large"
            show-password
            @keyup.enter="handleLogin" />
        </el-form-item>

        <el-form-item prop="captcha">
          <div class="captcha-row">
            <el-input
              v-model="formData.captcha"
              placeholder="请输入验证码"
              prefix-icon="Key"
              size="large"
              maxlength="4"
              @keyup.enter="handleLogin" />
            <img
              :src="captchaUrl"
              class="captcha-img"
              alt="验证码"
              @click="refreshCaptcha" />
          </div>
        </el-form-item>

        <el-form-item>
          <el-button
            type="primary"
            size="large"
            :loading="loading"
            class="login-btn"
            @click="handleLogin">
            登 录
          </el-button>
        </el-form-item>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { User, Lock, Key } from '@element-plus/icons-vue'
import { getCaptcha, login } from '@/api/authService'

const router = useRouter()
const formRef = ref<FormInstance>()
const loading = ref(false)
const captchaUrl = ref(getCaptcha())

const formData = reactive({
  username: '',
  password: '',
  captcha: '',
})

const formRules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
  ],
  captcha: [
    { required: true, message: '请输入验证码', trigger: 'blur' },
    { len: 4, message: '验证码为 4 个字符', trigger: 'blur' },
  ],
}

// 刷新验证码
const refreshCaptcha = () => {
  captchaUrl.value = `${getCaptcha()}?t=${Date.now()}`
}

// 登录
const handleLogin = async () => {
  const formValid = await formRef.value?.validate().catch(() => false)
  if (!formValid) return

  loading.value = true
  try {
    const res = await login({
      username: formData.username,
      password: formData.password,
      captcha: formData.captcha,
    })

    if (res.success && res.data) {
      // 保存登录信息
      localStorage.setItem('auth_token', res.data.token)
      localStorage.setItem('auth_username', res.data.username)
      localStorage.setItem('auth_expire_at', String(res.data.tokenExpireAt))
      localStorage.setItem('auth_role', res.data.role || 'user')

      ElMessage.success('登录成功')
      router.push('/')
    } else {
      ElMessage.error(res.message || '登录失败')
      refreshCaptcha()
    }
  } catch (error: any) {
    ElMessage.error(error?.message || '登录失败')
    refreshCaptcha()
  } finally {
    loading.value = false
  }
}
</script>

<style scoped lang="less">
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

.login-card {
  width: 400px;
  padding: 40px;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
}

.title {
  text-align: center;
  font-size: 24px;
  font-weight: 600;
  color: #303133;
  margin-bottom: 8px;
}

.subtitle {
  text-align: center;
  font-size: 14px;
  color: #909399;
  margin-bottom: 32px;
}

.login-form {
  margin-top: 20px;
}

.captcha-row {
  display: flex;
  gap: 12px;
  width: 100%;

  :deep(.el-input) {
    flex: 1;
  }
}

.captcha-img {
  height: 40px;
  width: 120px;
  cursor: pointer;
  border-radius: 4px;
  border: 1px solid #dcdfe6;
  transition: border-color 0.3s;

  &:hover {
    border-color: #409eff;
  }
}

.login-btn {
  width: 100%;
  font-size: 16px;
}
</style>