// 「翻译成中文音频」假门按钮(painted door)—— 收集需求信号,点了不真做配音。
// 一台设备(X-Device-Id)对一集只计一次;计数只在 admin 看板读,不回给 C 端。
// 设计:docs/plans/2026-06-20-podcast-dubbing-cost-and-painted-door.md

import type { Env } from './index';
import { getClientIp } from './client-ip';
import { authenticate } from './auth/session';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// device_id 来自 X-Device-Id header(apiFetch 自动注入,长度 8..64,同 track.ts 口径)
function deviceIdOf(request: Request): string | null {
  const did = request.headers.get('X-Device-Id');
  if (!did || did.length < 8 || did.length > 64) return null;
  return did;
}

// 北京时区 YYYY-MM-DD(cohort/趋势用),与 admin 看板其它日维度口径一致
function bjtDay(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// POST /api/dub-wishlist  body { item_id }
// 匿名即可(读 X-Device-Id);登录则附 user_id。返回 { ok, already }。
export async function handleDubWishlistAdd(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const deviceId = deviceIdOf(request);
  if (!deviceId) return json({ error: 'missing or invalid X-Device-Id' }, 400);

  let body: { item_id?: unknown };
  try {
    body = (await request.json()) as { item_id?: unknown };
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  const itemId = typeof body.item_id === 'string' ? body.item_id.trim() : '';
  if (!itemId || itemId.length > 200) return json({ error: 'item_id required' }, 400);

  // item 必须存在(防脏数据/刷不存在的 id)。按钮只在播客抽屉,这里不强校验 source_type
  // 以免漏 blog 混播的边界;存在即可。
  const item = await env.DB.prepare(
    `SELECT 1 AS x FROM items WHERE id = ? LIMIT 1`,
  ).bind(itemId).first();
  if (!item) return json({ error: 'item not found' }, 404);

  const auth = await authenticate(request, env, ctx);
  const userId = auth.kind === 'authenticated' ? auth.userId : null;
  const now = Date.now();
  const ip = getClientIp(request, env);
  const ua = request.headers.get('User-Agent') || '';

  // INSERT OR IGNORE:命中 UNIQUE(item_id,device_id) 即已加入,changes=0
  const r = await env.DB.prepare(
    `INSERT OR IGNORE INTO dub_wishlist (item_id, device_id, user_id, created_at, day, ip, ua)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(itemId, deviceId, userId, now, bjtDay(now), ip, ua).run();

  const already = (r.meta.changes ?? 0) === 0;
  return json({ ok: true, already });
}

// GET /api/dub-wishlist?item_id=X  → { wishlisted }(刷新后回显「已加入」)
export async function handleDubWishlistState(request: Request, env: Env): Promise<Response> {
  const deviceId = deviceIdOf(request);
  if (!deviceId) return json({ wishlisted: false });
  const url = new URL(request.url);
  const itemId = (url.searchParams.get('item_id') || '').trim();
  if (!itemId) return json({ wishlisted: false });
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM dub_wishlist WHERE item_id = ? AND device_id = ? LIMIT 1`,
  ).bind(itemId, deviceId).first();
  return json({ wishlisted: !!row });
}
