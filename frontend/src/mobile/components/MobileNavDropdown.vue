<template>
  <van-dropdown-menu class="mobile-nav-dropdown" :overlay="true">
    <van-dropdown-item ref="dropdownItemRef" teleport="body">
      <template #title>
        <div class="dropdown-trigger-title" :class="{ 'is-compact': compact }">
          <van-icon name="wap-nav" class="trigger-icon" />
          <span v-if="!compact" class="trigger-text">导航</span>
        </div>
      </template>

      <div class="nav-dropdown-panel">
        <van-cell-group :border="false">
          <van-cell
            title="AI模型管理"
            icon="apps-o"
            clickable
            class="nav-cell-item"
            :class="{ 'nav-cell-active': isCurrentRoute('/m/') || isCurrentRoute('/m') }"
            @click="navigate('/m/')"
          >
            <template #right-icon>
              <van-tag v-if="isCurrentRoute('/m/') || isCurrentRoute('/m')" type="primary" size="small">当前</van-tag>
              <van-icon v-else name="arrow" class="cell-arrow" />
            </template>
          </van-cell>

          <van-cell
            title="模型记忆"
            icon="notes-o"
            clickable
            class="nav-cell-item"
            :class="{ 'nav-cell-active': isCurrentRoute('/m/memory') }"
            @click="navigate('/m/memory/user')"
          >
            <template #right-icon>
              <van-tag v-if="isCurrentRoute('/m/memory')" type="primary" size="small">当前</van-tag>
              <van-icon v-else name="arrow" class="cell-arrow" />
            </template>
          </van-cell>

          <van-cell
            title="文件管理"
            icon="description-o"
            clickable
            class="nav-cell-item"
            :class="{ 'nav-cell-active': isCurrentRoute('/m/files') }"
            @click="navigate('/m/files')"
          >
            <template #right-icon>
              <van-tag v-if="isCurrentRoute('/m/files')" type="primary" size="small">当前</van-tag>
              <van-icon v-else name="arrow" class="cell-arrow" />
            </template>
          </van-cell>

          <van-cell
            title="AI 聊天"
            icon="chat-o"
            clickable
            class="nav-cell-item"
            :class="{ 'nav-cell-active': isCurrentRoute('/m/chat') }"
            @click="navigate('/m/chat')"
          >
            <template #right-icon>
              <van-tag v-if="isCurrentRoute('/m/chat')" type="primary" size="small">当前</van-tag>
              <van-icon v-else name="arrow" class="cell-arrow" />
            </template>
          </van-cell>

          <van-cell
            v-if="showAddAction"
            title="添加模型"
            icon="plus"
            is-link
            clickable
            class="nav-cell-item"
            @click="handleAction('add')"
          />

          <van-cell
            title="代理接口"
            icon="cluster-o"
            is-link
            clickable
            class="nav-cell-item"
            @click="handleAction('api')"
          />

          <van-cell
            title="系统设置"
            icon="setting-o"
            is-link
            clickable
            class="nav-cell-item"
            @click="handleAction('settings')"
          />

          <van-cell
            v-if="isAdmin"
            title="用户管理"
            icon="friends-o"
            clickable
            class="nav-cell-item"
            :class="{ 'nav-cell-active': isCurrentRoute('/m/user-manage') }"
            @click="navigate('/m/user-manage')"
          >
            <template #right-icon>
              <van-tag v-if="isCurrentRoute('/m/user-manage')" type="primary" size="small">当前</van-tag>
              <van-icon v-else name="arrow" class="cell-arrow" />
            </template>
          </van-cell>

          <van-cell
            title="修改密码"
            icon="lock"
            clickable
            class="nav-cell-item"
            :class="{ 'nav-cell-active': isCurrentRoute('/m/change-password') }"
            @click="navigate('/m/change-password')"
          >
            <template #right-icon>
              <van-tag v-if="isCurrentRoute('/m/change-password')" type="primary" size="small">当前</van-tag>
              <van-icon v-else name="arrow" class="cell-arrow" />
            </template>
          </van-cell>

          <van-cell
            title="退出登录"
            icon="revoke"
            clickable
            class="nav-cell-item nav-logout-item"
            @click="handleAction('logout')"
          >
            <template #right-icon>
              <van-icon name="arrow" class="cell-arrow cell-arrow-danger" />
            </template>
          </van-cell>
        </van-cell-group>
      </div>
    </van-dropdown-item>
  </van-dropdown-menu>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { showConfirmDialog, showToast } from 'vant';

