// PR5 share client
// 设计：docs/plans/2026-05-04-pr5-share-implementation.md

import { getDeviceId } from './device';
// PM 2026-05-22 反馈 (Network 截图诊断): staging dashboard share API 调
// 的是 prod api.ai-feeds.com 而非 staging-api,根因 — 本文件之前自己
// 定义 API_BASE 漏了 staging.ai-feeds.com hostname check (api.ts 有,
// share.ts 没同步)。统一 import api.ts 的 API_BASE 避免双源维护
import { API_BASE } from '../api';

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
