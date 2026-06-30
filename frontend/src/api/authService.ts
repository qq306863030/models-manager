/**
 * 认证 API 服务
 */

import request from './models';

export interface LoginData {
  username: string;
  password: string;
  captcha: string;
}

export interface RegisterData {
  username: string;
  password: string;
}

export interface AuthResult {
  userId: number;
  username: string;
  token: string;
  tokenExpireAt: number;
  isAdmin: boolean;
}

export interface UserItem {
  id: number;
  name: string;
  is_admin: number;
  created_at: string;
}

// 获取验证码图片
export function getCaptcha(): string {
  return '/api/auth/captcha';
}

// 登录
export function login(data: LoginData): Promise<{ success: boolean; message: string; data?: AuthResult }> {
  return request.post('/auth/login', data);
}

// 注册
export function register(data: RegisterData): Promise<{ success: boolean; message: string; data?: AuthResult }> {
  return request.post('/auth/register', data);
}

// 验证 token
export function verifyToken(): Promise<{ success: boolean; message: string }> {
  return request.get('/auth/verify');
}

// 获取当前用户信息
export function getCurrentUser(): Promise<{ success: boolean; message: string }> {
  return request.get('/auth/me');
}

// 修改密码
export function changePassword(username: string, oldPassword: string, newPassword: string): Promise<{ success: boolean; message: string }> {
  return request.post('/auth/change-password', { username, oldPassword, newPassword });
}

// 获取用户列表
export function getUserList(): Promise<{ success: boolean; data?: UserItem[]; message?: string }> {
  return request.get('/auth/users');
}

// 删除用户
export function deleteUser(id: number): Promise<{ success: boolean; message: string }> {
  return request.delete(`/auth/users/${id}`);
}

// 创建用户（仅管理员）
export function createUser(username: string, password: string): Promise<{ success: boolean; message: string }> {
  return request.post('/auth/register', { username, password });
}
