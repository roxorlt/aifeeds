// 用户反馈:C 端登录用户提交图文反馈(每 BJT 自然日 3 条限频)+ 后台图文回复回执。
// C 端 cookie session 鉴权;admin 端 requireAuth(CF Access JWT / Basic 兜底)。
// 图片走 R2(READMES bucket,content-addressed key)+ /r/ 反代下发。
// 设计:docs/plans/2026-07-05-user-feedback-design.md(§3 表 / §4 API 契约)

import { decodeJwt } from 'jose';
import type { Env } from './index';
import { authenticate } from './auth/session';
import { getClientIp } from './client-ip';
import { requireAuth } from './admin';

// ─── 约束常量(§1.4 / §2)──────────────────────────────────────────────
export const CONTENT_MAX = 2000;               // 反馈文字上限(字)
export const REPLY_MAX = 5000;                 // 官方回复文字上限
export const DAILY_CAP = 3;                     // 每账号每 BJT 日提交上限
export const IMG_MAX_BYTES = 5 * 1024 * 1024;  // 图片 ≤5MB
const DEVICE_MAX_CHARS = 8 * 1024;             // device JSON 粗略上限(>8KB 静默丢)
const MINE_LIMIT = 50;                          // C 端「我的反馈」取最近 50 条
const ADMIN_PAGE_SIZE_DEFAULT = 20;
const ADMIN_PAGE_SIZE_MAX = 100;

// 显式白名单:jpeg/png/webp/gif;svg 不在内(§1.4 显式禁 svg,防脚本注入)。
const EXT_FROM_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ─── 纯函数 helpers(单测覆盖:feedback.test.ts)──────────────────────────