const props = withDefaults(
  defineProps<{
    showAddAction?: boolean;
    compact?: boolean;
  }>(),
  {
    showAddAction: false,
    compact: false,
  }
);

const emit = defineEmits<{
  (e: 'open-api'): void;
  (e: 'open-settings'): void;
  (e: 'open-add'): void;
}>();

const router = useRouter();
const route = useRoute();
const dropdownItemRef = ref<any>(null);

const isAdmin = computed(() => localStorage.getItem('auth_is_admin') === '1');

const closeDropdown = () => {
  dropdownItemRef.value?.toggle(false);
};

const isCurrentRoute = (path: string) => {
  if (path === '/m/' || path === '/m') {
    return route.path === '/m/' || route.path === '/m';
  }
  return route.path.startsWith(path);
};

const navigate = (path: string) => {
  closeDropdown();
  if (route.path !== path) {
    router.push(path);
  }
};

const handleAction = (action: string) => {
  closeDropdown();
  if (action === 'api') {
    if (route.path === '/m/' || route.path === '/m') {
      emit('open-api');
    } else {
      router.push('/m/?open=api');
    }
  } else if (action === 'settings') {
    if (route.path === '/m/' || route.path === '/m') {
      emit('open-settings');
    } else {
      router.push('/m/?open=settings');
    }
  } else if (action === 'add') {
    if (route.path === '/m/' || route.path === '/m') {
      emit('open-add');
    } else {
      router.push('/m/?open=add');
    }
  } else if (action === 'logout') {
    showConfirmDialog({
      title: '提示',
      message: '确定要退出登录吗？',
    })
      .then(() => {
        ['auth_token', 'auth_username', 'auth_expire_at', 'auth_is_admin', 'auth_role', 'auth_userId']
          .forEach((k: string) => localStorage.removeItem(k));
        showToast('已退出登录');
        router.push('/m/login');
      })
      .catch(() => {
        // cancelled
      });
  }
};
</script>

<style scoped lang="less">
.mobile-nav-dropdown {
  height: 30px;

  :deep(.van-dropdown-menu__bar) {
    height: 30px;
    background: #f2f3f5;
    border-radius: 6px;
    box-shadow: none;
    padding: 0 6px;
  }

  :deep(.van-dropdown-menu__item) {
    flex: 1;
  }

  :deep(.van-dropdown-menu__title) {
    font-size: 13px;
    font-weight: 500;
    color: #323233;
    padding: 0 10px 0 0;
    line-height: 30px;
    display: flex;
    align-items: center;

    &::after {
      right: 0;
      border-color: transparent transparent #646566 #646566;
    }
  }

  :deep(.van-dropdown-menu__title--active) {
    color: #1989fa;
    &::after {
      border-color: transparent transparent #1989fa #1989fa;
    }
  }
}

.dropdown-trigger-title {
  display: flex;
  align-items: center;
  gap: 4px;

  .trigger-icon {
    font-size: 14px;
    color: inherit;
  }

  .trigger-text {
    font-size: 12px;
    white-space: nowrap;
  }

  &.is-compact {
    .trigger-icon {
      font-size: 16px;
    }
  }
}

.nav-dropdown-panel {
  max-height: 70vh;
  overflow-y: auto;
  background: #fff;
  padding: 4px 0 8px;

  .nav-cell-item {
    font-size: 14px;
    padding: 12px 16px;
    align-items: center;

    :deep(.van-cell__title) {
      font-weight: 500;
      color: #323233;
    }

    :deep(.van-cell__left-icon) {
      font-size: 18px;
      margin-right: 10px;
      color: #1989fa;
    }

    .cell-arrow {
      font-size: 14px;
      color: #969799;
    }

    .cell-arrow-danger {
      color: #ee0a24;
    }
  }

  .nav-cell-active {
    background-color: #f0f7ff;
    :deep(.van-cell__title) {
      color: #1989fa;
      font-weight: 600;
    }
  }

  .nav-logout-item {
    margin-top: 4px;
    border-top: 1px solid #f2f3f5;

    :deep(.van-cell__title) {
      color: #ee0a24;
    }
    :deep(.van-cell__left-icon) {
      color: #ee0a24;
    }
  }
}
</style>
