<template>
  <div class="change-password-page">
    <van-nav-bar title="修改密码" left-text="返回" left-arrow @click-left="goBack" />
    <div class="form-container">
      <van-cell-group inset>
        <van-field v-model="formData.oldPassword" type="password" label="当前密码" placeholder="请输入当前密码" />
        <van-field v-model="formData.newPassword" type="password" label="新密码" placeholder="请输入新密码（至少6个字符）" />
        <van-field v-model="formData.confirmPassword" type="password" label="确认密码" placeholder="请再次输入新密码" :error-message="confirmError" />
      </van-cell-group>
      <div class="submit-button"><van-button type="primary" block round size="large" :loading="loading" @click="handleSubmit">确认修改</van-button></div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { useRouter } from 'vue-router';
import { showToast, showFailToast } from 'vant';
import { changePassword } from '@/api/authService';
const router = useRouter();
const loading = ref(false);
const formData = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' });
const confirmError = computed(() => formData.confirmPassword && formData.confirmPassword !== formData.newPassword ? '两次输入的密码不一致' : '');
const goBack = () => router.back();
const handleSubmit = async () => {
  if (!formData.oldPassword) { showToast('请输入当前密码'); return; }
  if (!formData.newPassword || formData.newPassword.length < 6) { showToast('密码至少6个字符'); return; }
  if (!formData.confirmPassword) { showToast('请确认密码'); return; }
  if (formData.newPassword !== formData.confirmPassword) { showToast('两次密码不一致'); return; }
  const username = localStorage.getItem('auth_username') || '';
  loading.value = true;
  try {
    const res = await changePassword(username, formData.oldPassword, formData.newPassword);
    if (res.success) { showToast('密码修改成功'); ['auth_token', 'auth_username', 'auth_expire_at', 'auth_is_admin', 'auth_role', 'auth_userId'].forEach(k => localStorage.removeItem(k)); router.push('/m/login'); }
    else showFailToast(res.message || '修改失败');
  } catch (e: any) { showFailToast(e?.message || '修改失败'); }
  finally { loading.value = false; }
};
</script>
<style scoped lang="less">.change-password-page { min-height: 100vh; background: #f7f8fa; } .form-container { padding-top: 20px; } .submit-button { padding: 20px 16px; }
</style>
