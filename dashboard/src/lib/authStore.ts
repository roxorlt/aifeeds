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
import { toast } from './toast';

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
    } catch (e) {
      // PM 2026-05-25:之前 401 立即清 user,但每次发版后偶发 CF Pages alias
      // 切换 / Worker 冷启动 / 边缘节点路由切换会让一次 me 返回 401(cookie
      // 仍 valid),老逻辑直接把 user 假踢出 → "每次发版要重新登录"。
      // 改成所有 hydrate 错误都保留 persisted user(乐观信任 localStorage),
      // 等用户实际触发需鉴权 action 时再让 authFetch 自然 401 → openLoginModal
      // ('api_401', retry) 弹 login modal。这样:
      //   - cookie 真失效:user action 仍会真 401 → 正常弹登录 → 不漏检
      //   - cookie 仍 valid 但 me 瞬时 401:UI 维持登录态 → 不假踢
      void e;
      set({ hydrated: true });
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
      if (!me.user) throw new Error('[auth] post-login session discovery returned anonymous');
      full = me.user;
    } catch (e) {
      // /api/auth/me 临时挂了：降级用 login 响应（少 phone_masked，下次 hydrate 补）。
      // 但不再静默 —— 2026-07-05 事故:base 镜像分叉时登录后 fetchMe 持续失败,
      // 用户只见反复弹登录却毫无提示。给一条 toast + error log 让异常可见可诊断。
      toast.error('登录状态同步异常，如遇反复弹登录请刷新页面');
      console.error('[auth] post-login fetchMe failed', e);
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
    } catch {
      // 服务端登出失败时仍清理本地会话，避免用户停留在已退出状态。
    }
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
    } catch (e) {
      // 同 hydrate:401 也 keep 旧 user,让真正鉴权 action 自然报 401 触发 login
      // (避免发版瞬时 401 假踢出)
      void e;
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
