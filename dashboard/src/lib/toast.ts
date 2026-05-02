// Lightweight toast queue (zustand). Mount <Toast /> once at root.
// Auto-dismiss after `duration` ms (default 3000).

import { create } from 'zustand';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
}

interface ToastStore {
  items: ToastItem[];
  push: (type: ToastType, message: string, duration?: number) => void;
  dismiss: (id: number) => void;
}

let counter = 0;

export const useToastStore = create<ToastStore>((set) => ({
  items: [],
  push(type, message, duration = 3000) {
    counter += 1;
    const id = counter;
    set((s) => ({ items: [...s.items, { id, type, message, duration }] }));
    if (duration > 0) {
      setTimeout(() => {
        set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
      }, duration);
    }
  },
  dismiss(id) {
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
}));

export const toast = {
  success: (msg: string, duration?: number) => useToastStore.getState().push('success', msg, duration),
  error: (msg: string, duration?: number) => useToastStore.getState().push('error', msg, duration),
  info: (msg: string, duration?: number) => useToastStore.getState().push('info', msg, duration),
};
