// PR3 auth zustand store
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 4

import { create } from 'zustand';
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
  logoutAll: () => Promise<void>;
  deleteAccount: (phoneConfirm: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
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
    set({ user, loginModalOpen: false, pendingRetry: null });
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

  async logoutAll() {
    try {
      await authApi.logoutAll();
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
}));
