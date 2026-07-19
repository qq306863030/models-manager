import { createRouter, createWebHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  { path: '/m/login', name: 'MobileLogin', component: () => import('../views/LoginPage.vue'), meta: { requiresAuth: false } },
  { path: '/m/change-password', name: 'MobileChangePassword', component: () => import('../views/ChangePassword.vue'), meta: { requiresAuth: true } },
  { path: '/m/user-manage', name: 'MobileUserManage', component: () => import('../views/UserManage.vue'), meta: { requiresAuth: true } },
  { path: '/m/memory/:type', name: 'MobileMemory', component: () => import('../views/MemoryPage.vue'), meta: { requiresAuth: true } },
  { path: '/m/', name: 'MobileHome', component: () => import('../views/HomePage.vue'), meta: { requiresAuth: true } },
  { path: '/m/:pathMatch(.*)*', redirect: '/m/' }
];

const router = createRouter({ history: createWebHistory(), routes });

router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('auth_token');
  const expireAt = localStorage.getItem('auth_expire_at');
  const isLoggedIn = token && expireAt && Date.now() < parseInt(expireAt);
  if (to.meta.requiresAuth && !isLoggedIn) next({ name: 'MobileLogin' });
  else if (to.name === 'MobileLogin' && isLoggedIn) next({ name: 'MobileHome' });
  else next();
});

export default router;