// 北京时区 YYYY-MM-DD。与 dub-wishlist.ts / admin 看板其它日维度口径一致
// (那份是模块私有函数,此处按本任务文件边界就地定义,逻辑等价)。
export function bjtDay(ms: number): string {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// SQLite LIKE 通配符转义:%  _  \ 前各加一个反斜杠,配合 `LIKE ? ESCAPE '\'`,
// 让用户输入的 % / _ 按字面匹配(防「q=%」全表泄漏)。反斜杠自身也要转义。
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// mime → 扩展名映射(白名单外返回 null)
export function extForMime(mime: string): string | null {
  return EXT_FROM_MIME[mime] ?? null;
}

// 文字校验:trim 后非空且 ≤max。错误码逐字对齐 §4.1 契约。
export function validateContent(
  raw: unknown,
  max: number,
): { ok: true; value: string } | { ok: false; error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return { ok: false, error: 'content required' };
  if (s.length > max) return { ok: false, error: 'content too long' };
  return { ok: true, value: s };
}

// 图片元信息校验:先看 size 再看 MIME(顺序对齐 §4.1 ④)。返回归一化 mime + ext。
export function validateImageMeta(
  size: number,
  rawType: string,
): { ok: true; ext: string; mime: string } | { ok: false; error: string } {
  if (size > IMG_MAX_BYTES) return { ok: false, error: 'image too large' };
  const mime = (rawType || '').toLowerCase().split(';')[0].trim();
  const ext = extForMime(mime);
  if (!ext) return { ok: false, error: 'unsupported image type' };
  return { ok: true, ext, mime };
}

// 今日剩余次数(remaining = cap - 含本条的当日总数,下限 0)
export function remainingAfter(countIncludingNew: number, cap: number): number {
  return Math.max(0, cap - countIncludingNew);
}

// image_key(R2 key,如 feedback/<sha>.<ext>)→ 对外相对路径 /r/feedback/<sha>.<ext>
export function imageUrlFromKey(key: string | null | undefined): string | null {
  return key ? `/r/${key}` : null;
}

// device JSON 解析:非字符串 / 空 / 超上限 / 非法 JSON 一律静默返回 null(不报错)
export function parseClientDevice(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return null;
  if (raw.length > DEVICE_MAX_CHARS) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeParseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// 从 CF Access JWT(Cf-Access-Jwt-Assertion)取 email claim。requireAuth 已验签过
// 同一 token,这里二次 decode 无需再验;Basic 兜底(无此 header)时返回 null。
function adminEmailFrom(request: Request): string | null {
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return null;
  try {
    const payload = decodeJwt(token);
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

// workers-types 把 FormData.get 标成 string|null,但运行时文件字段返回 File(extends
// Blob,有 size/type/arrayBuffer)。用最小 File-like 运行时校验 + 单点 cast 取回,避免
// 全局放宽类型或对含 string 的联合用 instanceof(TS2358)。文本字段/缺失 → null。
function fileFromForm(form: FormData, name: string): File | null {
  const v = form.get(name) as unknown;
  if (v && typeof v === 'object' && typeof (v as File).arrayBuffer === 'function') {
    return v as File;
  }
  return null;
}

// 图片上传:size/MIME 双校验(客户端提示 + 服务端强制)→ sha256 content-addressed
// key → R2 put。返回 key(存库)或错误。R2 未绑定时静默跳过 put(仅本地无 R2 场景)。
async function processImageUpload(
  file: File,
  env: Env,
): Promise<{ ok: true; key: string } | { ok: false; error: string; status: number }> {
  const meta = validateImageMeta(file.size, file.type);
  if (!meta.ok) return { ok: false, error: meta.error, status: 400 };
  const buf = await file.arrayBuffer();
  // 二次防线:size header 可伪造,实际字节再卡一次
  if (buf.byteLength > IMG_MAX_BYTES) return { ok: false, error: 'image too large', status: 400 };
  const hash = await sha256Hex(buf);
  const key = `feedback/${hash}.${meta.ext}`;
  if (env.READMES) {
    await env.READMES.put(key, buf, {
      httpMetadata: { contentType: meta.mime },
      customMetadata: { source: 'feedback' },
    });
  }
  return { ok: true, key };
}

// 提交时账号快照:display_name + 在用 identity(明文,identities 表本就明文存,
// 快照不扩大暴露面,方便管理员联系用户定位问题 —— §1.7)。
async function buildAccountSnapshot(env: Env, userId: string): Promise<string> {
  const user = await env.DB.prepare(`SELECT display_name FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ display_name: string | null }>();
  const ids = await env.DB.prepare(
    `SELECT provider, identity_value FROM identities
      WHERE user_id = ? AND unbound_at IS NULL ORDER BY id`,
  )
    .bind(userId)
    .all<{ provider: string; identity_value: string }>();
  return JSON.stringify({
    display_name: user?.display_name ?? null,
    identities: (ids.results || []).map((i) => ({
      provider: i.provider,
      identity_value: i.identity_value,
    })),
  });
}

// 本人 feedback 下未读回复数(read_at IS NULL)
async function countUnread(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feedback_replies fr
       JOIN feedback f ON f.id = fr.feedback_id
      WHERE f.user_id = ? AND fr.read_at IS NULL`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

// ─── C 端 handlers(cookie session auth)──────────────────────────────

// POST /api/feedback  multipart/form-data { content, image?, device? }
// 校验顺序(§4.1):① 未登录 401 ② BJT 当日已 3 条 429 ③ content ④ image ⑤ device 静默
export async function handleFeedbackSubmit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // ① 鉴权
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') return json({ error: 'not authenticated' }, 401);
  const userId = auth.userId;

  // ② 限频:COUNT 只需 user_id + day,与 body 无关,先查(避免白解析大 multipart)
  const now = Date.now();
  const day = bjtDay(now);
  const cnt = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feedback WHERE user_id = ? AND day = ?`,
  )
    .bind(userId, day)
    .first<{ n: number }>();
  const todayCount = cnt?.n ?? 0;
  if (todayCount >= DAILY_CAP) return json({ error: 'rate_limited' }, 429);

  // 解析 multipart
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'invalid form data' }, 400);
  }

  // ③ content
  const cv = validateContent(form.get('content'), CONTENT_MAX);
  if (!cv.ok) return json({ error: cv.error }, 400);

  // ④ image(选填,最多 1 张)
  let imageKey: string | null = null;
  // 图片选填(最多 1 张)。空文件(size 0)当作未选图。
  const image = fileFromForm(form, 'image');
  if (image && image.size > 0) {
    const r = await processImageUpload(image, env);
    if (!r.ok) return json({ error: r.error }, r.status);
    imageKey = r.key;
  }

  // ⑤ device(选填,非法/超限静默存 null)+ 服务端定位信息
  const clientDevice = parseClientDevice(form.get('device'));
  const ip = getClientIp(request, env);
  const ua = request.headers.get('User-Agent') || '';
  const cf = request.cf;
  const deviceInfo = JSON.stringify({
    client: clientDevice,
    server: {
      ip,
      ua,
      country: cf?.country ?? null,
      colo: cf?.colo ?? null,
      asn: cf?.asn ?? null,
    },
  });
  const accountInfo = await buildAccountSnapshot(env, userId);

  const res = await env.DB.prepare(
    `INSERT INTO feedback (user_id, content, image_key, device_info, account_info, ip, ua, day, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(userId, cv.value, imageKey, deviceInfo, accountInfo, ip, ua, day, now)
    .run();

  const id = res.meta.last_row_id as number;
  return json({ ok: true, id, created_at: now, remaining: remainingAfter(todayCount + 1, DAILY_CAP) });
}

// GET /api/feedback/mine → 最近 50 条 + 每条回复(ASC)+ 未读回复数
export async function handleFeedbackMine(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') return json({ error: 'not authenticated' }, 401);
  const userId = auth.userId;

  const fb = await env.DB.prepare(
    `SELECT id, content, image_key, created_at
       FROM feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
  )
    .bind(userId, MINE_LIMIT)
    .all<{ id: number; content: string; image_key: string | null; created_at: number }>();
  const rows = fb.results || [];

  // 一次拉这些 feedback 的全部回复(ASC),内存分组,避免 N+1
  const repliesByFb = new Map<
    number,
    Array<{ id: number; content: string; image_url: string | null; created_at: number; read_at: number | null }>
  >();
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const rep = await env.DB.prepare(
      `SELECT id, feedback_id, content, image_key, created_at, read_at
         FROM feedback_replies WHERE feedback_id IN (${placeholders}) ORDER BY created_at ASC`,
    )
      .bind(...ids)
      .all<{
        id: number;
        feedback_id: number;
        content: string;
        image_key: string | null;
        created_at: number;
        read_at: number | null;
      }>();
    for (const r of rep.results || []) {
      const arr = repliesByFb.get(r.feedback_id) || [];
      arr.push({
        id: r.id,
        content: r.content,
        image_url: imageUrlFromKey(r.image_key),
        created_at: r.created_at,
        read_at: r.read_at ?? null,
      });
      repliesByFb.set(r.feedback_id, arr);
    }
  }

  const items = rows.map((r) => ({
    id: r.id,
    content: r.content,
    image_url: imageUrlFromKey(r.image_key),
    created_at: r.created_at,
    replies: repliesByFb.get(r.id) || [],
  }));

  const unread = await countUnread(env, userId);
  return json({ ok: true, unread_count: unread, items });
}

// POST /api/feedback/read → 本人全部未读回复标记已读
export async function handleFeedbackMarkRead(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') return json({ error: 'not authenticated' }, 401);
  const now = Date.now();
  const res = await env.DB.prepare(
    `UPDATE feedback_replies SET read_at = ?
      WHERE read_at IS NULL
        AND feedback_id IN (SELECT id FROM feedback WHERE user_id = ?)`,
  )
    .bind(now, auth.userId)
    .run();
  return json({ ok: true, marked: res.meta.changes ?? 0 });
}

// GET /api/feedback/unread-count → { ok, count }
export async function handleFeedbackUnreadCount(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') return json({ error: 'not authenticated' }, 401);
  const count = await countUnread(env, auth.userId);
  return json({ ok: true, count });
}

// ─── Admin handlers(requireAuth)──────────────────────────────────────

interface AdminListRow {
  id: number;
  user_id: string;
  content: string;
  image_key: string | null;
  created_at: number;
  last_reply_at: number | null;
  display_name: string | null;
  identity: string | null;
  reply_count: number;
}

// GET /api/admin/feedback?q=&status=&page=&page_size=
// q 匹配 user_id 精确 OR display_name 模糊 OR identity_value 模糊(LIKE 转义防注入)
export async function handleAdminFeedbackList(request: Request, env: Env): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const status = url.searchParams.get('status') || 'all';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const rawSize = parseInt(url.searchParams.get('page_size') || String(ADMIN_PAGE_SIZE_DEFAULT), 10);
  const pageSize = Math.min(
    ADMIN_PAGE_SIZE_MAX,
    Math.max(1, Number.isFinite(rawSize) ? rawSize : ADMIN_PAGE_SIZE_DEFAULT),
  );
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const binds: unknown[] = [];
  if (q) {
    where.push(
      `(f.user_id = ? OR u.display_name LIKE ? ESCAPE '\\' OR EXISTS (` +
        `SELECT 1 FROM identities i WHERE i.user_id = f.user_id AND i.identity_value LIKE ? ESCAPE '\\'))`,
    );
    const like = `%${escapeLike(q)}%`;
    binds.push(q, like, like);
  }
  if (status === 'pending') where.push(`f.last_reply_at IS NULL`);
  else if (status === 'replied') where.push(`f.last_reply_at IS NOT NULL`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const totalRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM feedback f LEFT JOIN users u ON u.id = f.user_id ${whereSql}`,
  )
    .bind(...binds)
    .first<{ n: number }>();
  const total = totalRow?.n ?? 0;

  const listRes = await env.DB.prepare(
    `SELECT f.id, f.user_id, f.content, f.image_key, f.created_at, f.last_reply_at,
            u.display_name AS display_name,
            (SELECT i.provider || ':' || i.identity_value FROM identities i
              WHERE i.user_id = f.user_id AND i.unbound_at IS NULL ORDER BY i.id LIMIT 1) AS identity,
            (SELECT COUNT(*) FROM feedback_replies fr WHERE fr.feedback_id = f.id) AS reply_count
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id
       ${whereSql}
       ORDER BY f.created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(...binds, pageSize, offset)
    .all<AdminListRow>();

  const items = (listRes.results || []).map((r) => ({
    id: r.id,
    user_id: r.user_id,
    display_name: r.display_name ?? null,
    identity: r.identity ?? null,
    content: r.content,
    image_url: imageUrlFromKey(r.image_key),
    created_at: r.created_at,
    reply_count: r.reply_count ?? 0,
    last_reply_at: r.last_reply_at ?? null,
  }));

  return json({ ok: true, total, page, page_size: pageSize, items });
}

// GET /api/admin/feedback/:id → 详情(device_info/account_info 解析为对象)+ 回复线程
export async function handleAdminFeedbackDetail(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;

  const f = await env.DB.prepare(
    `SELECT f.id, f.user_id, f.content, f.image_key, f.device_info, f.account_info,
            f.ip, f.ua, f.created_at, f.last_reply_at,
            u.display_name AS display_name,
            (SELECT i.provider || ':' || i.identity_value FROM identities i
              WHERE i.user_id = f.user_id AND i.unbound_at IS NULL ORDER BY i.id LIMIT 1) AS identity
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id
      WHERE f.id = ?`,
  )
    .bind(id)
    .first<{
      id: number;
      user_id: string;
      content: string;
      image_key: string | null;
      device_info: string | null;
      account_info: string | null;
      ip: string | null;
      ua: string | null;
      created_at: number;
      last_reply_at: number | null;
      display_name: string | null;
      identity: string | null;
    }>();
  if (!f) return json({ error: 'not found' }, 404);

  const rep = await env.DB.prepare(
    `SELECT id, content, image_key, admin_email, created_at, read_at
       FROM feedback_replies WHERE feedback_id = ? ORDER BY created_at ASC`,
  )
    .bind(id)
    .all<{
      id: number;
      content: string;
      image_key: string | null;
      admin_email: string | null;
      created_at: number;
      read_at: number | null;
    }>();

  return json({
    ok: true,
    feedback: {
      id: f.id,
      user_id: f.user_id,
      display_name: f.display_name ?? null,
      identity: f.identity ?? null,
      content: f.content,
      image_url: imageUrlFromKey(f.image_key),
      device_info: safeParseJson(f.device_info),
      account_info: safeParseJson(f.account_info),
      ip: f.ip ?? null,
      ua: f.ua ?? null,
      created_at: f.created_at,
      last_reply_at: f.last_reply_at ?? null,
    },
    replies: (rep.results || []).map((r) => ({
      id: r.id,
      content: r.content,
      image_url: imageUrlFromKey(r.image_key),
      admin_email: r.admin_email ?? null,
      created_at: r.created_at,
      read_at: r.read_at ?? null,
    })),
  });
}

// POST /api/admin/feedback/:id/reply  multipart/form-data { content, image? }
export async function handleAdminFeedbackReply(
  request: Request,
  env: Env,
  id: number,
): Promise<Response> {
  const guard = await requireAuth(request, env);
  if (guard) return guard;

  const exists = await env.DB.prepare(`SELECT id FROM feedback WHERE id = ?`)
    .bind(id)
    .first<{ id: number }>();
  if (!exists) return json({ error: 'not found' }, 404);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'invalid form data' }, 400);
  }

  const cv = validateContent(form.get('content'), REPLY_MAX);
  if (!cv.ok) return json({ error: cv.error }, 400);

  let imageKey: string | null = null;
  // 图片选填(最多 1 张)。空文件(size 0)当作未选图。
  const image = fileFromForm(form, 'image');
  if (image && image.size > 0) {
    const r = await processImageUpload(image, env);
    if (!r.ok) return json({ error: r.error }, r.status);
    imageKey = r.key;
  }

  const adminEmail = adminEmailFrom(request);
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO feedback_replies (feedback_id, content, image_key, admin_email, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, cv.value, imageKey, adminEmail, now)
    .run();
  await env.DB.prepare(`UPDATE feedback SET last_reply_at = ? WHERE id = ?`).bind(now, id).run();

  return json({ ok: true, id: res.meta.last_row_id as number, created_at: now });
}
