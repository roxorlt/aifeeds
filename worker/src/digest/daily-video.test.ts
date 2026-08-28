import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const publicationMocks = vi.hoisted(() => ({
  sequence: 0,
  current: null as any,
  pageHtml: '',
  reservations: new Map<string, any>(),
  materialized: [] as Array<{ type: string; publication_id: string; roles: string[] }>,
  finalAuthorization: vi.fn(async (..._args: any[]) => undefined),
  authorizationState: {
    sourceEnabled: true,
    registryIdentity: 'official-v1',
    manualProofNonce: 'proof-v1',
    batchRevision: 1,
  },
}));

vi.mock('./publication-storage', () => ({
  reserveAppendOnlyPublication: vi.fn(async (_env: unknown, input: any) => {
    const publication_id = (++publicationMocks.sequence).toString(16).padStart(64, '0');
    const roles = input.objects.map((object: any) => object.object_role);
    const reservation = {
      reservation_token: publication_id, publication_id,
      publication_date: input.publication_date, publication_type: input.publication_type,
      slot_no: 1, business_revision_id: input.business_revision_id, attempt_key: publication_id,
      manifest: {
        manifest_digest: publication_id,
        objects: roles.map((role: string) => ({ object_role: role, sha256: role.repeat(64).slice(0, 64) })),
      },
    };
    publicationMocks.reservations.set(publication_id, { input, reservation });
    return { status: 'reserved', reservation };
  }),
}));

