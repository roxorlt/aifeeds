import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  DAILY_VIDEO_LIMITS,
  drainDailyVideoGc,
  handleDailyVideoUpload,
  validateDailyVideoFileMeta,
  type DailyVideoRow,
} from './daily-video';

const SITE = 'https://ai-feeds.com';
const API = 'https://api.ai-feeds.com';
const TOKEN = 'shared-secret';

function jpeg(width = 1600, height = 900): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function uploadForm(over: Partial<Record<'date' | 'title' | 'description' | 'duration', string>> = {}): FormData {
  const form = new FormData();
  form.set('date', over.date ?? '2026-07-14');
  form.set('title', over.title ?? 'AI 日报视频');
  form.set('description', over.description ?? '今日 AI 资讯视频摘要');
  form.set('duration', over.duration ?? '125.25');
  form.set('mp4', new File([new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112, 1, 2, 3])], 'daily.mp4', { type: 'video/mp4' }));
  form.set('poster', new File([jpeg()], 'poster.jpg', { type: 'image/jpeg' }));
  form.set('vtt', new File(['WEBVTT\n\n00:00.000 --> 00:01.000\n你好\n'], 'captions.vtt', { type: 'text/vtt' }));
  return form;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

interface Event { kind: string; key?: string; sql?: string; args?: unknown[] }

function makeR2(events: Event[] = []) {
  const store = new Map<string, ArrayBuffer | string>();
  const failDeletes = new Set<string>();
  return {
    store,
    failDeletes,
    async head(key: string) {
      return store.has(key) ? { key } : null;
    },
    async get(key: string) {
      if (!store.has(key)) return null;
      const value = store.get(key)!;
      return { body: value, async text() { return String(value); } };
    },
    async put(key: string, value: ArrayBuffer | string) {
      events.push({ kind: 'put', key });
      store.set(key, value);
    },
    async delete(key: string) {
      events.push({ kind: 'delete', key });
      if (failDeletes.has(key)) throw new Error(`R2 delete failed: ${key}`);
      store.delete(key);
    },
  };
}

function seedDailyPage(r2: ReturnType<typeof makeR2>, date = '2026-07-14'): void {
  r2.store.set(
    `daily/${date}.html`,
    '<!doctype html><html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage"}</script></head><body><main>daily</main></body></html>',
  );
}

