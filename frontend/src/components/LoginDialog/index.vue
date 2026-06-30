<template>
  <el-dialog
    v-model="dialogVisible"
    :title="isLogin ? '登录' : '注册'"
    width="400px"
    :close-on-click-modal="false"
    @close="handleClose">
    <el-form
      ref="formRef"
      :model="formData"
      :rules="formRules"
      label-width="80px">
      <el-form-item label="用户名" prop="username">
        <el-input
          v-model="formData.username"
          placeholder="请输入用户名"
          maxlength="20" />
      </el-form-item>

      <el-form-item label="密码" prop="password">
        <el-input
          v-model="formData.password"
          type="password"
          placeholder="请输入密码"
          show-password
          maxlength="20" />
      </el-form-item>

      <el-form-item v-if="isLogin" label="验证码" prop="captcha">
        <div class="captcha-row">
          <el-input
            v-model="formData.captcha"
            placeholder="请输入验证码"
            maxlength="4"
            class="captcha-input" />
          <img
            :src="captchaUrl"
            class="captcha-img"
            alt="验证码"
            @click="refreshCaptcha" />
          <el-button
            text
            type="primary"
            @click="refreshCaptcha">
            刷新
          </el-button>
        </div>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="handleSwitch">
        {{ isLogin ? '没有账号？去注册' : '已有账号？去登录' }}
      </el-button>
      <el-button
        type="primary"
        @click="handleSubmit"
        :loading="loading">
        {{ isLogin ? '登录' : '注册' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import { getCaptcha, login, register } from '@/api/authService'

defineOptions({ name: 'LoginDialog' })

const emit = defineEmits<{
  loginSuccess: [username: string, token: string]
}>()

const dialogVisible = ref(false)
const loading = ref(false)
const formRef = ref<FormInstance>()
const isLogin = ref(true)
const captchaUrl = ref(getCaptcha())

const formData = reactive({
  username: '',
  password: '',
  captcha: '',
})

const formRules: FormRules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 20, message: '用户名长度为 3-20 个字符', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, max: 20, message: '密码长度为 6-20 个字符', trigger: 'blur' },
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

// 打开对话框
const openDialog = () => {
  isLogin.value = true
  formData.username = ''
  formData.password = ''
  formData.captcha = ''
  refreshCaptcha()
  dialogVisible.value = true
}

// 关闭对话框
const handleClose = () => {
  formRef.value?.resetFields()
}

// 切换登录/注册
const handleSwitch = () => {
  isLogin.value = !isLogin.value
  formRef.value?.resetFields()
  if (!isLogin.value) {
    // 注册模式不需要验证码
    delete formRules.captcha
  } else {
    formRules.captcha = [
      { required: true, message: '请输入验证码', trigger: 'blur' },
      { len: 4, message: '验证码为 4 个字符', trigger: 'blur' },
    ]
    refreshCaptcha()
  }
}

// 提交
const handleSubmit = async () => {
  const formValid = await formRef.value?.validate().catch(() => false)
  if (!formValid) return

  loading.value = true
  try {
    let res
    if (isLogin.value) {
      res = await login({
        username: formData.username,
        password: formData.password,
        captcha: formData.captcha,
      })
    } else {
      res = await register({
        username: formData.username,
        password: formData.password,
      })
    }

    if (res.success && res.data) {
      // 保存 token 到 localStorage
      localStorage.setItem('auth_token', res.data.token)
      localStorage.setItem('auth_username', res.data.username)
      localStorage.setItem('auth_expire_at', String(res.data.tokenExpireAt))

      ElMessage.success(isLogin.value ? '登录成功' : '注册成功')
      dialogVisible.value = false
      emit('loginSuccess', res.data.username, res.data.token)
    }
  } finally {
    loading.value = false
  }
}

// 暴露方法给父组件
defineExpose({
  openDialog,
})
</script>

<style scoped lang="less">
.captcha-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.captcha-input {
  width: 120px;
}

.captcha-img {
  height: 32px;
  cursor: pointer;
  border-radius: 4px;
  border: 1px solid #dcdfe6;
}
</style>