import request from './models';

export interface Model {
  id: number;
  name: string;
  model_name: string;
  url: string;
  max_content_length: number;
  max_token: number;
  api_key: string;
  sort_index: number;
  api_format: number;
  model_label_id: number | null;
  capabilities: string[];
  isLock: number; // Unix 毫秒时间戳，0=未锁定，>0=出错锁定时间
  isDisable: boolean;
  created_at: string;
}

export interface ModelForm {
  name: string;
  model_name: string;
  url: string;
  max_content_length?: number;
  max_token?: number;
  api_key: string;
  sort_index?: number;
  api_format?: number;
  model_label_id?: number | null;
  capabilities?: string[];
  isLock?: number;
  isDisable?: boolean;
}

// 弹窗中的模型行（不包含 url / api_key / api_format，这些由弹窗顶部统一下发）
export interface ModelRowForm {
  name: string;
  model_name: string;
  max_content_length: number;
  max_token: number;
  model_label_id?: number | null;
  capabilities?: string[];
}

export interface BatchAddPayload {
  url: string;
  api_key: string;
  api_format: number;
  items: ModelRowForm[];
}

// 获取所有模型
export const getModels = () => {
  return request.get<{ success: boolean; data: Model[] }>('/models');
};

// 获取单个模型
export const getModel = (id: number) => {
  return request.get<{ success: boolean; data: Model }>(`/models/${id}`);
};

// 创建模型
export const createModel = (data: ModelForm) => {
  return request.post<{ success: boolean; message: string; data: Model }>('/models', data);
};

// 批量创建模型
export const batchCreateModels = (data: BatchAddPayload) => {
  return request.post<{ success: boolean; message: string; data: { insertedIds: number[]; count: number } }>(
    '/models/batch',
    data
  );
};

// 更新模型（支持部分更新）
export const updateModel = (id: number, data: Partial<ModelForm>) => {
  return request.put<{ success: boolean; message: string }>(`/models/${id}`, data);
};

// 删除模型
export const deleteModel = (id: number) => {
  return request.delete<{ success: boolean; message: string }>(`/models/${id}`);
};
// 复制模型（仅复制基础信息）
export const copyModel = (id: number) => {
  return request.post<{ success: boolean; message: string; data: { id: number } }>(`/models/${id}/copy`);
};

// 批量更新模型索引（拖拽排序）
export const reorderModels = (items: Array<{ id: number; sort_index: number }>) => {
  return request.put<{ success: boolean; message: string }>('/models/reorder', { items });
};

// 锁定/解锁模型
export const toggleModelLock = (id: number, lock: boolean) => {
  return request.put<{ success: boolean; message: string }>(`/models/${id}/lock`, { isLock: lock ? Date.now() : 0 });
};