function makeDb(events: Event[] = [], initial: DailyVideoRow | null = null, failUpsert = false) {
  let row = initial;
  const gc = new Map<string, { r2_key: string; delete_after: string; enqueued_at: string }>();
  const db = {
    get row() { return row; },
    get gc() { return gc; },
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          binds = args;
          return stmt;
        },
        async first<T>() {
          if (/SELECT 1 AS referenced/i.test(sql)) {
            const currentKeys = row ? [row.mp4_key, row.poster_key, row.vtt_key] : [];
            return (binds.some((key) => currentKeys.includes(String(key))) ? { referenced: 1 } : null) as T | null;
          }
          if (/FROM daily_videos/i.test(sql)) return row as T | null;
          return null as T | null;
        },
        async all<T>() {
          if (/FROM daily_video_gc/i.test(sql)) {
            const [now, limit] = binds as [string, number];
            const results = [...gc.values()]
              .filter((item) => item.delete_after <= now)
              .sort((a, b) => a.delete_after.localeCompare(b.delete_after))
              .slice(0, limit) as T[];
            return { results };
          }
          return { results: [] as T[] };
        },
        async run() {
          if (/INSERT INTO daily_videos/i.test(sql)) {
            events.push({ kind: 'upsert' });
            if (failUpsert) throw new Error('D1 unavailable');
            const [
              date, title, description, duration_seconds,
              mp4_key, mp4_sha256, mp4_size,
              poster_key, poster_sha256, poster_size,
              vtt_key, vtt_sha256, vtt_size,
              uploaded_at, updated_at,
            ] = binds;
            row = {
              date, title, description, duration_seconds,
              mp4_key, mp4_sha256, mp4_size,
              poster_key, poster_sha256, poster_size,
              vtt_key, vtt_sha256, vtt_size,
              uploaded_at, updated_at,
            } as DailyVideoRow;
          }
          if (/INSERT INTO daily_video_gc/i.test(sql)) {
            const [r2_key, delete_after, enqueued_at] = binds as [string, string, string];
            events.push({ kind: 'gc-enqueue', key: r2_key, sql, args: [...binds] });
            gc.set(r2_key, { r2_key, delete_after, enqueued_at });
          }
          if (/DELETE FROM daily_video_gc/i.test(sql)) {
            const r2Key = String(binds[0]);
            events.push({ kind: 'gc-dequeue', key: r2Key, sql, args: [...binds] });
            gc.delete(r2Key);
          }
          if (/UPDATE daily_pages/i.test(sql)) events.push({ kind: 'daily-page-update', sql, args: [...binds] });
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return db;
}

function makeEnv(db: unknown = makeDb(), r2: unknown = makeR2()) {
  return {
    DB: db,
    READMES: r2,
    SITE_BASE: SITE,
    API_BASE: API,
    X_CARD_SHARED_TOKEN: TOKEN,
  };
}

function request(form: FormData, token: string | null = TOKEN): Request {
  const headers = token === null ? undefined : { Authorization: `Bearer ${token}` };
  return new Request(`${API}/api/digest/daily-video`, { method: 'POST', headers, body: form });
}

describe('daily video upload authentication and validation', () => {
  test('missing or invalid shared bearer token returns 401 before reading multipart', async () => {
    for (const token of [null, 'wrong']) {
      const resp = await handleDailyVideoUpload(request(uploadForm(), token), makeEnv() as never);
      expect(resp.status).toBe(401);
      expect(resp.headers.get('WWW-Authenticate')).toBe('Bearer');
    }
  });

  test('invalid calendar date and duration return 400', async () => {
    const badDate = await handleDailyVideoUpload(request(uploadForm({ date: '2026-02-30' })), makeEnv() as never);
    expect(badDate.status).toBe(400);
    expect(await badDate.text()).toContain('date');

    const badDuration = await handleDailyVideoUpload(request(uploadForm({ duration: '0' })), makeEnv() as never);
    expect(badDuration.status).toBe(400);
    expect(await badDuration.text()).toContain('duration');
  });

  test('file metadata validator rejects wrong MIME, empty files and configured size overflow', () => {
    expect(validateDailyVideoFileMeta('mp4', 10, 'application/octet-stream')).toMatchObject({ ok: false });
    expect(validateDailyVideoFileMeta('poster', 0, 'image/jpeg')).toMatchObject({ ok: false });
    expect(validateDailyVideoFileMeta('vtt', DAILY_VIDEO_LIMITS.vtt + 1, 'text/vtt')).toMatchObject({ ok: false });
    expect(validateDailyVideoFileMeta('mp4', 10, 'video/mp4')).toEqual({ ok: true });
  });

  test('mp4 limit is 64 MiB with an inclusive upper boundary', () => {
    const limit = 64 * 1024 * 1024;
    expect(DAILY_VIDEO_LIMITS.mp4).toBe(limit);
    expect(validateDailyVideoFileMeta('mp4', limit, 'video/mp4')).toEqual({ ok: true });
    expect(validateDailyVideoFileMeta('mp4', limit + 1, 'video/mp4')).toEqual({ ok: false, error: 'mp4 is too large' });
  });

  test('poster dimensions must be 16:9', async () => {
    const form = uploadForm();
    form.set('poster', new File([jpeg(1200, 900)], 'poster.jpg', { type: 'image/jpeg' }));
    const resp = await handleDailyVideoUpload(request(form), makeEnv() as never);
    expect(resp.status).toBe(400);
    expect(await resp.text()).toContain('16:9');
  });
});

describe('daily video content-addressed persistence', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('missing daily HTML returns 409 before any media put or D1 upsert', async () => {
    const events: Event[] = [];
    const r2 = makeR2(events);
    const db = makeDb(events);

    const resp = await handleDailyVideoUpload(request(uploadForm()), makeEnv(db, r2) as never);

    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({ error: 'daily page not found' });
    expect(events.filter((event) => event.kind === 'put')).toHaveLength(0);
    expect(events.filter((event) => event.kind === 'upsert')).toHaveLength(0);
    expect(db.row).toBeNull();
  });

  test('multipart upload writes SHA-256 immutable keys and upserts complete D1 metadata', async () => {
    vi.setSystemTime(new Date('2026-07-14T08:09:10.000Z'));
    const events: Event[] = [];
    const r2 = makeR2(events);
    seedDailyPage(r2);
    const db = makeDb(events);
    const form = uploadForm();
    const mp4 = form.get('mp4') as unknown as File;
    const poster = form.get('poster') as unknown as File;
    const vtt = form.get('vtt') as unknown as File;
    const hashes = await Promise.all([mp4, poster, vtt].map(async (f) => sha256(await f.arrayBuffer())));

    const resp = await handleDailyVideoUpload(request(form), makeEnv(db, r2) as never);
    expect(resp.status).toBe(201);
    const body = await resp.json() as { ok: boolean; video: DailyVideoRow };
    expect(body.ok).toBe(true);
    expect(body.video.mp4_key).toBe(`daily-video/2026-07-14/${hashes[0]}.mp4`);
    expect(body.video.poster_key).toBe(`daily-video/2026-07-14/${hashes[1]}.jpg`);
    expect(body.video.vtt_key).toBe(`daily-video/2026-07-14/${hashes[2]}.vtt`);
    expect(body.video.duration_seconds).toBe(125.25);
    expect(body.video.uploaded_at).toBe('2026-07-14T08:09:10.000Z');
    expect(r2.store.has(body.video.mp4_key)).toBe(true);
    expect(db.row).toMatchObject(body.video);
    expect(events.map((e) => e.kind)).toContain('upsert');
  });

  test('same content is idempotent: existing immutable objects are not rewritten or deleted', async () => {
    const events: Event[] = [];
    const r2 = makeR2(events);
    seedDailyPage(r2);
    const db = makeDb(events);
    const env = makeEnv(db, r2);

    const first = await handleDailyVideoUpload(request(uploadForm()), env as never);
    expect(first.status).toBe(201);
    events.length = 0;
    const second = await handleDailyVideoUpload(request(uploadForm()), env as never);
    expect(second.status).toBe(200);
    const body = await second.json() as { unchanged: boolean };
    expect(body.unchanged).toBe(true);
    expect(events.filter((e) => e.kind === 'put')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'delete')).toHaveLength(0);
  });

  test('replacement queues superseded keys for at least 48 hours without deleting R2 objects', async () => {
    vi.setSystemTime(new Date('2026-07-14T08:09:10.000Z'));
    const events: Event[] = [];
    const old: DailyVideoRow = {
      date: '2026-07-14', title: 'old', description: 'old', duration_seconds: 1,
      mp4_key: 'daily-video/2026-07-14/old.mp4', mp4_sha256: 'old', mp4_size: 1,
      poster_key: 'daily-video/2026-07-14/old.jpg', poster_sha256: 'old', poster_size: 1,
      vtt_key: 'daily-video/2026-07-14/old.vtt', vtt_sha256: 'old', vtt_size: 1,
      uploaded_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z',
    };
    const r2 = makeR2(events);
    seedDailyPage(r2);
    r2.store.set(old.mp4_key, new ArrayBuffer(1));
    r2.store.set(old.poster_key, new ArrayBuffer(1));
    r2.store.set(old.vtt_key, new ArrayBuffer(1));
    const db = makeDb(events, old);

    const resp = await handleDailyVideoUpload(request(uploadForm({ title: 'new' })), makeEnv(db, r2) as never);
    expect(resp.status).toBe(200);
    const upsertAt = events.findIndex((e) => e.kind === 'upsert');
    const gcEvents = events.filter((event) => event.kind === 'gc-enqueue');
    expect(upsertAt).toBeGreaterThanOrEqual(0);
    expect(events.findIndex((event) => event.kind === 'gc-enqueue')).toBeGreaterThan(upsertAt);
    expect(gcEvents.map((event) => event.key).sort()).toEqual(
      [old.mp4_key, old.poster_key, old.vtt_key].sort(),
    );
    expect(gcEvents.every((event) => event.args?.[1] === '2026-07-16T08:09:10.000Z')).toBe(true);
    expect(events.filter((event) => event.kind === 'delete')).toHaveLength(0);
    expect(r2.store.has(old.mp4_key)).toBe(true);
    expect(r2.store.has(old.poster_key)).toBe(true);
    expect(r2.store.has(old.vtt_key)).toBe(true);
  });

  test('D1 upsert failure leaves historical HTML untouched and keeps all superseded objects', async () => {
    const events: Event[] = [];
    const old = {
      date: '2026-07-14', title: 'old', description: 'old', duration_seconds: 1,
      mp4_key: 'old.mp4', mp4_sha256: 'old', mp4_size: 1,
      poster_key: 'old.jpg', poster_sha256: 'old', poster_size: 1,
      vtt_key: 'old.vtt', vtt_sha256: 'old', vtt_size: 1,
      uploaded_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T00:00:00.000Z',
    } satisfies DailyVideoRow;
    const r2 = makeR2(events);
    const original = '<!doctype html><html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage"}</script></head><body><main>old</main></body></html>';
    r2.store.set('daily/2026-07-14.html', original);
    const resp = await handleDailyVideoUpload(
      request(uploadForm()),
      makeEnv(makeDb(events, old, true), r2) as never,
    );
    expect(resp.status).toBe(500);
    expect(r2.store.get('daily/2026-07-14.html')).toBe(original);
    expect(events.some((event) => event.kind === 'put' && event.key === 'daily/2026-07-14.html')).toBe(false);
    expect(events.filter((e) => e.kind === 'daily-page-update')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'delete')).toHaveLength(0);
  });

  test('upload activates D1 metadata before patching an existing historical daily snapshot', async () => {
    const events: Event[] = [];
    const r2 = makeR2(events);
    const original = '<!doctype html><html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage","name":"old"}</script></head><body><main><p>历史正文</p></main></body></html>';
    r2.store.set('daily/2026-07-14.html', original);
    const db = makeDb(events);

    const resp = await handleDailyVideoUpload(request(uploadForm()), makeEnv(db, r2) as never);
    expect(resp.status).toBe(201);
    expect(await resp.json()).toMatchObject({ ok: true, pagePatched: true });
    const patched = String(r2.store.get('daily/2026-07-14.html'));
    expect(patched).toContain('daily-video:player:start');
    expect(patched).toContain('daily-video:json-ld:start');
    expect(patched).toContain('<p>历史正文</p>');
    const pagePutAt = events.findIndex((e) => e.kind === 'put' && e.key === 'daily/2026-07-14.html');
    const upsertAt = events.findIndex((e) => e.kind === 'upsert');
    expect(pagePutAt).toBeGreaterThanOrEqual(0);
    expect(pagePutAt).toBeGreaterThan(upsertAt);
  });

  test('patched page timestamps are updated and IndexNow receives the watch page plus discovery URLs', async () => {
    const events: Event[] = [];
    const r2 = makeR2(events);
    r2.store.set(
      'daily/2026-07-14.html',
      '<!doctype html><html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage"}</script></head><body><main>x</main></body></html>',
    );
    const db = makeDb(events);
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { ...makeEnv(db, r2), INDEXNOW_KEY: 'index-key' };

    const resp = await handleDailyVideoUpload(request(uploadForm()), env as never);
    expect(resp.status).toBe(201);
    const pageUpdate = events.find((event) => event.kind === 'daily-page-update');
    expect(pageUpdate).toBeTruthy();
    expect(pageUpdate!.sql).toMatch(/SET lastmod = \? WHERE date = \?/);
    expect(pageUpdate!.sql).not.toContain('generated_at');
    expect(pageUpdate!.args).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).urlList).toEqual([
      `${SITE}/daily/2026-07-14`,
      `${SITE}/video/daily/2026-07-14`,
      `${SITE}/video-sitemap.xml`,
      `${SITE}/sitemap-daily.xml`,
      `${SITE}/sitemap.xml`,
    ]);
  });
});

