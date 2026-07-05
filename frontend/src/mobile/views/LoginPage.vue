<template>
  <div class="login-page">
    <div class="login-header">
      <h1 class="title">AI 模型管理平台</h1>
      <p class="subtitle">统一管理多模型 API 代理服务</p>
    </div>
    <div class="login-form">
      <van-cell-group inset>
        <van-field v-model="formData.username" placeholder="请输入用户名" size="large" />
        <van-field v-model="formData.password" type="password" placeholder="请输入密码" size="large" />
        <van-field v-model="formData.captcha" placeholder="请输入验证码" size="large" maxlength="4" @keyup.enter="handleLogin">
          <template #button>
            <van-image :src="captchaUrl" class="captcha-img" fit="cover" @click="refreshCaptcha" />
          </template>
        </van-field>
      </van-cell-group>
      <div class="login-button-wrapper">
        <van-button type="primary" block size="large" :loading="loading" @click="handleLogin">登 录</van-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { showToast, showFailToast } from 'vant';
import { getCaptcha, login } from '@/api/authService';

const router = useRouter();
const formData = reactive({ username: '', password: '', captcha: '' });
const loading = ref(false);
const captchaUrl = ref(getCaptcha());

const refreshCaptcha = () => { captchaUrl.value = `${getCaptcha()}?t=${Date.now()}`; };

const handleLogin = async () => {
  if (!formData.username.trim()) { showToast('请输入用户名'); return; }
  if (!formData.password) { showToast('请输入密码'); return; }
  if (!formData.captcha.trim() || formData.captcha.length !== 4) { showToast('请输入4位验证码'); return; }

  loading.value = true;
  try {
    const res = await login({ username: formData.username, password: formData.password, captcha: formData.captcha });
    if (res.success && res.data) {
      localStorage.setItem('auth_token', res.data.token);
      localStorage.setItem('auth_username', res.data.username);
      localStorage.setItem('auth_expire_at', String(res.data.tokenExpireAt));
      localStorage.setItem('auth_role', res.data.role || 'user');
      localStorage.setItem('auth_is_admin', res.data.role === 'super_admin' || res.data.role === 'admin' ? '1' : '0');
      localStorage.setItem('auth_userId', String(res.data.userId));
      showToast({ message: '登录成功', position: 'top' });
      router.push('/m/');
    } else {
      showFailToast(res.message || '登录失败');
      refreshCaptcha();
    }
  } catch (error: any) {
    showFailToast(error?.response?.data?.message || '登录失败');
    refreshCaptcha();
  } finally {
    loading.value = false;
  }
};
</script>

<style scoped lang="less">
.login-page { min-height: 100vh; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); display: flex; flex-direction: column; padding: 60px 24px 40px; }
.login-header { text-align: center; margin-bottom: 48px; .title { color: #fff; font-size: 24px; font-weight: 600; margin: 0 0 8px; } .subtitle { color: rgba(255,255,255,0.8); font-size: 14px; margin: 0; } }
.login-form { flex: 1; .van-cell-group { background: #fff; border-radius: 12px; } .captcha-img { width: 100px; height: 40px; border-radius: 4px; cursor: pointer; } }
.login-button-wrapper { margin: 16px 16px 0; .van-button--primary { background: #fff; border-color: #fff; color: #667eea; font-weight: 600; border-radius: 8px; } }
</style>
