import request from './models';

export interface UserSettings {
  max_content_length: number;
  max_token: number;
}

// 获取设置
export const getUserSettings = () => {
  return request.get<{ success: boolean; data: UserSettings }>('/settings');
};

// 更新设置
export const updateUserSettings = (data: Partial<UserSettings>) => {
  return request.put<{ success: boolean; message: string }>('/settings', data);
};
