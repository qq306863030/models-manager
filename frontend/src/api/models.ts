import axios from 'axios';

const axiosInstance = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

// 请求拦截器：自动添加认证信息
axiosInstance.interceptors.request.use(
  (config: any) => {
    const token = localStorage.getItem('auth_token')
    const username = localStorage.getItem('auth_username')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    if (username) {
      config.headers['X-Username'] = username
    }
    return config;
  },
  (error: any) => {
    return Promise.reject(error);
  }
);

// 响应拦截器：剥离 Axios 包装，直接返回响应体 data
axiosInstance.interceptors.response.use(
  (response: any) => {
    return response.data;
  },
  (error: any) => {
    // 不在这里自动显示错误消息，由各组件自行处理
    return Promise.reject(error);
  }
);

/**
 * 类型安全的请求封装。
 *
 * 因为响应拦截器在运行时把 `response.data` 返回给调用方，
 * TypeScript 静态类型却仍然把返回值推断为 `AxiosResponse<T>`，
 * 所以这里用 `as unknown as Promise<T>` 将返回值断言为实际响应体类型。
 */
const request = {
  get: <T = any>(url: string, config?: any): Promise<T> =>
    axiosInstance.get(url, config) as unknown as Promise<T>,
  post: <T = any>(url: string, data?: any, config?: any): Promise<T> =>
    axiosInstance.post(url, data, config) as unknown as Promise<T>,
  put: <T = any>(url: string, data?: any, config?: any): Promise<T> =>
    axiosInstance.put(url, data, config) as unknown as Promise<T>,
  delete: <T = any>(url: string, config?: any): Promise<T> =>
    axiosInstance.delete(url, config) as unknown as Promise<T>,
};

export default request;