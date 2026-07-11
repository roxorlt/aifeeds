// device_id SDK — LocalStorage UUID（合规优先，非指纹方案）
// 设计：docs/plans/2026-05-01-auth-system-design.md § 5

import { nanoid } from 'nanoid';

const DID_KEY = 'xlist_did';
const DID_LEN = 21;        // nanoid 默认 21 字符，碰撞概率可忽略
const SESSION_DID_PREFIX = 's_';

let cachedDid: string | null = null;

/**
 * 获取持久 device_id。
 * 优先 LocalStorage（首访生成 nanoid 21 字符）。
 * Safari 隐身 / LocalStorage 不可用时退化到 sessionStorage（id 带 s_ 前缀，标记为短命）。
 */
export function getDeviceId(): string {
  if (cachedDid) return cachedDid;

  try {
    let did = localStorage.getItem(DID_KEY);
    if (!did) {
      did = nanoid(DID_LEN);
      localStorage.setItem(DID_KEY, did);
    }
    cachedDid = did;
    return did;
  } catch {
    return getOrCreateSessionDid();
  }
}

function getOrCreateSessionDid(): string {
  try {
    let did = sessionStorage.getItem(DID_KEY);
    if (!did) {
      did = `${SESSION_DID_PREFIX}${nanoid(DID_LEN - SESSION_DID_PREFIX.length)}`;
      sessionStorage.setItem(DID_KEY, did);
    }
    cachedDid = did;
    return did;
  } catch {
    // 极端情况下两个 Storage 都不可用，生成内存 only id（关闭 tab 即丢）
    if (!cachedDid) cachedDid = `${SESSION_DID_PREFIX}${nanoid(DID_LEN - SESSION_DID_PREFIX.length)}`;
    return cachedDid;
  }
}

/**
 * 重置 device_id（用户在设置页主动清除时调用）。
 * 清 LocalStorage + sessionStorage + 内存缓存。
 */
export function resetDeviceId(): void {
  cachedDid = null;
  try { localStorage.removeItem(DID_KEY); } catch {
    // 隐私模式或存储策略可能拒绝访问，本地内存状态仍已重置。
  }
  try { sessionStorage.removeItem(DID_KEY); } catch {
    // 隐私模式或存储策略可能拒绝访问，本地内存状态仍已重置。
  }
}

/** 是否为 sessionStorage 兜底生成的临时 id（用于 telemetry 区分） */
export function isSessionOnlyDid(did: string): boolean {
  return did.startsWith(SESSION_DID_PREFIX);
}