describe('daily video garbage collection', () => {
  test('drain deletes only expired unreferenced keys up to the limit, then removes their queue rows', async () => {
    const events: Event[] = [];
    const r2 = makeR2(events);
    const db = makeDb(events);
    for (const key of ['expired-a.mp4', 'expired-b.mp4', 'future.mp4']) {
      r2.store.set(key, new ArrayBuffer(1));
    }
    db.gc.set('expired-a.mp4', {
      r2_key: 'expired-a.mp4', delete_after: '2026-07-13T00:00:00.000Z', enqueued_at: '2026-07-11T00:00:00.000Z',
    });
    db.gc.set('expired-b.mp4', {
      r2_key: 'expired-b.mp4', delete_after: '2026-07-13T01:00:00.000Z', enqueued_at: '2026-07-11T01:00:00.000Z',
    });
    db.gc.set('future.mp4', {
      r2_key: 'future.mp4', delete_after: '2026-07-15T00:00:00.000Z', enqueued_at: '2026-07-13T00:00:00.000Z',
    });

    await drainDailyVideoGc(makeEnv(db, r2) as never, {
      limit: 1,
      now: new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(events.filter((event) => event.kind === 'delete').map((event) => event.key)).toEqual(['expired-a.mp4']);
    expect(events.findIndex((event) => event.kind === 'gc-dequeue')).toBeGreaterThan(
      events.findIndex((event) => event.kind === 'delete'),
    );
    expect(db.gc.has('expired-a.mp4')).toBe(false);
    expect(db.gc.has('expired-b.mp4')).toBe(true);
    expect(db.gc.has('future.mp4')).toBe(true);
    expect(r2.store.has('expired-a.mp4')).toBe(false);
    expect(r2.store.has('expired-b.mp4')).toBe(true);
    expect(r2.store.has('future.mp4')).toBe(true);
  });

  test('drain clears a referenced key from the queue without deleting its R2 object', async () => {
    const events: Event[] = [];
    const current: DailyVideoRow = {
      date: '2026-07-14', title: 'current', description: 'current', duration_seconds: 1,
      mp4_key: 'still-current.mp4', mp4_sha256: 'current', mp4_size: 1,
      poster_key: 'current.jpg', poster_sha256: 'current', poster_size: 1,
      vtt_key: 'current.vtt', vtt_sha256: 'current', vtt_size: 1,
      uploaded_at: '2026-07-14T00:00:00.000Z', updated_at: '2026-07-14T00:00:00.000Z',
    };
    const r2 = makeR2(events);
    const db = makeDb(events, current);
    r2.store.set(current.mp4_key, new ArrayBuffer(1));
    db.gc.set(current.mp4_key, {
      r2_key: current.mp4_key, delete_after: '2026-07-13T00:00:00.000Z', enqueued_at: '2026-07-11T00:00:00.000Z',
    });

    await drainDailyVideoGc(makeEnv(db, r2) as never, {
      limit: 10,
      now: new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(events.some((event) => event.kind === 'delete' && event.key === current.mp4_key)).toBe(false);
    expect(events.some((event) => event.kind === 'gc-dequeue' && event.key === current.mp4_key)).toBe(true);
    expect(db.gc.has(current.mp4_key)).toBe(false);
    expect(r2.store.has(current.mp4_key)).toBe(true);
  });

  test('drain leaves the queue row intact when R2 deletion fails', async () => {
    const events: Event[] = [];
    const key = 'retry-later.mp4';
    const r2 = makeR2(events);
    const db = makeDb(events);
    r2.store.set(key, new ArrayBuffer(1));
    r2.failDeletes.add(key);
    db.gc.set(key, {
      r2_key: key, delete_after: '2026-07-13T00:00:00.000Z', enqueued_at: '2026-07-11T00:00:00.000Z',
    });

    await drainDailyVideoGc(makeEnv(db, r2) as never, {
      limit: 10,
      now: new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(events.some((event) => event.kind === 'delete' && event.key === key)).toBe(true);
    expect(events.some((event) => event.kind === 'gc-dequeue' && event.key === key)).toBe(false);
    expect(db.gc.has(key)).toBe(true);
    expect(r2.store.has(key)).toBe(true);
  });
});
