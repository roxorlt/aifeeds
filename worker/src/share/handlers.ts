// PR5 share feature handlers
// 设计：docs/plans/2026-05-04-pr5-share-implementation.md § 3

import { nanoid } from 'nanoid';
import type { Env } from '../index';
import type { CreateShareRequest, CreateShareResponse, LandingRequest, ShareRelation } from './types';
import { authenticate } from '../auth/session';

const PUBLIC_DOMAIN = 'https://ai-feeds.com';

function jsonRes(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function jsonErr(error: string, status = 400): Response {
  return jsonRes({ error }, status);
}

// ─── POST /api/share/create ──────────────────────────────────────────
// 输入: { item_id: string }
// 鉴权: cookie / session
// 返回: token + share_url + poster_url + expires_at

export async function handleShareCreate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // 1. 鉴权
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') return jsonErr('not authenticated', 401);

  // 2. 解析 body
  let body: CreateShareRequest;
  try {
    body = (await request.json()) as CreateShareRequest;
  } catch {
    return jsonErr('invalid json', 400);
  }
  if (!body.item_id || typeof body.item_id !== 'string') return jsonErr('item_id required', 400);

  // 3. 校验 item 存在
  const item = await env.DB.prepare(`SELECT id FROM items WHERE id = ? AND deleted_at IS NULL`)
    .bind(body.item_id)
    .first<{ id: string }>();
  if (!item) return jsonErr('item not found', 404);

  // 4. 生成 token + 写 share_relations
  // 注：nanoid 默认 21 字符；分享场景用 8 字符短码（碰撞概率约 50 亿次后才有 1%）
  const token = nanoid(8);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO share_relations (token, from_uid, item_id, shared_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(token, auth.userId, body.item_id, now)
    .run();

  // 5. 返回
  // TODO: poster_url 在 Step 2 接入实际渲染（目前指向 endpoint，命中后才渲染）
  const response: CreateShareResponse = {
    token,
    share_url: `${PUBLIC_DOMAIN}/s/${token}`,
    poster_url: `https://api.ai-feeds.com/api/share/poster/${token}`,
    expires_at: now + 30 * 24 * 3600 * 1000, // 30 天（用于前端 hint，实际不强制 expire token）
  };
  return jsonRes(response);
}

// ─── GET /api/share/poster/:token ────────────────────────────────────
// 返回 image/png（Step 2 实现 SVG → PNG 渲染 + R2 缓存）
// 当前占位：返回 501 Not Implemented，dashboard 看到此状态可显示「正在生成…」

export async function handleSharePoster(request: Request, env: Env, token: string): Promise<Response> {
  const rel = await env.DB.prepare(`SELECT * FROM share_relations WHERE token = ?`).bind(token).first<ShareRelation>();
  if (!rel) return jsonErr('share token not found', 404);

  // Step 2.1 占位 smoke：渲染一个最小 SVG，验证 wasm + 字体正确打进 worker bundle。
  // Step 2.2 接 SVG 模板（按 v7 mockup），Step 2.3 接 R2 缓存。
  const url = new URL(request.url);
  if (url.searchParams.get('smoke') === '1') {
    const { renderSvgToPng } = await import('./poster');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200">
      <rect width="100%" height="100%" fill="#0b1019"/>
      <text x="40" y="80" fill="#fff" font-family="Noto Sans SC" font-size="44" font-weight="500">分享海报渲染测试</text>
      <text x="40" y="140" fill="#9aa3b2" font-family="Noto Sans SC" font-size="28" font-weight="500">token: ${token}</text>
    </svg>`;
    const png = await renderSvgToPng(svg);
    return new Response(png, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      },
    });
  }
  return jsonRes({ todo: 'poster rendering pending Step 2.2/2.3', token, item_id: rel.item_id }, 501);
}

// ─── GET /s/:token ───────────────────────────────────────────────────
// 扫码命中：写 landed_at + to_did，redirect 到详情页

export async function handleShareRedirect(request: Request, env: Env, ctx: ExecutionContext, token: string): Promise<Response> {
  const rel = await env.DB.prepare(`SELECT * FROM share_relations WHERE token = ?`).bind(token).first<ShareRelation>();
  if (!rel) {
    // token 不存在直接 redirect 首页
    return Response.redirect(PUBLIC_DOMAIN, 302);
  }

  const did = request.headers.get('X-Device-Id') || extractDeviceIdFromCookie(request);
  const now = Date.now();

  // 异步写更新：首次扫码补 to_did + landed_at；后续 +1 scan_count
  ctx.waitUntil(
    (async () => {
      if (!rel.landed_at) {
        await env.DB.prepare(
          `UPDATE share_relations SET to_did = ?, landed_at = ?, scan_count = 1, last_scanned_at = ? WHERE token = ?`,
        )
          .bind(did, now, now, token)
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE share_relations SET scan_count = scan_count + 1, last_scanned_at = ? WHERE token = ?`,
        )
          .bind(now, token)
          .run();
      }
    })(),
  );

  // 解析 item_id 拿 detail URL：item_id 形如 'x_list:123…' / 'github:owner/repo' / 'product_hunt:slug'
  // 详情页路由跟 dashboard 现有 url-routing 一致：/t/<full_id> 或 /g/<owner>/<repo>
  const detailPath = buildDetailPath(rel.item_id);
  const target = `${PUBLIC_DOMAIN}${detailPath}?from=${encodeURIComponent(rel.from_uid)}&ref=share&token=${token}`;
  return Response.redirect(target, 302);
}

// ─── POST /api/share/landing ─────────────────────────────────────────
// 落地详情页时前端调用，补 to_did（redirect 时浏览器可能没 device_id cookie）

export async function handleShareLanding(request: Request, env: Env): Promise<Response> {
  let body: LandingRequest;
  try {
    body = (await request.json()) as LandingRequest;
  } catch {
    return jsonErr('invalid json', 400);
  }
  if (!body.token) return jsonErr('token required', 400);

  const did = request.headers.get('X-Device-Id');
  if (!did) return jsonErr('X-Device-Id required', 400);

  // 仅当 to_did 为空时 UPDATE（防止覆盖已记录的首次扫码 did）
  await env.DB.prepare(
    `UPDATE share_relations
       SET to_did = ?, landed_at = ?
     WHERE token = ? AND to_did IS NULL`,
  )
    .bind(did, Date.now(), body.token)
    .run();

  return jsonRes({ ok: true });
}

// ─── GET /api/admin/share/:token ─────────────────────────────────────
// admin 工具，看一个 token 的扫码统计

export async function handleAdminShareStats(request: Request, env: Env, token: string): Promise<Response> {
  // checkAdminAuth 在 admin.ts，复用
  const { checkAdminAuth } = await import('../admin');
  if (!checkAdminAuth(request, env)) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
    });
  }

  const rel = await env.DB.prepare(`SELECT * FROM share_relations WHERE token = ?`).bind(token).first<ShareRelation>();
  if (!rel) return jsonErr('share token not found', 404);

  return jsonRes(rel);
}

// ─── helpers ─────────────────────────────────────────────────────────

function extractDeviceIdFromCookie(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)device_id=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function buildDetailPath(itemId: string): string {
  // X / podcast / arxiv / 等 → /t/<full_id>
  // GitHub → /g/<owner>/<repo>
  if (itemId.startsWith('github:')) {
    const repo = itemId.slice('github:'.length); // 形如 'owner/repo'
    return `/g/${repo}`;
  }
  // 其他 source 走通用详情页 /t/<id>
  return `/t/${encodeURIComponent(itemId)}`;
}
