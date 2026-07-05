<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { isMobileDevice } from '@/mobile/utils/device';

onMounted(() => {
  // 确保用户在 PC 端环境中
  // 如果用户通过移动设备访问 PC 页面，重定向到移动端
  if (isMobileDevice()) {
    const path = window.location.pathname;
    // 避免重复重定向
    if (!path.startsWith('/m/')) {
      window.location.href = '/m' + (path === '/' ? '/' : path);
    }
  }
});
</script>

<style scoped lang="less">
</style>
