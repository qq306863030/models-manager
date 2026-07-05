<template>
  <div class="user-manage-page">
    <van-nav-bar title="用户管理" left-text="返回" left-arrow @click-left="goBack" />
    <div class="content">
      <div class="action-bar">
        <van-button type="primary" size="small" @click="openAddDialog">添加用户</van-button>
      </div>
      <van-pull-refresh v-model="refreshing" @refresh="loadUsers">
        <van-cell-group inset>
          <van-cell
            v-for="user in userList"
            :key="user.id"
            :label="formatDate(user.created_at)"
            :value="user.id === currentUserId ? '' : undefined"
          >
            <template #title>
              <div class="user-info">
                <span class="username">{{ user.name }}</span>
                <van-tag :type="roleTagType(user.role)" size="small">{{ roleLabel(user.role) }}</van-tag>
              </div>
            </template>
            <template #right-icon v-if="user.id !== currentUserId">
              <div class="user-actions">
                <van-icon name="edit" @click="openEditDialog(user)" />
                <van-icon name="delete-o" @click="handleDelete(user)" />
              </div>
            </template>
          </van-cell>
        </van-cell-group>
        <van-empty v-if="userList.length === 0 && !loading" description="暂无用户" />
      </van-pull-refresh>
    </div>

    <!-- 添加用户弹窗 -->
    <van-popup v-model:show="addDialogVisible" position="bottom" round style="height: 400px">
      <div class="popup-container">
        <van-nav-bar
          title="添加用户"
          left-text="取消"
          right-text="确定"
          @click-left="addDialogVisible = false"
          @click-right="handleAdd"
        />
        <van-cell-group inset>
          <van-field v-model="addFormData.username" label="用户名" placeholder="请输入用户名" />
          <van-field v-model="addFormData.password" type="password" label="密码" placeholder="请输入密码" />
          <van-field
            v-model="addRoleText"
            is-link
            readonly
            label="角色"
            @click="openRolePicker('add')"
          />
        </van-cell-group>
      </div>
    </van-popup>

    <!-- 编辑用户弹窗 -->
    <van-popup v-model:show="editDialogVisible" position="bottom" round style="height: 400px">
      <div class="popup-container">
        <van-nav-bar
          title="编辑用户"
          left-text="取消"
          right-text="保存"
          @click-left="editDialogVisible = false"
          @click-right="handleEdit"
        />
        <van-cell-group inset>
          <van-field v-model="editFormData.username" label="用户名" placeholder="请输入用户名" />
          <van-field v-model="editFormData.password" type="password" label="新密码" placeholder="留空不修改" />
          <van-field
            v-model="editRoleText"
            is-link
            readonly
            label="角色"
            @click="openRolePicker('edit')"
          />
        </van-cell-group>
      </div>
    </van-popup>

    <!-- 角色选择器 -->
    <van-popup v-model:show="showRolePicker" position="bottom">
      <van-picker
        :columns="roleColumns"
        :default-index="currentRoleIndex"
        @confirm="onRoleConfirm"
        @cancel="showRolePicker = false"
      />
    </van-popup>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { showToast, showFailToast, showConfirmDialog } from 'vant';
import { getUserList, deleteUser, createUser, updateUser } from '@/api/authService';
import type { UserItem } from '@/api/authService';

const router = useRouter();

const loading = ref(false);
const refreshing = ref(false);
const userList = ref<UserItem[]>([]);
const currentUserId = ref<number>(0);

// 添加表单
const addDialogVisible = ref(false);
const addFormData = reactive({ username: '', password: '', role: 'user' });

// 编辑表单
const editDialogVisible = ref(false);
const editingUser = ref<UserItem | null>(null);
const editFormData = reactive({ username: '', password: '', role: 'user' });

// 角色选择器
const showRolePicker = ref(false);
const pickerTarget = ref<'add' | 'edit'>('add');
const roleColumns = [
  { text: '普通用户', value: 'user' },
  { text: '管理员', value: 'admin' }
];

const roleLabel = (role: string) => {
  const map: Record<string, string> = {
    super_admin: '超级管理员',
    admin: '管理员',
    user: '普通用户'
  };
  return map[role] || role;
};

