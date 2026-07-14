import request from './models';

export interface UserSettings {
  max_content_length: number;
  max_token: number;
  lock_duration: number;
  /** 用户自定义 API Key（可选，部分场景使用） */
  api_key?: string;
  /** 代理端点列表（可选，部分场景使用） */
  proxy_endpoints?: { id: number; name: string; url: string; enabled: boolean }[];
  /** 基础 URL（可选，部分场景使用） */
  base_url?: string;
}

// 获取设置
export const getUserSettings = () => {
  return request.get<{ success: boolean; data: UserSettings }>('/settings');
};

// 更新设置
export const updateUserSettings = (data: Partial<UserSettings>) => {
  return request.put<{ success: boolean; message: string }>('/settings', data);
};
