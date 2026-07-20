// 每日日报视频上传核心。
// index.ts 只需把 POST 路由交给 handleDailyVideoUpload(request, env)；鉴权、multipart
// 校验、内容寻址 R2 写入、D1 幂等 UPSERT 与旧对象延迟清理均封装在本模块。

import type { Env } from '../index';
import { patchDailyPageVideoHtml } from './daily-page';

export const DAILY_VIDEO_LIMITS = {
  mp4: 64 * 1024 * 1024,
  poster: 5 * 1024 * 1024,
  vtt: 2 * 1024 * 1024,
} as const;

const MAX_DURATION_SECONDS = 8 * 60 * 60;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 5000;
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';
const DAILY_VIDEO_GC_DELAY_MS = 48 * 60 * 60 * 1000;

type DailyVideoFileKind = keyof typeof DAILY_VIDEO_LIMITS;

export interface DailyVideoRow {
  date: string;
  title: string;
  description: string;
  duration_seconds: number;
  mp4_key: string;
  mp4_sha256: string;
  mp4_size: number;
  poster_key: string;
  poster_sha256: string;
  poster_size: number;
  vtt_key: string;
  vtt_sha256: string;
  vtt_size: number;
  uploaded_at: string;
  updated_at: string;
}

export interface DailyVideoEnv {
  DB: D1Database;
  READMES?: R2Bucket;
  X_CARD_SHARED_TOKEN?: string;
  SITE_BASE?: string;
  API_BASE?: string;
  INDEXNOW_KEY?: string;
}

export interface DailyVideoGcDrainOptions {
  limit: number;
  now?: Date | string;
}

export interface DailyVideoGcDrainResult {
  processed: number;
  deleted: number;
  clearedReferenced: number;
  failed: number;
}

interface DailyVideoGcRow {
  r2_key: string;
  delete_after: string;
}

interface UploadParts {
  date: string;
  title: string;
  description: string;
  duration: number;
  mp4: File;
  poster: File;
  vtt: File;
}

type ValidationResult = { ok: true } | { ok: false; error: string };

const MIME_BY_KIND: Record<DailyVideoFileKind, string> = {
  mp4: 'video/mp4',
  poster: 'image/jpeg',
  vtt: 'text/vtt',
};

export function validateDailyVideoFileMeta(
  kind: DailyVideoFileKind,
  size: number,
  mime: string,
): ValidationResult {
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: `${kind} is empty` };
  if (size > DAILY_VIDEO_LIMITS[kind]) return { ok: false, error: `${kind} is too large` };
  if (mime.toLowerCase() !== MIME_BY_KIND[kind]) return { ok: false, error: `invalid ${kind} MIME` };
  return { ok: true };
}

function isValidCalendarDate(value: string): boolean {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime())
    && d.getUTCFullYear() === Number(m[1])
    && d.getUTCMonth() + 1 === Number(m[2])
    && d.getUTCDate() === Number(m[3]);
}

