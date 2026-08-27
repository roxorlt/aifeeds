// 每日日报视频上传核心。
// index.ts 只需把 POST 路由交给 handleDailyVideoUpload(request, env)；鉴权、multipart
// 校验、append-only private R2 PUT、统一 page/video release promotion 与兼容 projection
// 均封装在本模块。业务运行时不提供 publication DELETE。

import type { Env } from '../index';
import { patchDailyPageVideoHtml } from './daily-page';
import { canonicalBusinessRevision } from './publication-canonical';
import { reserveAppendOnlyPublication } from './publication-storage';
import {
  assertCurrentDailyReleaseAuthorization,
  loadCurrentDailyReleaseForBuild,
  materializeAppendOnlyPublication,
  promoteDailyRelease,
  readAuthorizedDailyPage,
} from './publication-release';

export const DAILY_VIDEO_LIMITS = {
  mp4: 64 * 1024 * 1024,
  poster: 8 * 1024 * 1024,
  vtt: 1 * 1024 * 1024,
} as const;

const MAX_DURATION_SECONDS = 8 * 60 * 60;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 5000;
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow';

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
  DAILY_PUBLICATION_RESERVATION_ENABLED?: string;
  DAILY_PUBLICATION_PUT_ENABLED?: string;
  DAILY_PUBLICATION_PROMOTION_ENABLED?: string;
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

