<template>
  <div class="model-card" :class="{ 'is-selected': isSelected }" @click="handleSelect">
    <div class="card-left">
      <van-icon name="setting-o" class="menu-icon" @click.stop="showActionSheet = true" />
    </div>
    <div class="card-body">
      <div class="card-header">
        <div class="card-title">
          <span class="name" :class="{ 'name-selected': isSelected }">{{ model.name }}</span>
          <van-tag v-if="isSelected" type="primary" size="small">当前使用</van-tag>
          <van-tag :type="model.isDisable ? 'default' : 'success'" size="small">{{ model.isDisable ? '已禁用' : '正常' }}</van-tag>
          <van-tag v-if="model.isLock > 0" type="warning" size="small">已锁定</van-tag>
        </div>
      </div>
      <div class="card-info">
        <div class="info-row"><span class="label">模型</span><span class="value">{{ model.model_name }}</span></div>
        <div class="info-row"><span class="label">URL</span><span class="value url">{{ truncateUrl(model.url) }}</span></div>
      </div>
      <div class="card-stats">
        <div class="stat-item"><span class="stat-value">{{ formatNumber(statSummary.todayToken) }}</span><span class="stat-label">今日消耗</span></div>
        <div class="stat-item"><span class="stat-value">{{ formatNumber(statSummary.todayCallCount) }}</span><span class="stat-label">调用次数</span></div>
      </div>
    </div>
    <div class="card-right">
      <div class="sort-btn" @click.stop="emit('move-up')">
        <van-icon name="arrow-up" />
      </div>
      <div class="sort-btn" @click.stop="emit('move-down')">
        <van-icon name="arrow-down" />
      </div>
    </div>
  </div>

  <van-action-sheet
    v-model:show="showActionSheet"
    :actions="actions"
    cancel-text="取消"
    @select="onActionSelect"
  />

  <van-popup v-model:show="editPopupVisible" position="bottom" round style="height:80%">
    <div class="edit-popup">
      <van-nav-bar title="编辑模型" left-text="取消" right-text="保存" @click-left="editPopupVisible = false" @click-right="handleSubmitEdit" />
      <van-cell-group inset>
        <van-field v-model="editForm.name" label="显示名称" />
        <van-field v-model="editForm.model_name" label="模型名称" />
        <van-field v-model="editForm.url" label="URL" />
        <van-field v-model="editForm.api_key" type="password" label="API Key" />
        <van-field v-model.number="editForm.max_content_length" type="number" label="Max_Content" />
        <van-field v-model.number="editForm.max_token" type="number" label="Max_Token" />
      </van-cell-group>
    </div>
  </van-popup>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue';
import { showToast } from 'vant';
import type { Model, ModelForm } from '@/api/modelService';

interface Props {
  model: Model;
  isSelected?: boolean;
  statSummary?: { todayToken: number; totalToken: number; totalCallCount: number; todayCallCount: number };
}

interface Emits {
  (e: 'select', id: number): void;
  (e: 'copy', model: Model): void;
  (e: 'delete', model: Model): void;
  (e: 'toggle-lock', model: Model): void;
  (e: 'toggle-disable', model: Model): void;
  (e: 'submit-edit', id: number, data: ModelForm): void;
  (e: 'move-up'): void;
  (e: 'move-down'): void;
}

const props = withDefaults(defineProps<Props>(), {
  isSelected: false,
  statSummary: () => ({ todayToken: 0, totalToken: 0, totalCallCount: 0, todayCallCount: 0 })
});

const emit = defineEmits<Emits>();

const showActionSheet = ref(false);
const editPopupVisible = ref(false);
const editForm = reactive({
  name: '',
  model_name: '',
  url: '',
  api_key: '',
  max_content_length: 4096,
  max_token: 2048
});

const actions = computed(() => [
  { name: '复制', action: 'copy' },
  { name: '编辑', action: 'edit' },
  { name: props.model.isLock > 0 ? '解锁' : '锁定', action: 'lock' },
  { name: props.model.isDisable ? '启用' : '禁用', action: 'disable' },
  { name: '删除', action: 'delete', color: '#ee0a24' }
]);

const onActionSelect = (action: any) => {
  showActionSheet.value = false;
  if (action.action === 'copy') emit('copy', props.model);
  else if (action.action === 'edit') handleEdit();
  else if (action.action === 'lock') emit('toggle-lock', props.model);
  else if (action.action === 'disable') emit('toggle-disable', props.model);
  else if (action.action === 'delete') emit('delete', props.model);
};

const handleEdit = () => {
  editForm.name = props.model.name;
  editForm.model_name = props.model.model_name;
  editForm.url = props.model.url;
  editForm.api_key = props.model.api_key;
  editForm.max_content_length = props.model.max_content_length;
  editForm.max_token = props.model.max_token;
  editPopupVisible.value = true;
};

const handleSubmitEdit = () => {
  if (!editForm.name?.trim()) {
    showToast('请填写完整');
    return;
  }
  const data: ModelForm = {
    name: editForm.name.trim(),
    model_name: editForm.model_name.trim(),
    url: editForm.url.trim(),
    api_key: editForm.api_key.trim(),
    max_content_length: editForm.max_content_length,
    max_token: editForm.max_token,
    sort_index: props.model.sort_index,
    api_format: props.model.api_format,
    model_label_id: props.model.model_label_id,
    capabilities: props.model.capabilities,
    isLock: props.model.isLock,
    isDisable: props.model.isDisable
  };
  emit('submit-edit', props.model.id, data);
  editPopupVisible.value = false;
};

const handleSelect = () => emit('select', props.model.id);

const formatNumber = (num: number): string =>
  num ? num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '0';

const truncateUrl = (url: string): string =>
  url.length > 35 ? url.substring(0, 35) + '...' : url;
</script>

<style scoped lang="less">
.model-card {
  position: relative;
  display: flex;
  margin: 8px 12px;
  padding: 12px;
  background: #fff;
  border-radius: 8px;
  border: 2px solid transparent;
  transition: all 0.3s;

  &.is-selected {
    border-color: #1989fa;
    background: #f0f7ff;
  }
}

.card-left {
  display: flex;
  align-items: flex-start;
  padding-right: 8px;
}

.menu-icon {
  font-size: 18px;
  color: #969799;
  cursor: pointer;
  padding: 4px;
}

.card-body {
  flex: 1;
  min-width: 0;
}

.card-header {
  margin-bottom: 8px;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;

  .name {
    font-size: 14px;
    font-weight: 600;

    &.name-selected {
      color: #1989fa;
    }
  }
}

.card-info {
  margin-bottom: 8px;

  .info-row {
    display: flex;
    margin-bottom: 2px;

    .label {
      width: 40px;
      color: #969799;
      font-size: 12px;
    }

    .value {
      color: #323233;
      font-size: 12px;
    }

    .url {
      color: #1989fa;
    }
  }
}

.card-stats {
  display: flex;
  gap: 20px;
  padding-top: 8px;
  border-top: 1px solid #ebedf0;

  .stat-item {
    display: flex;
    flex-direction: column;

    .stat-value {
      font-size: 14px;
      font-weight: 600;
    }

    .stat-label {
      font-size: 11px;
      color: #969799;
    }
  }
}

.card-right {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
}

.sort-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: #f7f8fa;
  border: 1px solid #ebedf0;
  border-radius: 50%;
  color: #646566;
  cursor: pointer;
  transition: all 0.2s;

  .van-icon {
    font-size: 14px;
  }

  &:active {
    background: #1989fa;
    border-color: #1989fa;
    color: #fff;
  }
}

.edit-popup {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #f7f8fa;
}
</style>
