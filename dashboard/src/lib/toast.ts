// Lightweight toast queue (zustand). Mount <Toast /> once at root.
// Auto-dismiss after `duration` ms (default 3000).

import { create } from 'zustand';
import { MOTION_DURATION } from './motion.ts';

export type ToastType = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  duration: number;
  leaving: boolean;
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
    set((s) => ({ items: [...s.items, { id, type, message, duration, leaving: false }] }));
    if (duration > 0) {
      setTimeout(() => {
        useToastStore.getState().dismiss(id);
      }, duration);
    }
  },
  dismiss(id) {
    set((s) => ({
      items: s.items.map((item) => item.id === id ? { ...item, leaving: true } : item),
    }));
    setTimeout(() => {
      set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    }, MOTION_DURATION.toastExit);
  },
}));

export const toast = {
  success: (msg: string, duration?: number) => useToastStore.getState().push('success', msg, duration),
  error: (msg: string, duration?: number) => useToastStore.getState().push('error', msg, duration),
  info: (msg: string, duration?: number) => useToastStore.getState().push('info', msg, duration),
};