const roleTagType = (role: string) => {
  const map: Record<string, string> = {
    super_admin: 'danger',
    admin: 'warning',
    user: 'info'
  };
  return map[role] || 'info';
};

const formatDate = (dateStr: string) => {
  if (!dateStr) return '-';
  return new Date(dateStr).toLocaleString('zh-CN');
};

const addRoleText = computed(() => {
  return addFormData.role === 'admin' ? '管理员' : '普通用户';
});

const editRoleText = computed(() => {
  return editFormData.role === 'admin' ? '管理员' : '普通用户';
});

const currentRoleIndex = computed(() => {
  const target = pickerTarget.value === 'add' ? addFormData.role : editFormData.role;
  return target === 'admin' ? 1 : 0;
});

const goBack = () => router.back();

const loadUsers = async () => {
  loading.value = true;
  try {
    const res = await getUserList();
    if (res.success && res.data) {
      userList.value = res.data;
    }
  } catch {
    showFailToast('加载失败');
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
};

const openAddDialog = () => {
  addFormData.username = '';
  addFormData.password = '';
  addFormData.role = 'user';
  addDialogVisible.value = true;
};

const handleAdd = async () => {
  if (!addFormData.username.trim()) {
    showToast('请输入用户名');
    return;
  }
  if (addFormData.password.length < 6) {
    showToast('密码长度至少6位');
    return;
  }

  try {
    const res = await createUser(addFormData.username.trim(), addFormData.password, addFormData.role);
    if (res.success) {
      showToast('添加成功');
      addDialogVisible.value = false;
      loadUsers();
    } else {
      showFailToast(res.message || '添加失败');
    }
  } catch {
    showFailToast('添加失败');
  }
};

const openEditDialog = (user: UserItem) => {
  editingUser.value = user;
  editFormData.username = user.name;
  editFormData.password = '';
  // super_admin 不能改成其他角色，保持原样
  editFormData.role = user.role === 'super_admin' ? 'admin' : user.role;
  editDialogVisible.value = true;
};

const handleEdit = async () => {
  if (!editingUser.value || !editFormData.username.trim()) {
    showToast('请填写用户名');
    return;
  }

  const data: any = { name: editFormData.username };
  // 如果是超级管理员，保持原角色不变
  if (editingUser.value.role !== 'super_admin') {
    data.role = editFormData.role;
  }
  if (editFormData.password) {
    data.password = editFormData.password;
  }

  try {
    const res = await updateUser(editingUser.value.id, data);
    if (res.success) {
      showToast('更新成功');
      editDialogVisible.value = false;
      loadUsers();
    } else {
      showFailToast(res.message || '更新失败');
    }
  } catch {
    showFailToast('更新失败');
  }
};

const handleDelete = async (user: UserItem) => {
  try {
    await showConfirmDialog({
      title: '提示',
      message: `确定要删除用户 "${user.name}" 吗？`
    });
    const res = await deleteUser(user.id);
    if (res.success) {
      showToast('删除成功');
      loadUsers();
    } else {
      showFailToast(res.message || '删除失败');
    }
  } catch {
    // 用户取消
  }
};

const openRolePicker = (target: 'add' | 'edit') => {
  pickerTarget.value = target;
  showRolePicker.value = true;
};

const onRoleConfirm = ({ selectedOptions }: any) => {
  const role = selectedOptions[0].value;
  if (pickerTarget.value === 'add') {
    addFormData.role = role;
  } else {
    editFormData.role = role;
  }
  showRolePicker.value = false;
};

onMounted(() => {
  loadUsers();
  const userId = localStorage.getItem('auth_userId');
  if (userId) {
    currentUserId.value = parseInt(userId);
  }
});
</script>

<style scoped lang="less">
.user-manage-page {
  min-height: 100vh;
  background: #f7f8fa;
  padding-top: 46px;
}

.content {
  padding-top: 12px;
}

.action-bar {
  padding: 0 12px 12px;
}

.user-info {
  display: flex;
  align-items: center;
  gap: 8px;

  .username {
    font-weight: 500;
  }
}

.user-actions {
  display: flex;
  gap: 16px;

  .van-icon:first-child {
    color: #1989fa;
  }

  .van-icon:last-child {
    color: #ee0a24;
  }
}

.popup-container {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
}
</style>
