import { ref, computed } from 'vue';
import { getAllModels, type LlmModelItem } from '@/api/llmService';

// 全局单例缓存
const allModels = ref<LlmModelItem[]>([]);
const loading = ref(false);

export function useAllModels() {
  const loadAllModels = async () => {
    if (allModels.value.length > 0 || loading.value) return;
    loading.value = true;
    try {
      const res = await getAllModels();
      if (res.success && Array.isArray(res.data)) {
        allModels.value = res.data;
      }
    } catch (e) {
      console.error('加载 models.json 失败:', e);
    } finally {
      loading.value = false;
    }
  };

  // 模型名 -> 模型配置映射（支持精确和忽略大小写匹配）
  const modelDataMap = computed(() => {
    const map = new Map<string, LlmModelItem>();
    const lowerMap = new Map<string, LlmModelItem>();
    for (const m of allModels.value) {
      if (!map.has(m.model)) {
        map.set(m.model, m);
        lowerMap.set(m.model.toLowerCase(), m);
      }
    }
    return {
      get: (key: string) => map.get(key) || lowerMap.get(key.toLowerCase()),
      has: (key: string) => map.has(key) || lowerMap.has(key.toLowerCase()),
    };
  });

  // 所有模型下拉选项（来自 models.json）
  const allModelOptions = computed(() => {
    return allModels.value.map((m) => ({
      value: m.model,
      label: m.model,
    }));
  });

  return {
    allModels,
    loading,
    loadAllModels,
    modelDataMap,
    allModelOptions,
  };
}
