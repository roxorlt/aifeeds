// PR5 share client
// 设计：docs/plans/2026-05-04-pr5-share-implementation.md

import { getDeviceId } from './device';

const API_BASE = (() => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE;
  }
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return '';
  }
  return 'https://api.ai-feeds.com';
})();

export interface CreateShareResponse {
  token: string;
  share_url: string;
  poster_url: string;
  expires_at: number;
}

export class ShareError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function createShare(itemId: string): Promise<CreateShareResponse> {
  const res = await fetch(`${API_BASE}/api/share/create`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': getDeviceId(),
    },
    body: JSON.stringify({ item_id: itemId }),
  });
  if (!res.ok) {
    let msg = `share create failed (${res.status})`;
    try {
      const err = await res.json() as { error?: string };
      if (err.error) msg = err.error;
    } catch { /* ignore */ }
    throw new ShareError(res.status, msg);
  }
  return res.json() as Promise<CreateShareResponse>;
}

export async function reportLanding(token: string): Promise<void> {
  await fetch(`${API_BASE}/api/share/landing`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-Device-Id': getDeviceId(),
    },
    body: JSON.stringify({ token }),
  }).catch(() => { /* fire and forget */ });
}
