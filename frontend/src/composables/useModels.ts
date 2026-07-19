import { ref, computed } from 'vue';
import { showToast, showFailToast, showConfirmDialog } from 'vant';
import { getModels, updateModel, deleteModel, batchCreateModels, copyModel, reorderModels, toggleModelLock, type Model, type ModelForm, type ModelRowForm } from '@/api/modelService';
import { getTokenStatsByModelIds, type TokenStat } from '@/api/tokenStatsService';
import { getUserSettings, updateUserSettings } from '@/api/userSettingsService';

export const modelLoading = ref(false);
export const modelList = ref<Model[]>([]);
export const selectedModelId = ref<number | null>(null);
export const checkedModelIds = ref<number[]>([]);
export const statsLoading = ref(false);
export const allStats = ref<TokenStat[]>([]);

// API 对话框相关
export const apiDialogVisible = ref(false);
export const customApiKey = ref('');
export const proxyEndpoints = ref<{ id: number; name: string; url: string; enabled: boolean }[]>([]);

export const selectModel = (id: number) => {
  selectedModelId.value = id;
};

export const openApiDialog = async () => {
  apiDialogVisible.value = true;
  await loadApiSettings();
};

export const loadApiSettings = async () => {
  const res = await getUserSettings();
  if (res.success && res.data) {
    customApiKey.value = res.data.api_key || '';
    proxyEndpoints.value = res.data.proxy_endpoints || [];
  }
};

export const saveApiSettings = async () => {
  const res = await updateUserSettings({ api_key: customApiKey.value, proxy_endpoints: proxyEndpoints.value });
  if (res.success) {
    showToast('保存成功');
    apiDialogVisible.value = false;
  } else {
    showFailToast(res.message || '保存失败');
  }
};

export const loadLockDuration = async () => {
  const res = await getUserSettings();
  if (res.success && res.data && res.data.lock_duration) {
    // 设置锁定持续时间
  }
};

export const checkAndRefreshLockStatus = async () => {
  const now = Date.now();
  const lockMs = await getLockDurationMs();
  const expiredModels = modelList.value.filter(
    m => m.isLock > 0 && now - m.isLock > lockMs
  );
  for (const m of expiredModels) {
    await updateModel(m.id, { isLock: 0 });
    m.isLock = 0;
  }
};

// 获取锁定持续时间（毫秒）
async function getLockDurationMs(): Promise<number> {
  try {
    const res = await getUserSettings();
    if (res.success && res.data?.lock_duration) {
      return res.data.lock_duration * 1000;
    }
  } catch { /* ignore */ }
  return 600 * 1000; // 默认 600 秒
}

// 初始化回调
export const onMountedCallback = async () => {
  await fetchModels();
};

const fmtDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const getDays = () => { const e = new Date(); const s = new Date(); s.setDate(e.getDate() - 6); return [fmtDate(s), fmtDate(e)]; };
export const dateRange = ref<string[]>(getDays());
export const selectedModelName = computed(() => { const m = modelList.value.find(i => i.id === selectedModelId.value); return m ? m.name : '-'; });
export const isAllChecked = computed(() => modelList.value.length > 0 && checkedModelIds.value.length === modelList.value.length);

export const handleCheckChange = (id: number, checked: boolean) => {
  if (checked) {
    if (!checkedModelIds.value.includes(id)) checkedModelIds.value.push(id);
  } else {
    checkedModelIds.value = checkedModelIds.value.filter(i => i !== id);
  }
};

export const handleToggleAll = () => {
  if (isAllChecked.value) checkedModelIds.value = [];
  else checkedModelIds.value = modelList.value.map(i => i.id);
};

export const handleBatchDelete = () => {
  if (checkedModelIds.value.length === 0) {
    showToast('请选择要删除的模型');
    return;
  }
  showConfirmDialog({ title: '批量删除', message: `确定要删除选中的 ${checkedModelIds.value.length} 个模型吗？` })
    .then(async () => {
      try {
        await Promise.all(checkedModelIds.value.map(id => deleteModel(id)));
        showToast('批量删除成功');
        checkedModelIds.value = [];
        fetchModels();
      } catch {
        showFailToast('批量删除失败');
      }
    })
    .catch(() => {});
};

export const selectedModelStats = computed(() => {
  if (!selectedModelId.value) return [];
  return allStats.value.filter(s => s.model_id === selectedModelId.value).sort((a, b) => a.stat_date.localeCompare(b.stat_date));
});

export interface ModelStatSummary {
  todayToken: number;
  totalToken: number;
  totalCallCount: number;
  todayCallCount: number;
}

