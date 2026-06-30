import request from './models';

export interface TokenStat {
  id: number;
  model_id: number;
  stat_date: string;
  in_token: number;
  out_token: number;
  total_token: number;
  call_count: number;
  created_at: string;
}

export interface TokenStatForm {
  model_id: number;
  stat_date: string;
  in_token?: number;
  out_token?: number;
}

// 获取所有统计
export const getTokenStats = (params?: { model_id?: number; start_date?: string; end_date?: string }) => {
  return request.get<{ success: boolean; data: TokenStat[] }>('/token-stats', { params });
};

// 获取多个模型的统计（逗号分隔 ids）
export const getTokenStatsByModelIds = (modelIds: number[], startDate?: string, endDate?: string) => {
  const params: any = {};
  if (modelIds.length > 0) {
    params.model_ids = modelIds.join(',');
  }
  if (startDate) params.start_date = startDate;
  if (endDate) params.end_date = endDate;
  return request.get<{ success: boolean; data: TokenStat[] }>('/token-stats', { params });
};

// 获取单个统计
export const getTokenStat = (id: number) => {
  return request.get<{ success: boolean; data: TokenStat }>(`/token-stats/${id}`);
};

// 创建/累加统计
export const createOrUpdateTokenStat = (data: TokenStatForm) => {
  return request.post<{ success: boolean; message: string; data: TokenStat }>('/token-stats', data);
};

// 更新统计
export const updateTokenStat = (id: number, data: TokenStatForm) => {
  return request.put<{ success: boolean; message: string }>(`/token-stats/${id}`, data);
};

// 删除统计
export const deleteTokenStat = (id: number) => {
  return request.delete<{ success: boolean; message: string }>(`/token-stats/${id}`);
};
