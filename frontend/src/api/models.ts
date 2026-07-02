import axios from 'axios';

const request = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

// 请求拦截器：自动添加认证信息
request.interceptors.request.use(
  (config) => {
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
  (error) => {
    return Promise.reject(error);
  }
);

// 响应拦截器
request.interceptors.response.use(
  (response) => {
    return response.data;
  },
  (error) => {
    // 不在这里自动显示错误消息，由各组件自行处理
    return Promise.reject(error);
  }
);

export default request;