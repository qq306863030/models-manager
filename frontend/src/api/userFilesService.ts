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

export const downloadFile = async (id: number, fileName: string) => {
  const token = localStorage.getItem('auth_token');
  const username = localStorage.getItem('auth_username');
  const response = await fetch(`/api/user-files/${id}/download`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(username ? { 'X-Username': username } : {}),
    },
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({ message: '下载失败' }));
    throw new Error(err.message || '下载失败');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export const deleteFile = (id: number) =>
  request.delete<{ success: boolean; message: string }>(`/user-files/${id}`);