function fileFromForm(form: FormData, name: string): File | null {
  const value = form.get(name) as unknown;
  if (
    value
    && typeof value === 'object'
    && typeof (value as File).arrayBuffer === 'function'
    && typeof (value as File).size === 'number'
    && typeof (value as File).type === 'string'
  ) return value as File;
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function hasDailyVideoBearer(request: Request, expected?: string): boolean {
  if (!expected) return false;
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  return constantTimeEqual(auth.slice(7).trim(), expected);
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function parseUpload(form: FormData): UploadParts | { error: string } {
  const date = String(form.get('date') || '').trim();
  const title = String(form.get('title') || '').trim();
  const description = String(form.get('description') || '').trim();
  const duration = Number(String(form.get('duration') || '').trim());
  if (!isValidCalendarDate(date)) return { error: 'invalid date' };
  if (!title || title.length > MAX_TITLE_CHARS) return { error: 'invalid title' };
  if (!description || description.length > MAX_DESCRIPTION_CHARS) return { error: 'invalid description' };
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS) {
    return { error: 'invalid duration' };
  }

  const mp4 = fileFromForm(form, 'mp4');
  const poster = fileFromForm(form, 'poster');
  const vtt = fileFromForm(form, 'vtt');
  if (!mp4 || !poster || !vtt) return { error: 'mp4, poster and vtt files are required' };
  for (const [kind, file] of [['mp4', mp4], ['poster', poster], ['vtt', vtt]] as const) {
    const valid = validateDailyVideoFileMeta(kind, file.size, file.type);
    if (!valid.ok) return { error: valid.error };
  }
  return { date, title, description, duration, mp4, poster, vtt };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function jpegDimensions(bytes: ArrayBuffer): { width: number; height: number } | null {
  const data = new Uint8Array(bytes);
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 3 < data.length) {
    if (data[pos] !== 0xff) {
      pos++;
      continue;
    }
    while (data[pos] === 0xff) pos++;
    const marker = data[pos++];
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (pos + 1 >= data.length) return null;
    const length = (data[pos] << 8) | data[pos + 1];
    if (length < 2 || pos + length > data.length) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && length >= 7) {
      return {
        height: (data[pos + 3] << 8) | data[pos + 4],
        width: (data[pos + 5] << 8) | data[pos + 6],
      };
    }
    pos += length;
  }
  return null;
}

function isWebVtt(bytes: ArrayBuffer): boolean {
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 64))).replace(/^\uFEFF/, '');
  return prefix.startsWith('WEBVTT');
}

async function putImmutable(
  bucket: R2Bucket,
  key: string,
  bytes: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const existing = await bucket.head(key);
  if (existing) return;
  await bucket.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
    customMetadata: { source: 'daily-video', sha256: key.slice(key.lastIndexOf('/') + 1, key.lastIndexOf('.')) },
  });
}

export async function loadDailyVideo(env: DailyVideoEnv, date: string): Promise<DailyVideoRow | null> {
  return env.DB.prepare(`SELECT * FROM daily_videos WHERE date = ?`).bind(date).first<DailyVideoRow>();
}

export async function drainDailyVideoGc(
  env: DailyVideoEnv,
  options: DailyVideoGcDrainOptions,
): Promise<DailyVideoGcDrainResult> {
  if (!env.READMES) throw new Error('R2 not configured');
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 0;
  const result: DailyVideoGcDrainResult = {
    processed: 0,
    deleted: 0,
    clearedReferenced: 0,
    failed: 0,
  };
  if (limit === 0) return result;

  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error('invalid GC time');
  const due = await env.DB.prepare(
    `SELECT r2_key, delete_after
     FROM daily_video_gc
     WHERE delete_after <= ?
     ORDER BY delete_after ASC
     LIMIT ?`,
  ).bind(now.toISOString(), limit).all<DailyVideoGcRow>();

  for (const item of due.results || []) {
    result.processed++;
    const referenced = await env.DB.prepare(
      `SELECT 1 AS referenced
       FROM daily_videos
       WHERE mp4_key = ? OR poster_key = ? OR vtt_key = ?
       LIMIT 1`,
    ).bind(item.r2_key, item.r2_key, item.r2_key).first<{ referenced: number }>();
    if (referenced) {
      await env.DB.prepare(`DELETE FROM daily_video_gc WHERE r2_key = ?`).bind(item.r2_key).run();
      result.clearedReferenced++;
      continue;
    }

    try {
      await env.READMES.delete(item.r2_key);
    } catch {
      result.failed++;
      continue;
    }
    await env.DB.prepare(`DELETE FROM daily_video_gc WHERE r2_key = ?`).bind(item.r2_key).run();
    result.deleted++;
  }
  return result;
}

async function patchExistingDailyPage(
  env: DailyVideoEnv,
  video: DailyVideoRow,
): Promise<boolean> {
  const key = `daily/${video.date}.html`;
  const object = await env.READMES!.get(key);
  if (!object) return false;
  const original = await object.text();
  const patched = patchDailyPageVideoHtml(original, video, env as Env);
  if (patched !== original) {
    await env.READMES!.put(key, patched, {
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    });
  }
  return true;
}

