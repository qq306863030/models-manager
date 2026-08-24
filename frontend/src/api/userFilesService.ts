import request from './models';

export interface UserFileItem {
  id: number;
  original_name: string;
  stored_name: string;
  mime_type: string | null;
  file_size: number;
  created_at: string;
}

export const getUserFiles = () =>
  request.get<{ success: boolean; data: UserFileItem[] }>('/user-files');

export const uploadFile = (file: File) => {
  const formData = new FormData();
  formData.append('file', file);
  return request.post<{ success: boolean; message: string; data?: { id: number; original_name: string; mime_type: string | null; file_size: number } }>('/user-files/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 300000, // 5 分钟超时，大文件上传需要时间
  });
};

export const downloadFile = (id: number, _fileName?: string) => {
  const username = localStorage.getItem('auth_username') || '';
  const token = localStorage.getItem('auth_token') || '';
  
  // 拼接带有鉴权信息的直链，使用浏览器原生下载能力
  const params = new URLSearchParams();
  if (username) params.append('username', username);
  if (token) params.append('token', token);
  
  const queryStr = params.toString() ? `?${params.toString()}` : '';
  const downloadUrl = `/api/user-files/${id}/download${queryStr}`;
  
  const a = document.createElement('a');
  a.href = downloadUrl;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

export const deleteFile = (id: number) =>
  request.delete<{ success: boolean; message: string }>(`/user-files/${id}`);
