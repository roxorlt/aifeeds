// PR3/PR4 auth guard 高阶函数
// PR3：仅留好接口 + 401 用例（在 api.ts 拦截器调用）
// PR4：收藏/订阅按钮挂 requireAuth(action) 实现「触发登录」UX

import { useAuthStore, type LoginTrigger } from './authStore';

/**
 * 检查登录态，未登录则弹 LoginModal 并把 action 保存为 pendingRetry。
 * 已登录直接执行 action。登录成功后 store.onLoginSuccess 自动重试。
 *
 * 用法：
 *   await requireAuth('favorite', () => addFavorite(itemId));
 */
export async function requireAuth(
  trigger: LoginTrigger,
  action: () => Promise<void> | void,
): Promise<void> {
  const store = useAuthStore.getState();
  if (store.user) {
    await action();
    return;
  }
  store.openLoginModal(trigger, action);
}