export const modelStatMap = computed(() => {
  const map = new Map<number, ModelStatSummary>();
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const stat of allStats.value) {
    if (!map.has(stat.model_id)) map.set(stat.model_id, { todayToken: 0, totalToken: 0, totalCallCount: 0, todayCallCount: 0 });
    const e = map.get(stat.model_id)!;
    e.totalToken += stat.total_token;
    e.totalCallCount += stat.call_count;
    if (stat.stat_date === today) {
      e.todayToken += stat.total_token;
      e.todayCallCount += stat.call_count;
    }
  }
  return map;
});

export const loadStats = async () => {
  await fetchStats();
};

export const fetchModels = async () => {
  modelLoading.value = true;
  try {
    const res = await getModels();
    if (res.success) {
      modelList.value = res.data;
      const ids = new Set(res.data.map(i => i.id));
      checkedModelIds.value = checkedModelIds.value.filter(id => ids.has(id));
      if (!selectedModelId.value && res.data.length > 0) selectedModelId.value = res.data[0].id;
      await fetchStats();
    }
  } catch {
    // ignore error
  } finally {
    modelLoading.value = false;
  }
};

export const fetchStats = async () => {
  statsLoading.value = true;
  try {
    const ids = modelList.value.map(m => m.id);
    if (ids.length > 0) {
      const res = await getTokenStatsByModelIds(ids);
      if (res.success && res.data) {
        allStats.value = res.data;
      }
    }
  } catch {
    // ignore error
  } finally {
    statsLoading.value = false;
  }
};

export const handleCopy = async (item: Model) => {
  try {
    const res = await copyModel(item.id);
    if (res.success) {
      showToast('复制成功');
      fetchModels();
    } else {
      showFailToast(res.message || '复制失败');
    }
  } catch {
    showFailToast('复制失败');
  }
};

export const handleDelete = async (item: Model) => {
  try {
    await showConfirmDialog({ title: '删除模型', message: `确定要删除模型 "${item.name}" 吗？` });
    const res = await deleteModel(item.id);
    if (res.success) {
      showToast('删除成功');
      if (selectedModelId.value === item.id) selectedModelId.value = null;
      fetchModels();
    } else {
      showFailToast(res.message || '删除失败');
    }
  } catch {
    // user cancel
  }
};

export const handleToggleLock = async (item: Model) => {
  try {
    const isCurrentlyLocked = item.isLock > 0;
    const res = await toggleModelLock(item.id, !isCurrentlyLocked);
    if (res.success) {
      showToast(isCurrentlyLocked ? '已解锁' : '已锁定');
      fetchModels();
    } else {
      showFailToast(res.message || '操作失败');
    }
  } catch {
    showFailToast('操作失败');
  }
};

export const handleToggleDisable = async (item: Model) => {
  try {
    const res = await updateModel(item.id, { isDisable: !item.isDisable });
    if (res.success) {
      showToast(item.isDisable ? '已启用' : '已禁用');
      fetchModels();
    } else {
      showFailToast(res.message || '操作失败');
    }
  } catch {
    showFailToast('操作失败');
  }
};

export const handleEditSubmit = async (id: number, form: ModelForm) => {
  try {
    const res = await updateModel(id, form);
    if (res.success) {
      showToast('更新成功');
      fetchModels();
      return true;
    } else {
      showFailToast(res.message || '更新失败');
      return false;
    }
  } catch {
    showFailToast('更新失败');
    return false;
  }
};

export const handleAddSubmit = async (form: ModelRowForm) => {
  try {
    // 移动端：将单条 ModelRowForm 包装为 BatchAddPayload
    const payload = { url: '', api_key: '', api_format: 1, items: [form] };
    const res = await batchCreateModels(payload);
    if (res.success) {
      showToast('添加成功');
      fetchModels();
      return true;
    } else {
      showFailToast(res.message || '添加失败');
      return false;
    }
  } catch {
    showFailToast('添加失败');
    return false;
  }
};

export const handleReorder = async (fromIndex: number, toIndex: number) => {
  if (fromIndex === toIndex) return;
  const list = [...modelList.value];
  const [moved] = list.splice(fromIndex, 1);
  list.splice(toIndex, 0, moved);
  modelList.value = list;
  try {
    await reorderModels(list.map((m, idx) => ({ id: m.id, sort_index: idx })));
  } catch {
    fetchModels();
  }
};

export const generateApiKey = async (modelId: number) => {
  const res = await getUserSettings();
  if (res.success && res.data && res.data.base_url) {
    return `${res.data.base_url}/v1/models/${modelId}`;
  }
  return '';
};
