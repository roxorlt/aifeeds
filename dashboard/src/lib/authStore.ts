// PR3 auth zustand store
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 4
//
// persist: 把 user 缓存到 localStorage（不含 token，token 在 httpOnly cookie 里）。
// 主要为了：(1) HMR 不掉登录态；(2) 二次进入页面能立即渲染头像，
// 不闪空白等到 /api/auth/me 回来。下次 hydrate 仍会用 cookie 验真值并覆盖。

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as authApi from './auth';
import type { User } from './auth';

export type LoginTrigger =
  | 'manual'
  | 'favorite'
  | 'subscribe'
  | 'api_401'
  | string;

interface AuthStore {
  // ─── state ───
  user: User | null;
  hydrated: boolean;
  loginModalOpen: boolean;
  loginTrigger: LoginTrigger;
  pendingRetry: (() => Promise<void> | void) | null;

  // ─── actions ───
  hydrate: () => Promise<void>;
  openLoginModal: (trigger?: LoginTrigger, retry?: () => Promise<void> | void) => void;
  closeLoginModal: () => void;
  onLoginSuccess: (user: User) => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: (phoneConfirm: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>()(
  persist(
    (set, get) => ({
  user: null,
  hydrated: false,
  loginModalOpen: false,
  loginTrigger: 'manual',
  pendingRetry: null,

  async hydrate() {
    try {
      const { user } = await authApi.fetchMe();
      set({ user, hydrated: true });
    } catch {
      // cookie 失效 / 网络挂了：清掉持久化的 user 防止假登录态
      set({ user: null, hydrated: true });
    }
  },

  openLoginModal(trigger = 'manual', retry) {
    set({
      loginModalOpen: true,
      loginTrigger: trigger,
      pendingRetry: retry ?? null,
    });
  },

  closeLoginModal() {
    set({ loginModalOpen: false, pendingRetry: null });
  },

  async onLoginSuccess(user) {
    const { pendingRetry } = get();
    // login 响应不带 phone_masked（只有 /api/auth/me 返回），同步 await 一次
    // 让初始 user 就是完整数据，避免 settings/账号管理首次进入看到 fallback 闪烁。
    let full = user;
    try {
      const me = await authApi.fetchMe();
      full = me.user;
    } catch {
      // /api/auth/me 临时挂了：降级用 login 响应（少 phone_masked，下次 hydrate 补）
    }
    set({ user: full, loginModalOpen: false, pendingRetry: null });
    if (pendingRetry) {
      try {
        await pendingRetry();
      } catch (e) {
        console.error('[auth] pendingRetry failed', e);
      }
    }
  },

  async logout() {
    try {
      await authApi.logout();
    } catch {}
    set({ user: null });
  },

  async deleteAccount(phoneConfirm) {
    await authApi.deleteAccount(phoneConfirm);
    set({ user: null });
  },

  async refreshUser() {
    try {
      const { user } = await authApi.fetchMe();
      set({ user });
    } catch {
      set({ user: null });
    }
  },
    }),
    {
      name: 'ai-feeds-auth',
      storage: createJSONStorage(() => localStorage),
      // 仅持久化 user；hydrated/modal 状态每次启动重来
      partialize: (s) => ({ user: s.user }),
    },
  ),
);