export async function drainDailyVideoGc(
  _env: DailyVideoEnv,
  _options: DailyVideoGcDrainOptions,
): Promise<DailyVideoGcDrainResult> {
  // Append-only publication objects are never deleted by the business runtime.
  return { processed: 0, deleted: 0, clearedReferenced: 0, failed: 0 };
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

async function upsertMetadata(
  env: DailyVideoEnv,
  row: DailyVideoRow,
  release: {
    release_generation: number;
    page_publication_id: string;
    video_publication_id: string | null;
    video_manifest_digest: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO daily_videos (
       date, title, description, duration_seconds,
       mp4_key, mp4_sha256, mp4_size,
       poster_key, poster_sha256, poster_size,
       vtt_key, vtt_sha256, vtt_size,
       uploaded_at, updated_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM daily_release_heads h
         JOIN append_only_publications p ON p.publication_id=h.page_publication_id
         JOIN append_only_publications v ON v.publication_id=h.video_publication_id
        WHERE h.date=? AND h.release_generation=? AND h.page_publication_id=?
          AND h.video_publication_id=? AND h.video_manifest_digest=?
          AND p.state='published' AND v.state='published')
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
       updated_at = excluded.updated_at
     WHERE EXISTS (SELECT 1 FROM daily_release_heads h
       JOIN append_only_publications p ON p.publication_id=h.page_publication_id
       JOIN append_only_publications v ON v.publication_id=h.video_publication_id
      WHERE h.date=excluded.date AND h.release_generation=? AND h.page_publication_id=?
        AND h.video_publication_id=? AND h.video_manifest_digest=?
        AND p.state='published' AND v.state='published')`,
  ).bind(
    row.date, row.title, row.description, row.duration_seconds,
    row.mp4_key, row.mp4_sha256, row.mp4_size,
    row.poster_key, row.poster_sha256, row.poster_size,
    row.vtt_key, row.vtt_sha256, row.vtt_size,
    row.uploaded_at, row.updated_at,
    row.date, release.release_generation, release.page_publication_id,
    release.video_publication_id, release.video_manifest_digest,
    release.release_generation, release.page_publication_id,
    release.video_publication_id, release.video_manifest_digest,
  ).run();
}

async function markDailyPageVideoPublished(
  env: DailyVideoEnv,
  row: DailyVideoRow,
  release: { release_generation: number; page_publication_id: string; video_publication_id: string | null },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE daily_pages SET lastmod = ? WHERE date = ? AND EXISTS (
      SELECT 1 FROM daily_release_heads h
       JOIN append_only_publications p ON p.publication_id=h.page_publication_id
       JOIN append_only_publications v ON v.publication_id=h.video_publication_id
      WHERE h.date=? AND h.release_generation=? AND h.page_publication_id=?
        AND h.video_publication_id=? AND p.state='published' AND v.state='published')`,
  ).bind(
    row.updated_at, row.date, row.date, release.release_generation,
    release.page_publication_id, release.video_publication_id,
  ).run();
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

export async function handleDailyVideoUpload(request: Request, env: DailyVideoEnv): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, { Allow: 'POST' });
  if (!hasDailyVideoBearer(request, env.X_CARD_SHARED_TOKEN)) {
    return json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });
  }
  if (!env.READMES) return json({ error: 'R2 not configured' }, 503);
  const reservationEnabled = env.DAILY_PUBLICATION_RESERVATION_ENABLED === '1';
  const putEnabled = env.DAILY_PUBLICATION_PUT_ENABLED === '1';
  const promotionEnabled = env.DAILY_PUBLICATION_PROMOTION_ENABLED === '1';
  if ((putEnabled && !reservationEnabled) || (promotionEnabled && (!reservationEnabled || !putEnabled))) {
    return json({ error: 'invalid daily publication gates' }, 503);
  }
  if (!reservationEnabled || !putEnabled || !promotionEnabled) {
    return json({ error: 'daily publication disabled' }, 503);
  }

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
    const [mp4Hash, posterHash, vttHash] = await Promise.all([
      sha256Hex(mp4Bytes), sha256Hex(posterBytes), sha256Hex(vttBytes),
    ]);
    const current = await loadCurrentDailyReleaseForBuild(env as Env, parsed.date);
    if (!current) return json({ error: 'daily release not found' }, 409);
    const currentVideo = current.video;
    const proposedIdentity: DailyVideoRow = {
      date: parsed.date, title: parsed.title, description: parsed.description,
      duration_seconds: parsed.duration,
      mp4_key: '', mp4_sha256: mp4Hash, mp4_size: mp4Bytes.byteLength,
      poster_key: '', poster_sha256: posterHash, poster_size: posterBytes.byteLength,
      vtt_key: '', vtt_sha256: vttHash, vtt_size: vttBytes.byteLength,
      uploaded_at: '', updated_at: '',
    };
    if (sameUpload(currentVideo, proposedIdentity)) {
      await assertCurrentDailyReleaseAuthorization(env as Env, parsed.date, current.head);
      return json({ ok: true, unchanged: true, pagePatched: false, video: currentVideo }, 200);
    }
    const durationMillis = Math.round(parsed.duration * 1000);
    const videoBusinessRevision = await canonicalBusinessRevision({
      schema_version: 1, kind: 'daily_video', date: parsed.date,
      title: parsed.title, description: parsed.description, duration_millis: durationMillis,
      mp4_sha256: mp4Hash, mp4_size: mp4Bytes.byteLength,
      poster_sha256: posterHash, poster_size: posterBytes.byteLength,
      vtt_sha256: vttHash, vtt_size: vttBytes.byteLength,
      base_release_generation: current.head.release_generation,
      base_page_publication_id: current.head.page_publication_id,
    });
    const videoReservation = await reserveAppendOnlyPublication({ DB: env.DB }, {
      publication_date: parsed.date, publication_type: 'video',
      business_revision_id: videoBusinessRevision,
      objects: [
        { object_role: 'mp4', mime: 'video/mp4', bytes: mp4Bytes },
        { object_role: 'poster', mime: 'image/jpeg', bytes: posterBytes },
        { object_role: 'vtt', mime: 'text/vtt; charset=utf-8', bytes: vttBytes },
      ],
      metadata: {
        title: parsed.title, description: parsed.description, duration_millis: durationMillis,
      },
      release_binding: { base_release_generation: current.head.release_generation },
    });
    const stableTimestamp = `${parsed.date}T00:00:00.000Z`;
    const videoPublicationId = videoReservation.reservation.publication_id;
    const row: DailyVideoRow = {
      date: parsed.date,
      title: parsed.title,
      description: parsed.description,
      duration_seconds: parsed.duration,
      mp4_key: `daily-video/public/${videoPublicationId}/mp4`,
      mp4_sha256: mp4Hash,
      mp4_size: mp4Bytes.byteLength,
      poster_key: `daily-video/public/${videoPublicationId}/poster`,
      poster_sha256: posterHash,
      poster_size: posterBytes.byteLength,
      vtt_key: `daily-video/public/${videoPublicationId}/vtt`,
      vtt_sha256: vttHash,
      vtt_size: vttBytes.byteLength,
      uploaded_at: stableTimestamp,
      updated_at: stableTimestamp,
    };

    const currentPage = await readAuthorizedDailyPage(env as Env, parsed.date);
    const patchedHtml = patchDailyPageVideoHtml(
      new TextDecoder().decode(currentPage.bytes), row, env as Env,
    );
    const pageBytes = new TextEncoder().encode(patchedHtml);
    const pageBusinessRevision = await canonicalBusinessRevision({
      schema_version: 1, kind: 'daily_page_video_joint', date: parsed.date,
      html: patchedHtml, video_publication_id: videoPublicationId,
      video_manifest_digest: videoReservation.reservation.manifest.manifest_digest,
      base_release_generation: current.head.release_generation,
      base_page_publication_id: current.head.page_publication_id,
    });
    const pageReservation = await reserveAppendOnlyPublication({ DB: env.DB }, {
      publication_date: parsed.date, publication_type: 'page',
      business_revision_id: pageBusinessRevision,
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: pageBytes }],
      metadata: current.page_metadata,
      formal_news_item_ids: current.formal_news_item_ids,
      formal_guard_expected: current.formal_guard_expected,
      review_batch: current.review_batch,
      release_binding: {
        video_mode: 'joint_new',
        bound_video_publication_id: videoPublicationId,
        bound_video_digest: videoReservation.reservation.manifest.manifest_digest,
        base_release_generation: current.head.release_generation,
        base_page_publication_id: current.head.page_publication_id,
        base_video_publication_id: current.head.video_publication_id,
        base_video_digest: current.head.video_manifest_digest,
      },
    });
    await materializeAppendOnlyPublication(env as Env, videoReservation.reservation, {
      mp4: mp4Bytes, poster: posterBytes, vtt: vttBytes,
    });
    await materializeAppendOnlyPublication(env as Env, pageReservation.reservation, { html: pageBytes });
    const release = await promoteDailyRelease(env as Env, pageReservation.reservation.publication_id);
    const now = new Date(release.promoted_at_ms).toISOString();
    row.uploaded_at = now;
    row.updated_at = now;
    await upsertMetadata(env, row, release);
    await markDailyPageVideoPublished(env, row, release);
    await assertCurrentDailyReleaseAuthorization(env as Env, row.date, release);
    await submitDailyVideoIndexNow(env, row.date);
    // The HTTP callback can race a head/source/manual-proof/review mutation.
    // A successful upload response therefore requires a post-attempt reread too.
    await assertCurrentDailyReleaseAuthorization(env as Env, row.date, release);

    return json({ ok: true, unchanged: false, pagePatched: true, video: row }, currentVideo ? 200 : 201);
  } catch (error) {
    console.error(`[daily-video] upload failed: ${String(error).slice(0, 240)}`);
    return json({ error: 'daily video upload failed' }, 500);
  }
}
