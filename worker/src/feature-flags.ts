// 简单 KV-based feature flag 系统
//
// 用法:
//   - 检查: `await isFlagOn(env, 'impression_refresh')` → boolean
//   - 设置: `await setFlag(env, 'impression_refresh', 'off')` (admin endpoint 调)
//   - 列表: `await listFlags(env)` (admin /admin/tools UI 用)
//
// 设计:
//   - KV key: `flag:<flag_key>`, value: 'on' | 'off'
//   - 默认未配置 = 'on' (open by default)
//   - 模块级 60s 内存缓存避免每个 request 都打 KV (cold start 后第一个 request
//     fill cache, 后续 60s 内零 KV 调用; setFlag 时 invalidate 立即生效)
//   - cache 在 worker isolate 之间不共享 — 多个 isolate 各自 60s 内可能数据不一致,
//     这种容忍 (flag 切换允许 60s eventual consistency)

const CACHE_TTL_MS = 60_000;
const FLAG_KEY_PREFIX = 'flag:';

// 已知 flag 列表 — 加新 flag 加到这里
export const KNOWN_FLAGS = ['impression_refresh'] as const;
export type FlagKey = (typeof KNOWN_FLAGS)[number];
export type FlagValue = 'on' | 'off';

interface KvLike {
  AUTH_KV?: KVNamespace;
}

let cache: { ts: number; data: Record<FlagKey, FlagValue> } | null = null;

async function readAll(env: KvLike): Promise<Record<FlagKey, FlagValue>> {
  const data = {} as Record<FlagKey, FlagValue>;
  if (!env.AUTH_KV) {
    for (const k of KNOWN_FLAGS) data[k] = 'on';
    return data;
  }
  await Promise.all(
    KNOWN_FLAGS.map(async (k) => {
      const v = await env.AUTH_KV!.get(FLAG_KEY_PREFIX + k);
      data[k] = v === 'off' ? 'off' : 'on';
    }),
  );
  return data;
}

export async function isFlagOn(env: KvLike, key: FlagKey): Promise<boolean> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return cache.data[key] !== 'off';
  }
  const data = await readAll(env);
  cache = { ts: Date.now(), data };
  return data[key] !== 'off';
}

export async function listFlags(env: KvLike): Promise<Record<FlagKey, FlagValue>> {
  // admin endpoint 直接读 KV (不走缓存, 拿真实当前值)
  return readAll(env);
}

export async function setFlag(env: KvLike, key: FlagKey, value: FlagValue): Promise<void> {
  if (!env.AUTH_KV) throw new Error('AUTH_KV not bound');
  if (value !== 'on' && value !== 'off') throw new Error(`invalid flag value: ${value}`);
  await env.AUTH_KV.put(FLAG_KEY_PREFIX + key, value);
  cache = null;  // invalidate, 下次 read 拿新值
}

// ─── Admin handlers ─────────────────────────────────────────────
// 引用走相对路径避免 circular import (admin.ts 不引用 feature-flags.ts)

import { requireAuth, jsonRes } from './admin';
import type { Env } from './index';

export async function handleAdminListFlags(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  return jsonRes(await listFlags(env));
}

export async function handleAdminSetFlag(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;
  if (!(KNOWN_FLAGS as readonly string[]).includes(key)) {
    return jsonRes({ error: `unknown flag: ${key}`, known: KNOWN_FLAGS }, 400);
  }
  let body: { value?: unknown };
  try {
    body = (await request.json()) as { value?: unknown };
  } catch {
    return jsonRes({ error: 'invalid JSON body' }, 400);
  }
  const v = body.value;
  if (v !== 'on' && v !== 'off') {
    return jsonRes({ error: 'value must be "on" or "off"' }, 400);
  }
  await setFlag(env, key as FlagKey, v);
  return jsonRes({ key, value: v, ok: true });
}
