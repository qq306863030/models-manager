<template>
  <router-view />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { isMobileDevice } from './utils/device';

onMounted(() => {
  if (!isMobileDevice()) {
    const path = window.location.pathname.replace(/^\/m/, '') || '/';
    window.location.href = path;
  }
});
</script>
