/**
 * 路由配置
 */

import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

// 路由配置
const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/LoginPage.vue'),
    meta: { requiresAuth: false }
  },
  {
    path: '/change-password',
    name: 'ChangePassword',
    component: () => import('@/views/ChangePassword.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/user-manage',
    name: 'UserManage',
    component: () => import('@/views/UserManage.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/',
    name: 'Home',
    component: () => import('@/views/HomePage.vue'),
    meta: { requiresAuth: true }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/'
  }
]

// 创建路由实例
const router = createRouter({
  history: createWebHistory(),
  routes
})

// 路由守卫
router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('auth_token')
  const expireAt = localStorage.getItem('auth_expire_at')
  const isLoggedIn = token && expireAt && Date.now() < parseInt(expireAt)

  // 检查是否需要登录
  if (to.meta.requiresAuth && !isLoggedIn) {
    // 未登录，跳转到登录页
    next({ name: 'Login' })
  } else if (to.name === 'Login' && isLoggedIn) {
    // 已登录，跳转到首页
    next({ name: 'Home' })
  } else {
    next()
  }
})

export default router