function sameUpload(a: DailyVideoRow | null, b: DailyVideoRow): boolean {
  return !!a
    && a.title === b.title
    && a.description === b.description
    && Number(a.duration_seconds) === b.duration_seconds
    && a.mp4_sha256 === b.mp4_sha256
    && a.poster_sha256 === b.poster_sha256
    && a.vtt_sha256 === b.vtt_sha256;
}

async function upsertMetadata(env: DailyVideoEnv, row: DailyVideoRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO daily_videos (
       date, title, description, duration_seconds,
       mp4_key, mp4_sha256, mp4_size,
       poster_key, poster_sha256, poster_size,
       vtt_key, vtt_sha256, vtt_size,
       uploaded_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       duration_seconds = excluded.duration_seconds,
       mp4_key = excluded.mp4_key,
       mp4_sha256 = excluded.mp4_sha256,
       mp4_size = excluded.mp4_size,
       poster_key = excluded.poster_key,
       poster_sha256 = excluded.poster_sha256,
       poster_size = excluded.poster_size,
       vtt_key = excluded.vtt_key,
       vtt_sha256 = excluded.vtt_sha256,
       vtt_size = excluded.vtt_size,
       uploaded_at = excluded.uploaded_at,
       updated_at = excluded.updated_at`,
  ).bind(
    row.date, row.title, row.description, row.duration_seconds,
    row.mp4_key, row.mp4_sha256, row.mp4_size,
    row.poster_key, row.poster_sha256, row.poster_size,
    row.vtt_key, row.vtt_sha256, row.vtt_size,
    row.uploaded_at, row.updated_at,
  ).run();
}

async function markDailyPageVideoPublished(env: DailyVideoEnv, row: DailyVideoRow): Promise<void> {
  await env.DB.prepare(
    `UPDATE daily_pages SET lastmod = ? WHERE date = ?`,
  ).bind(row.updated_at, row.date).run();
}

export function dailyVideoIndexNowUrls(env: DailyVideoEnv, date: string): string[] {
  const siteBase = env.SITE_BASE || 'https://ai-feeds.com';
  return [
    `${siteBase}/daily/${date}`,
    `${siteBase}/video/daily/${date}`,
    `${siteBase}/video-sitemap.xml`,
    `${siteBase}/sitemap-daily.xml`,
    `${siteBase}/sitemap.xml`,
  ];
}

async function submitDailyVideoIndexNow(env: DailyVideoEnv, date: string): Promise<void> {
  if (!env.INDEXNOW_KEY) return;
  const urls = dailyVideoIndexNowUrls(env, date);
  const siteBase = env.SITE_BASE || 'https://ai-feeds.com';
  let host = 'ai-feeds.com';
  try {
    host = new URL(siteBase).host;
  } catch {
    // Keep the production host fallback when SITE_BASE is malformed.
  }
  try {
    const response = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, key: env.INDEXNOW_KEY, urlList: urls }),
    });
    if (!response.ok) console.error(`[daily-video] IndexNow non-2xx: ${response.status}`);
  } catch (error) {
    console.error(`[daily-video] IndexNow failed: ${String(error).slice(0, 160)}`);
  }
}

async function queueSuperseded(
  env: DailyVideoEnv,
  previous: DailyVideoRow | null,
  current: DailyVideoRow,
): Promise<void> {
  if (!previous) return;
  const keep = new Set([current.mp4_key, current.poster_key, current.vtt_key]);
  const deleteAfter = new Date(Date.parse(current.updated_at) + DAILY_VIDEO_GC_DELAY_MS).toISOString();
  for (const key of new Set([previous.mp4_key, previous.poster_key, previous.vtt_key])) {
    if (keep.has(key)) continue;
    await env.DB.prepare(
      `INSERT INTO daily_video_gc (r2_key, delete_after, enqueued_at)
       VALUES (?, ?, ?)
       ON CONFLICT(r2_key) DO UPDATE SET
         delete_after = excluded.delete_after,
         enqueued_at = excluded.enqueued_at`,
    ).bind(key, deleteAfter, current.updated_at).run();
  }
}

export async function handleDailyVideoUpload(request: Request, env: DailyVideoEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
  if (!hasDailyVideoBearer(request, env.X_CARD_SHARED_TOKEN)) {
    return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }
  if (!env.READMES) return json({ error: 'R2 not configured' }, 503);

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: 'invalid multipart form data' }, 400);
  }
  const parsed = parseUpload(form);
  if ('error' in parsed) return json({ error: parsed.error }, 400);

  try {
    const [mp4Bytes, posterBytes, vttBytes] = await Promise.all([
      parsed.mp4.arrayBuffer(), parsed.poster.arrayBuffer(), parsed.vtt.arrayBuffer(),
    ]);
    for (const [kind, bytes] of [['mp4', mp4Bytes], ['poster', posterBytes], ['vtt', vttBytes]] as const) {
      if (bytes.byteLength <= 0 || bytes.byteLength > DAILY_VIDEO_LIMITS[kind]) {
        return json({ error: `${kind} has invalid byte size` }, 400);
      }
    }
    const dimensions = jpegDimensions(posterBytes);
    if (!dimensions || dimensions.width * 9 !== dimensions.height * 16) {
      return json({ error: 'poster must be a valid 16:9 JPEG' }, 400);
    }
    if (!isWebVtt(vttBytes)) return json({ error: 'vtt must start with WEBVTT' }, 400);
    const dailyPageKey = `daily/${parsed.date}.html`;
    if (!await env.READMES.head(dailyPageKey)) {
      return json({ error: 'daily page not found' }, 409);
    }

    const [mp4Hash, posterHash, vttHash] = await Promise.all([
      sha256Hex(mp4Bytes), sha256Hex(posterBytes), sha256Hex(vttBytes),
    ]);
    const previous = await loadDailyVideo(env, parsed.date);
    const now = new Date().toISOString();
    const sameAssets = !!previous
      && previous.mp4_sha256 === mp4Hash
      && previous.poster_sha256 === posterHash
      && previous.vtt_sha256 === vttHash;
    const row: DailyVideoRow = {
      date: parsed.date,
      title: parsed.title,
      description: parsed.description,
      duration_seconds: parsed.duration,
      mp4_key: `daily-video/${parsed.date}/${mp4Hash}.mp4`,
      mp4_sha256: mp4Hash,
      mp4_size: mp4Bytes.byteLength,
      poster_key: `daily-video/${parsed.date}/${posterHash}.jpg`,
      poster_sha256: posterHash,
      poster_size: posterBytes.byteLength,
      vtt_key: `daily-video/${parsed.date}/${vttHash}.vtt`,
      vtt_sha256: vttHash,
      vtt_size: vttBytes.byteLength,
      uploaded_at: sameAssets && previous ? previous.uploaded_at : now,
      updated_at: now,
    };
    const unchanged = sameUpload(previous, row);

    await Promise.all([
      putImmutable(env.READMES, row.mp4_key, mp4Bytes, 'video/mp4'),
      putImmutable(env.READMES, row.poster_key, posterBytes, 'image/jpeg'),
      putImmutable(env.READMES, row.vtt_key, vttBytes, 'text/vtt; charset=utf-8'),
    ]);
    await upsertMetadata(env, row);
    await queueSuperseded(env, previous, row);
    const pagePatched = await patchExistingDailyPage(env, row);
    if (pagePatched) await markDailyPageVideoPublished(env, row);
    await submitDailyVideoIndexNow(env, row.date);

    return json({ ok: true, unchanged, pagePatched, video: row }, previous ? 200 : 201);
  } catch (error) {
    console.error(`[daily-video] upload failed: ${String(error).slice(0, 240)}`);
    return json({ error: 'daily video upload failed' }, 500);
  }
}