vi.mock('./publication-release', () => ({
  loadCurrentDailyReleaseForBuild: vi.fn(async () => publicationMocks.current),
  readAuthorizedDailyPage: vi.fn(async () => {
    if (!publicationMocks.current) throw new Error('not found');
    return { bytes: new TextEncoder().encode(publicationMocks.pageHtml), release_generation: 1, metadata: {} };
  }),
  materializeAppendOnlyPublication: vi.fn(async (_env: unknown, reservation: any, bytes: any) => {
    publicationMocks.materialized.push({
      type: reservation.publication_type, publication_id: reservation.publication_id, roles: Object.keys(bytes),
    });
    if (reservation.publication_type === 'page') publicationMocks.pageHtml = new TextDecoder().decode(bytes.html);
  }),
  promoteDailyRelease: vi.fn(async (_env: unknown, pagePublicationId: string) => {
    const page = publicationMocks.reservations.get(pagePublicationId);
    const videoId = page.input.release_binding.bound_video_publication_id;
    const video = publicationMocks.reservations.get(videoId);
    const now = Date.now();
    const videoMetadata = video.input.metadata;
    const objectByRole = new Map(video.input.objects.map((object: any) => [object.object_role, object]));
    const row = {
      date: page.input.publication_date,
      title: videoMetadata.title,
      description: videoMetadata.description,
      duration_seconds: videoMetadata.duration_millis / 1000,
      mp4_key: `daily-video/public/${videoId}/mp4`,
      mp4_sha256: await crypto.subtle.digest('SHA-256', (objectByRole.get('mp4') as any).bytes).then((digest) =>
        [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('')),
      mp4_size: (objectByRole.get('mp4') as any).bytes.byteLength,
      poster_key: `daily-video/public/${videoId}/poster`,
      poster_sha256: await crypto.subtle.digest('SHA-256', (objectByRole.get('poster') as any).bytes).then((digest) =>
        [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('')),
      poster_size: (objectByRole.get('poster') as any).bytes.byteLength,
      vtt_key: `daily-video/public/${videoId}/vtt`,
      vtt_sha256: await crypto.subtle.digest('SHA-256', (objectByRole.get('vtt') as any).bytes).then((digest) =>
        [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('')),
      vtt_size: (objectByRole.get('vtt') as any).bytes.byteLength,
      uploaded_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
    };
    const head = {
      date: page.input.publication_date,
      release_generation: page.input.release_binding.base_release_generation + 1,
      page_publication_id: pagePublicationId, video_publication_id: videoId,
      video_mode: 'joint_new', page_manifest_digest: page.reservation.manifest.manifest_digest,
      video_manifest_digest: video.reservation.manifest.manifest_digest, promoted_at_ms: now,
    };
    publicationMocks.current = {
      head, page_metadata: page.input.metadata, formal_news_item_ids: page.input.formal_news_item_ids,
      formal_guard_expected: page.input.formal_guard_expected, review_batch: page.input.review_batch,
      video: row,
    };
    return { ...head, status: 'published' };
  }),
  assertCurrentDailyReleaseAuthorization: publicationMocks.finalAuthorization,
}));
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

beforeEach(() => {
  publicationMocks.sequence = 0;
  publicationMocks.current = null;
  publicationMocks.pageHtml = '';
  publicationMocks.reservations.clear();
  publicationMocks.materialized.length = 0;
  publicationMocks.authorizationState.sourceEnabled = true;
  publicationMocks.authorizationState.registryIdentity = 'official-v1';
  publicationMocks.authorizationState.manualProofNonce = 'proof-v1';
  publicationMocks.authorizationState.batchRevision = 1;
  publicationMocks.finalAuthorization.mockReset();
  publicationMocks.finalAuthorization.mockImplementation(async (_env, _date, expected) => {
    const current = publicationMocks.current?.head;
    if (!current || (expected && (
      current.release_generation !== expected.release_generation
      || current.page_publication_id !== expected.page_publication_id
      || current.page_manifest_digest !== expected.page_manifest_digest
      || current.video_publication_id !== expected.video_publication_id
      || current.video_manifest_digest !== expected.video_manifest_digest
    ))) throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE:head');
    if (!publicationMocks.authorizationState.sourceEnabled) {
      throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE:source_disabled');
    }
    if (publicationMocks.authorizationState.registryIdentity !== 'official-v1') {
      throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE:registry_identity');
    }
    if (publicationMocks.authorizationState.manualProofNonce !== 'proof-v1') {
      throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE:manual_proof');
    }
    if (publicationMocks.authorizationState.batchRevision !== 1) {
      throw new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE:review_batch');
    }
  });
});

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

function seedDailyPage(
  r2: ReturnType<typeof makeR2>,
  date = '2026-07-14',
  video: DailyVideoRow | null = null,
): void {
  publicationMocks.pageHtml = '<!doctype html><html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage"}</script></head><body><main>daily</main></body></html>';
  publicationMocks.current = {
    head: {
      date, release_generation: 1, page_publication_id: 'a'.repeat(64),
      video_publication_id: video ? 'c'.repeat(64) : null,
      video_mode: video ? 'joint_new' : 'none', page_manifest_digest: 'b'.repeat(64),
      video_manifest_digest: video ? 'd'.repeat(64) : null, promoted_at_ms: 1,
    },
    page_metadata: { title: 'AI Daily', item_count: 1 },
    formal_news_item_ids: [], formal_guard_expected: [], review_batch: null, video,
  };
  r2.store.set(`daily/${date}.html`, publicationMocks.pageHtml);
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
    DAILY_PUBLICATION_RESERVATION_ENABLED: '1',
    DAILY_PUBLICATION_PUT_ENABLED: '1',
    DAILY_PUBLICATION_PROMOTION_ENABLED: '1',
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

  test('missing unified daily release returns 409 before any publication or D1 upsert', async () => {
    const events: Event[] = [];
    const r2 = makeR2(events);
    const db = makeDb(events);

    const resp = await handleDailyVideoUpload(request(uploadForm()), makeEnv(db, r2) as never);

    expect(resp.status).toBe(409);
    expect(await resp.json()).toEqual({ error: 'daily release not found' });
    expect(events.filter((event) => event.kind === 'put')).toHaveLength(0);
    expect(events.filter((event) => event.kind === 'upsert')).toHaveLength(0);
    expect(db.row).toBeNull();
  });

  test('multipart upload publishes immutable virtual keys and upserts complete D1 metadata', async () => {
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
    const publicationId = body.video.mp4_key.split('/')[2];
    expect(body.video.mp4_key).toBe(`daily-video/public/${publicationId}/mp4`);
    expect(body.video.poster_key).toBe(`daily-video/public/${publicationId}/poster`);
    expect(body.video.vtt_key).toBe(`daily-video/public/${publicationId}/vtt`);
    expect(body.video).toMatchObject({
      mp4_sha256: hashes[0], poster_sha256: hashes[1], vtt_sha256: hashes[2],
    });
    expect(body.video.duration_seconds).toBe(125.25);
    expect(body.video.uploaded_at).toBe('2026-07-14T08:09:10.000Z');
    expect(publicationMocks.materialized).toEqual([
      { type: 'video', publication_id: publicationId, roles: ['mp4', 'poster', 'vtt'] },
      { type: 'page', publication_id: expect.any(String), roles: ['html'] },
    ]);
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

  test('replacement advances the unified head without enqueueing or deleting superseded objects', async () => {
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
    seedDailyPage(r2, '2026-07-14', old);
    r2.store.set(old.mp4_key, new ArrayBuffer(1));
    r2.store.set(old.poster_key, new ArrayBuffer(1));
    r2.store.set(old.vtt_key, new ArrayBuffer(1));
    const db = makeDb(events, old);

    const resp = await handleDailyVideoUpload(request(uploadForm({ title: 'new' })), makeEnv(db, r2) as never);
    expect(resp.status).toBe(200);
    const upsertAt = events.findIndex((e) => e.kind === 'upsert');
    expect(upsertAt).toBeGreaterThanOrEqual(0);
    expect(events.filter((event) => event.kind === 'gc-enqueue')).toHaveLength(0);
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
    seedDailyPage(r2, '2026-07-14', old);
    publicationMocks.pageHtml = original;
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

  test('upload materializes video and patched page before the unified head promotion projection', async () => {
    const events: Event[] = [];
    const r2 = makeR2(events);
    const original = '<!doctype html><html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage","name":"old"}</script></head><body><main><p>历史正文</p></main></body></html>';
    seedDailyPage(r2);
    publicationMocks.pageHtml = original;
    r2.store.set('daily/2026-07-14.html', original);
    const db = makeDb(events);

    const resp = await handleDailyVideoUpload(request(uploadForm()), makeEnv(db, r2) as never);
    expect(resp.status).toBe(201);
    expect(await resp.json()).toMatchObject({ ok: true, pagePatched: true });
    const patched = publicationMocks.pageHtml;
    expect(patched).toContain('daily-video:player:start');
    expect(patched).toContain('daily-video:json-ld:start');
    expect(patched).toContain('<p>历史正文</p>');
    expect(publicationMocks.materialized.map((entry) => entry.type)).toEqual(['video', 'page']);
    expect(events.filter((event) => event.kind === 'put')).toHaveLength(0);
    expect(events.filter((event) => event.kind === 'upsert')).toHaveLength(1);
  });

  test('patched page timestamps are updated and IndexNow receives the watch page plus discovery URLs', async () => {
    const uploadTime = new Date('2026-08-27T08:09:10.000Z');
    vi.setSystemTime(uploadTime);
    const events: Event[] = [];
    const r2 = makeR2(events);
    seedDailyPage(r2);
    publicationMocks.pageHtml = '<!doctype html><html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"CollectionPage"}</script></head><body><main>x</main></body></html>';
    const db = makeDb(events);
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = { ...makeEnv(db, r2), INDEXNOW_KEY: 'index-key' };

    const resp = await handleDailyVideoUpload(request(uploadForm()), env as never);
    expect(resp.status).toBe(201);
    const pageUpdate = events.find((event) => event.kind === 'daily-page-update');
    expect(pageUpdate).toBeTruthy();
    expect(pageUpdate!.sql).toMatch(/SET lastmod = \? WHERE date = \? AND EXISTS/);
    expect(pageUpdate!.sql).not.toContain('generated_at');
    expect(pageUpdate!.args).toHaveLength(6);
    expect(pageUpdate!.args?.slice(0, 2)).toEqual([
      uploadTime.toISOString(), '2026-07-14',
    ]);
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

  test('upload success and IndexNow are both suppressed when the authoritative final reread fails', async () => {
    const events: Event[] = [];
    const r2 = makeR2(events);
    seedDailyPage(r2);
    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    publicationMocks.finalAuthorization.mockRejectedValueOnce(
      new Error('PUBLICATION_OUTWARD_AUTHORIZATION_STALE:item_source_manual_proof_or_batch_mutated'),
    );

    const response = await handleDailyVideoUpload(
      request(uploadForm()),
      { ...makeEnv(makeDb(events), r2), INDEXNOW_KEY: 'index-key' } as never,
    );

    expect(response.status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test.each([
    ['head supersede', () => { publicationMocks.current.head.release_generation += 1; }],
    ['source disabled', () => { publicationMocks.authorizationState.sourceEnabled = false; }],
    ['registry identity changed', () => { publicationMocks.authorizationState.registryIdentity = 'radar-v2'; }],
    ['manual proof invalidated', () => { publicationMocks.authorizationState.manualProofNonce = 'proof-invalidated'; }],
    ['review batch superseded', () => { publicationMocks.authorizationState.batchRevision = 2; }],
  ])('IndexNow HTTP callback mutates concrete %s state: post-HTTP reread prevents upload success', async (_label, mutate) => {
    const events: Event[] = [];
    const r2 = makeR2(events);
    seedDailyPage(r2);
    const fetchMock = vi.fn(async () => {
      mutate();
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const response = await handleDailyVideoUpload(
      request(uploadForm()),
      { ...makeEnv(makeDb(events), r2), INDEXNOW_KEY: 'index-key' } as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(publicationMocks.finalAuthorization).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'daily video upload failed' });
  });
});

describe('daily video append-only retention', () => {
  test('the compatibility drain is inert and never deletes or dequeues historical objects', async () => {
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

    const result = await drainDailyVideoGc(makeEnv(db, r2) as never, {
      limit: 1,
      now: new Date('2026-07-14T00:00:00.000Z'),
    });

    expect(result).toEqual({ processed: 0, deleted: 0, clearedReferenced: 0, failed: 0 });
    expect(events.filter((event) => event.kind === 'delete')).toHaveLength(0);
    expect(events.filter((event) => event.kind === 'gc-dequeue')).toHaveLength(0);
    expect(db.gc.has('expired-a.mp4')).toBe(true);
    expect(db.gc.has('expired-b.mp4')).toBe(true);
    expect(db.gc.has('future.mp4')).toBe(true);
    expect(r2.store.has('expired-a.mp4')).toBe(true);
    expect(r2.store.has('expired-b.mp4')).toBe(true);
    expect(r2.store.has('future.mp4')).toBe(true);
  });
});
