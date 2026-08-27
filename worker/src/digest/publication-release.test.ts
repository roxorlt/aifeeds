import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { reserveAppendOnlyPublication, type PublicationR2Bucket } from './publication-storage';
import { authorizeFormalNewsSet } from './news-source-policy';
import { FEED_REGISTRY } from '../feeds/registry';
import {
  assertCurrentDailyReleaseSetAuthorization,
  materializeAppendOnlyPublication,
  listAuthorizedDailyReleaseSummaries,
  projectAuthorizedDailyPageCompatibility,
  promoteDailyRelease,
  readAuthorizedDailyPage,
  readAuthorizedDailyVideoObject,
} from './publication-release';

const here = path.dirname(fileURLToPath(import.meta.url));

function sqliteD1(sqlite: DatabaseSync, hooks?: { beforeExecute?: (sql: string) => void }) {
  return {
    prepare(sql: string) {
      let binds: SQLInputValue[] = [];
      const statement = {
        bind(...values: unknown[]) { binds = values as SQLInputValue[]; return statement; },
        async first<T>() { hooks?.beforeExecute?.(sql); return (sqlite.prepare(sql).get(...binds) || null) as T | null; },
        async all<T>() { hooks?.beforeExecute?.(sql); return { results: sqlite.prepare(sql).all(...binds) as T[] }; },
        async run() {
          hooks?.beforeExecute?.(sql);
          const result = sqlite.prepare(sql).run(...binds);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

function releaseDb(hooks?: { beforeExecute?: (sql: string) => void }): { sqlite: DatabaseSync; DB: D1Database } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE items(id TEXT PRIMARY KEY,source_type TEXT,source_id TEXT,source_ref TEXT,extra TEXT,deleted_at TEXT);
    CREATE TABLE sources(id TEXT PRIMARY KEY,source_type TEXT,source_ref TEXT,config TEXT);
    CREATE TABLE manual_news_leads(id TEXT PRIMARY KEY,review_date TEXT,status TEXT,confirmed_at INTEGER,version INTEGER);
    CREATE TABLE manual_news_assessment_verifications(
      verification_id TEXT PRIMARY KEY,lead_id TEXT,assessment_version INTEGER,policy_version TEXT,
      verification_key_id TEXT,canonical_digest TEXT,hmac_sha256 TEXT,verification_json TEXT,
      processing_owner TEXT,processing_attempt INTEGER,creation_nonce TEXT,status TEXT,reason TEXT,
      created_at INTEGER,invalidation_nonce TEXT,invalidated_at INTEGER);
    CREATE TABLE manual_news_event_assessments(lead_id TEXT,assessment_version INTEGER,assessment_json TEXT);
    CREATE TABLE daily_news_review_batches(
      review_date TEXT,lineage_id TEXT,batch_id TEXT,batch_revision INTEGER,is_current INTEGER,
      edit_revision INTEGER,candidate_generation INTEGER,candidate_ids TEXT,default_selected_ids TEXT,
      applied_selected_ids TEXT,selection_hash TEXT,superseded_by TEXT);
    CREATE TABLE daily_pages(
      date TEXT PRIMARY KEY,title TEXT,item_count INTEGER,generated_at TEXT,lastmod TEXT);
  `);
  sqlite.exec(readFileSync(path.resolve(here, '../../migrations/040-daily-release-publications.sql'), 'utf8'));
  sqlite.prepare(`UPDATE publication_storage_budget SET state='active',legacy_inventory_digest=?,
    legacy_inventory_object_count=0,legacy_inventory_at_ms=1,version=1,updated_at_ms=1 WHERE singleton_id=1`)
    .run('a'.repeat(64));
  return { sqlite, DB: sqliteD1(sqlite, hooks) as unknown as D1Database };
}

function r2Bucket() {
  const objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string>; mime: string }>();
  const put = vi.fn(async (
    key: string,
    value: Uint8Array | ArrayBuffer,
    options: { customMetadata: Record<string, string>; httpMetadata: { contentType: string } },
  ) => {
    const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0));
    objects.set(key, { bytes, metadata: { ...options.customMetadata }, mime: options.httpMetadata.contentType });
  });
  const head = vi.fn(async (key: string) => {
    const object = objects.get(key);
    return object ? {
      key, size: object.bytes.byteLength, customMetadata: object.metadata,
      httpMetadata: { contentType: object.mime },
    } : null;
  });
  const get = vi.fn(async (key: string) => {
    const object = objects.get(key);
    return object ? {
      ...await head(key),
      async arrayBuffer() { return object.bytes.slice().buffer; },
    } : null;
  });
  return { bucket: { head, put, get } as unknown as PublicationR2Bucket, objects, head, put, get };
}

function seedScheduledFormalItem(
  sqlite: DatabaseSync,
  feedId: string,
  itemId: string,
): void {
  const feed = FEED_REGISTRY.find((entry) => entry.id === feedId)!;
  sqlite.prepare(`INSERT OR IGNORE INTO sources(id,source_type,source_ref,config) VALUES(?,?,?,?)`)
    .run(feed.id, feed.kind, feed.key, JSON.stringify(feed));
  sqlite.prepare(`INSERT INTO items(id,source_type,source_id,source_ref,extra,deleted_at)
    VALUES(?,?,?,NULL,?,NULL)`).run(
    itemId, feed.kind, `${feed.key}:${itemId.split(':').at(-1)}`,
    JSON.stringify({ feed_id: feed.id, feed_key: feed.key, editorial_type: feed.editorial_type }),
  );
}

async function publishScheduledPage(
  fixture: { DB: D1Database },
  r2: ReturnType<typeof r2Bucket>,
  input: {
    date: string;
    itemId: string;
    revision: string;
    base?: Awaited<ReturnType<typeof promoteDailyRelease>>;
  },
) {
  const authorization = await authorizeFormalNewsSet(
    { DB: fixture.DB } as never, input.date, [input.itemId], 'release_set_test_reservation',
  );
  expect(authorization.allowed_ids).toEqual([input.itemId]);
  const bytes = new TextEncoder().encode(`<html>${input.date}:${input.revision[0]}</html>`);
  const page = await reserveAppendOnlyPublication({ DB: fixture.DB } as never, {
    publication_date: input.date,
    publication_type: 'page',
    business_revision_id: input.revision,
    objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes }],
    metadata: { title: `AI Daily ${input.date}`, item_count: 1 },
    formal_news_item_ids: [input.itemId],
    formal_guard_expected: JSON.parse(authorization.final_guard!.expected_json) as unknown[],
    release_binding: {
      video_mode: 'none',
      base_release_generation: input.base?.release_generation || 0,
      base_page_publication_id: input.base?.page_publication_id || null,
      base_video_publication_id: null,
      base_video_digest: null,
    },
  });
  await materializeAppendOnlyPublication(
    { DB: fixture.DB, READMES: r2.bucket } as never, page.reservation, { html: bytes },
  );
  const release = await promoteDailyRelease(
    { DB: fixture.DB, READMES: r2.bucket } as never, page.reservation.publication_id,
  );
  return { page, release };
}

describe('append-only daily release state machine', () => {
  test('publishes an initial no-video page only after durable graph, immutable PUT, and exact head CAS', async () => {
    const { sqlite, DB } = releaseDb();
    const r2 = r2Bucket();
    const bytes = new TextEncoder().encode('<html>authorized</html>');
    const reserved = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page',
      business_revision_id: 'b'.repeat(64), objects: [
        { object_role: 'html', mime: 'text/html; charset=utf-8', bytes },
      ],
      metadata: { title: 'AI Daily', item_count: 1 },
      formal_news_item_ids: [], formal_guard_expected: [],
      release_binding: { video_mode: 'none', base_release_generation: 0 },
    });

    await materializeAppendOnlyPublication(
      { DB, READMES: r2.bucket } as never,
      reserved.reservation,
      { html: bytes },
    );
    expect(sqlite.prepare(`SELECT state FROM append_only_publications`).get()).toEqual({ state: 'put_verified' });
    expect(r2.put).toHaveBeenCalledTimes(1);

    const promoted = await promoteDailyRelease(
      { DB, READMES: r2.bucket } as never,
      reserved.reservation.publication_id,
    );
    expect(promoted).toMatchObject({ status: 'published', release_generation: 1, video_mode: 'none' });
    expect(sqlite.prepare(`SELECT state FROM append_only_publications`).get()).toEqual({ state: 'published' });
    expect(sqlite.prepare(`SELECT state FROM append_only_publication_objects`).get())
      .toEqual({ state: 'publication_bound' });

    const outward = await readAuthorizedDailyPage(
      { DB, READMES: r2.bucket } as never,
      '2026-08-27',
    );
    expect(new TextDecoder().decode(outward.bytes)).toBe('<html>authorized</html>');
    expect(outward.release_generation).toBe(1);
    expect('delete' in r2.bucket).toBe(false);
  });

  test('replays an exact committed head after a crash before publication finalization', async () => {
    let failFinalizeOnce = true;
    const { sqlite, DB } = releaseDb({ beforeExecute(sql) {
      if (!failFinalizeOnce || !sql.includes("UPDATE append_only_publications SET state='published'")) return;
      failFinalizeOnce = false;
      throw new Error('simulated finalize crash');
    } });
    const r2 = r2Bucket();
    const bytes = new TextEncoder().encode('<html>recover exact head</html>');
    const reserved = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page',
      business_revision_id: '0'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes }],
      formal_news_item_ids: [], formal_guard_expected: [],
      release_binding: { video_mode: 'none', base_release_generation: 0 },
    });
    await materializeAppendOnlyPublication(
      { DB, READMES: r2.bucket } as never, reserved.reservation, { html: bytes },
    );

    await expect(promoteDailyRelease(
      { DB, READMES: r2.bucket } as never, reserved.reservation.publication_id,
    )).rejects.toThrow('simulated finalize crash');
    expect(sqlite.prepare(`SELECT page_publication_id FROM daily_release_heads`).get())
      .toEqual({ page_publication_id: reserved.reservation.publication_id });
    expect(sqlite.prepare(`SELECT state FROM append_only_publications`).get())
      .toEqual({ state: 'put_verified' });

    await expect(promoteDailyRelease(
      { DB, READMES: r2.bucket } as never, reserved.reservation.publication_id,
    )).resolves.toMatchObject({ status: 'replayed', release_generation: 1 });
    const outward = await readAuthorizedDailyPage(
      { DB, READMES: r2.bucket } as never, '2026-08-27',
    );
    expect(new TextDecoder().decode(outward.bytes)).toBe('<html>recover exact head</html>');
  });

  test('jointly publishes a new video, then page-only rerender reuses the exact current video', async () => {
    const { sqlite, DB } = releaseDb();
    const r2 = r2Bucket();
    const videoBytes = {
      mp4: new Uint8Array([1, 2, 3]),
      poster: new Uint8Array([4, 5]),
      vtt: new TextEncoder().encode('WEBVTT\n'),
    };
    const video = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'video',
      business_revision_id: 'c'.repeat(64),
      objects: [
        { object_role: 'mp4', mime: 'video/mp4', bytes: videoBytes.mp4 },
        { object_role: 'poster', mime: 'image/jpeg', bytes: videoBytes.poster },
        { object_role: 'vtt', mime: 'text/vtt; charset=utf-8', bytes: videoBytes.vtt },
      ],
      metadata: { title: 'Video', description: 'Exact', duration_seconds: 42 },
      release_binding: { base_release_generation: 0 },
    });
    const firstHtml = new TextEncoder().encode('<html>video one</html>');
    const firstPage = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page',
      business_revision_id: 'd'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: firstHtml }],
      formal_news_item_ids: [], formal_guard_expected: [],
      release_binding: {
        video_mode: 'joint_new', base_release_generation: 0,
        bound_video_publication_id: video.reservation.publication_id,
        bound_video_digest: video.reservation.manifest.manifest_digest,
      },
    });
    await materializeAppendOnlyPublication({ DB, READMES: r2.bucket } as never, video.reservation, videoBytes);
    await materializeAppendOnlyPublication({ DB, READMES: r2.bucket } as never, firstPage.reservation, { html: firstHtml });
    const initial = await promoteDailyRelease({ DB, READMES: r2.bucket } as never, firstPage.reservation.publication_id);
    expect(initial).toMatchObject({ release_generation: 1, video_mode: 'joint_new',
      video_publication_id: video.reservation.publication_id });

    const putCountBeforeRerender = r2.put.mock.calls.length;
    const secondHtml = new TextEncoder().encode('<html>page-only rerender</html>');
    const secondPage = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page',
      business_revision_id: 'e'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: secondHtml }],
      formal_news_item_ids: [], formal_guard_expected: [],
      release_binding: {
        video_mode: 'reuse_current', base_release_generation: 1,
        base_page_publication_id: firstPage.reservation.publication_id,
        base_video_publication_id: video.reservation.publication_id,
        base_video_digest: video.reservation.manifest.manifest_digest,
        bound_video_publication_id: video.reservation.publication_id,
        bound_video_digest: video.reservation.manifest.manifest_digest,
      },
    });
    await materializeAppendOnlyPublication({ DB, READMES: r2.bucket } as never, secondPage.reservation, { html: secondHtml });
    const rerender = await promoteDailyRelease({ DB, READMES: r2.bucket } as never, secondPage.reservation.publication_id);
    expect(rerender).toMatchObject({ release_generation: 2, video_mode: 'reuse_current',
      video_publication_id: video.reservation.publication_id });
    expect(r2.put.mock.calls.length).toBe(putCountBeforeRerender + 1);
    expect(sqlite.prepare(`SELECT state FROM append_only_publications WHERE publication_id=?`)
      .get(video.reservation.publication_id)).toEqual({ state: 'published' });

    const invalidNoneBytes = new TextEncoder().encode('<html>must not remove video</html>');
    const invalidNone = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page',
      business_revision_id: 'f'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: invalidNoneBytes }],
      formal_news_item_ids: [], formal_guard_expected: [],
      release_binding: {
        video_mode: 'none', base_release_generation: 2,
        base_page_publication_id: secondPage.reservation.publication_id,
        base_video_publication_id: video.reservation.publication_id,
        base_video_digest: video.reservation.manifest.manifest_digest,
      },
    });
    await materializeAppendOnlyPublication(
      { DB, READMES: r2.bucket } as never, invalidNone.reservation, { html: invalidNoneBytes },
    );
    await expect(promoteDailyRelease({ DB, READMES: r2.bucket } as never, invalidNone.reservation.publication_id))
      .rejects.toThrow('PUBLICATION_NONE_CANNOT_REMOVE_VIDEO');
  });

  test('none cannot remove an existing video and concurrent base publishers have one winner', async () => {
    const { DB } = releaseDb();
    const r2 = r2Bucket();
    const initialBytes = new TextEncoder().encode('initial');
    const initial = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page', business_revision_id: '1'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: initialBytes }],
      formal_news_item_ids: [], formal_guard_expected: [], release_binding: { video_mode: 'none' },
    });
    await materializeAppendOnlyPublication({ DB, READMES: r2.bucket } as never, initial.reservation, { html: initialBytes });
    await promoteDailyRelease({ DB, READMES: r2.bucket } as never, initial.reservation.publication_id);

    const contenders = [];
    for (const [revision, text] of [['2'.repeat(64), 'winner'], ['3'.repeat(64), 'loser']] as const) {
      const bytes = new TextEncoder().encode(text);
      const reserved = await reserveAppendOnlyPublication({ DB } as never, {
        publication_date: '2026-08-27', publication_type: 'page', business_revision_id: revision,
        objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes }],
        formal_news_item_ids: [], formal_guard_expected: [],
        release_binding: { video_mode: 'none', base_release_generation: 1,
          base_page_publication_id: initial.reservation.publication_id },
      });
      await materializeAppendOnlyPublication({ DB, READMES: r2.bucket } as never, reserved.reservation, { html: bytes });
      contenders.push(reserved.reservation);
    }
    await promoteDailyRelease({ DB, READMES: r2.bucket } as never, contenders[0].publication_id);
    await expect(promoteDailyRelease({ DB, READMES: r2.bucket } as never, contenders[1].publication_id))
      .rejects.toThrow('PUBLICATION_BASE_RELEASE_STALE');
    const outward = await readAuthorizedDailyPage({ DB, READMES: r2.bucket } as never, '2026-08-27');
    expect(new TextDecoder().decode(outward.bytes)).toBe('winner');
  });

  test('full-byte corruption after PUT prevents promotion and leaves no public head', async () => {
    const { DB } = releaseDb();
    const r2 = r2Bucket();
    const bytes = new TextEncoder().encode('correct');
    const page = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page', business_revision_id: '4'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes }],
      formal_news_item_ids: [], formal_guard_expected: [], release_binding: { video_mode: 'none' },
    });
    await materializeAppendOnlyPublication({ DB, READMES: r2.bucket } as never, page.reservation, { html: bytes });
    const key = page.reservation.manifest.objects[0].r2_key;
    r2.objects.get(key)!.bytes = new TextEncoder().encode('corrupt');
    await expect(promoteDailyRelease({ DB, READMES: r2.bucket } as never, page.reservation.publication_id))
      .rejects.toThrow(/PUBLICATION_R2_(?:SIZE|DIGEST)_MISMATCH/);
    await expect(readAuthorizedDailyPage({ DB, READMES: r2.bucket } as never, '2026-08-27'))
      .rejects.toThrow('PUBLICATION_RELEASE_NOT_FOUND');
  });

  test('single head CAS rechecks scheduled source mutation after the early authorization pass', async () => {
    let sqlite!: DatabaseSync;
    let mutated = false;
    const fixture = releaseDb({ beforeExecute(sql) {
      if (mutated || !sql.includes('daily_release:head_insert_final_guard')) return;
      mutated = true;
      sqlite.prepare(`UPDATE sources SET config=json_set(config,'$.enabled',json('false')) WHERE id='blog:openai'`).run();
    } });
    sqlite = fixture.sqlite;
    const { DB } = fixture;
    const feed = FEED_REGISTRY.find((entry) => entry.id === 'blog:openai')!;
    sqlite.prepare(`INSERT INTO sources(id,source_type,source_ref,config) VALUES(?,?,?,?)`)
      .run(feed.id, feed.kind, feed.key, JSON.stringify(feed));
    const itemId = 'blog:openai:release-race';
    sqlite.prepare(`INSERT INTO items(id,source_type,source_id,source_ref,extra,deleted_at)
      VALUES(?,?,?,NULL,?,NULL)`).run(
      itemId, 'blog', 'openai:release-race',
      JSON.stringify({ feed_id: feed.id, feed_key: feed.key, editorial_type: 'official' }),
    );
    const authorization = await authorizeFormalNewsSet(
      { DB } as never, '2026-08-27', [itemId], 'release_test_reservation',
    );
    expect(authorization.allowed_ids).toEqual([itemId]);
    const bytes = new TextEncoder().encode('guarded');
    const page = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page', business_revision_id: '5'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes }],
      formal_news_item_ids: [itemId],
      formal_guard_expected: JSON.parse(authorization.final_guard!.expected_json) as unknown[],
      release_binding: { video_mode: 'none' },
    });
    const r2 = r2Bucket();
    await materializeAppendOnlyPublication({ DB, READMES: r2.bucket } as never, page.reservation, { html: bytes });
    await expect(promoteDailyRelease({ DB, READMES: r2.bucket } as never, page.reservation.publication_id))
      .rejects.toThrow('PUBLICATION_RELEASE_HEAD_STALE');
    expect(mutated).toBe(true);
    expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM daily_release_heads`).get()).toEqual({ count: 0 });
  });

  test('archive and sitemap summaries finish the video graph read before their final joined authorization guard', async () => {
    let sqlite!: DatabaseSync;
    let outward = false;
    let graphReads = 0;
    let mutated = false;
    const fixture = releaseDb({ beforeExecute(sql) {
      if (!outward || !sql.includes('SELECT * FROM append_only_publications WHERE publication_id=?')) return;
      graphReads++;
      if (graphReads !== 2 || mutated) return;
      mutated = true;
      sqlite.prepare("UPDATE sources SET config=json_set(config,'$.enabled',json('false')) WHERE id='blog:openai'").run();
    } });
    sqlite = fixture.sqlite;
    const { DB } = fixture;
    const feed = FEED_REGISTRY.find((entry) => entry.id === 'blog:openai')!;
    sqlite.prepare(`INSERT INTO sources(id,source_type,source_ref,config) VALUES(?,?,?,?)`)
      .run(feed.id, feed.kind, feed.key, JSON.stringify(feed));
    const itemId = 'blog:openai:sitemap-video-race';
    sqlite.prepare(`INSERT INTO items(id,source_type,source_id,source_ref,extra,deleted_at)
      VALUES(?,?,?,NULL,?,NULL)`).run(
      itemId, 'blog', 'openai:sitemap-video-race',
      JSON.stringify({ feed_id: feed.id, feed_key: feed.key, editorial_type: 'official' }),
    );
    const authorization = await authorizeFormalNewsSet(
      { DB } as never, '2026-08-27', [itemId], 'sitemap_video_race_reservation',
    );
    const r2 = r2Bucket();
    const mp4 = new Uint8Array([1]);
    const poster = new Uint8Array([2]);
    const video = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'video',
      business_revision_id: '8'.repeat(64),
      objects: [
        { object_role: 'mp4', mime: 'video/mp4', bytes: mp4 },
        { object_role: 'poster', mime: 'image/jpeg', bytes: poster },
      ],
      metadata: { title: 'guarded video', description: 'race', duration_millis: 1_000 },
      release_binding: { base_release_generation: 0 },
    });
    const html = new TextEncoder().encode('<html>guarded video page</html>');
    const page = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page',
      business_revision_id: '9'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: html }],
      metadata: { title: 'AI Daily', item_count: 1 },
      formal_news_item_ids: [itemId],
      formal_guard_expected: JSON.parse(authorization.final_guard!.expected_json) as unknown[],
      release_binding: {
        video_mode: 'joint_new', base_release_generation: 0,
        bound_video_publication_id: video.reservation.publication_id,
        bound_video_digest: video.reservation.manifest.manifest_digest,
      },
    });
    await materializeAppendOnlyPublication({ DB, READMES: r2.bucket } as never, video.reservation, { mp4, poster });
    await materializeAppendOnlyPublication({ DB, READMES: r2.bucket } as never, page.reservation, { html });
    await promoteDailyRelease({ DB, READMES: r2.bucket } as never, page.reservation.publication_id);

    outward = true;
    const summaries = await listAuthorizedDailyReleaseSummaries({ DB, READMES: r2.bucket } as never);

    expect(mutated).toBe(true);
    expect(summaries).toEqual([]);
  });

  test('compatibility projection joins the current formal guard in the write that mutates daily_pages', async () => {
    let sqlite!: DatabaseSync;
    let mutateAtProjection = false;
    const fixture = releaseDb({ beforeExecute(sql) {
      if (!mutateAtProjection || !sql.includes('daily_release:compat_projection_final_guard')) return;
      mutateAtProjection = false;
      sqlite.prepare("UPDATE sources SET config=json_set(config,'$.enabled',json('false')) WHERE id='blog:openai'").run();
    } });
    sqlite = fixture.sqlite;
    const { DB } = fixture;
    const feed = FEED_REGISTRY.find((entry) => entry.id === 'blog:openai')!;
    sqlite.prepare(`INSERT INTO sources(id,source_type,source_ref,config) VALUES(?,?,?,?)`)
      .run(feed.id, feed.kind, feed.key, JSON.stringify(feed));
    const itemId = 'blog:openai:compat-race';
    sqlite.prepare(`INSERT INTO items(id,source_type,source_id,source_ref,extra,deleted_at)
      VALUES(?,?,?,NULL,?,NULL)`).run(
      itemId, 'blog', 'openai:compat-race',
      JSON.stringify({ feed_id: feed.id, feed_key: feed.key, editorial_type: 'official' }),
    );
    const authorization = await authorizeFormalNewsSet(
      { DB } as never, '2026-08-27', [itemId], 'compat_projection_race_reservation',
    );
    const html = new TextEncoder().encode('<html>compat guarded</html>');
    const page = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page', business_revision_id: 'a'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: html }],
      formal_news_item_ids: [itemId],
      formal_guard_expected: JSON.parse(authorization.final_guard!.expected_json) as unknown[],
      release_binding: { video_mode: 'none', base_release_generation: 0 },
    });
    const r2 = r2Bucket();
    await materializeAppendOnlyPublication({ DB, READMES: r2.bucket } as never, page.reservation, { html });
    const release = await promoteDailyRelease({ DB, READMES: r2.bucket } as never, page.reservation.publication_id);
    mutateAtProjection = true;

    await expect(projectAuthorizedDailyPageCompatibility(
      { DB, READMES: r2.bucket } as never,
      { ...release, date: '2026-08-27' },
      { title: 'AI Daily', item_count: 1, generated_at: 'now', lastmod: 'now' },
    )).rejects.toThrow('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');
    expect(sqlite.prepare('SELECT COUNT(*) count FROM daily_pages').get()).toEqual({ count: 0 });
  });

  test('one final set SQL rejects when date one source is disabled while date two is being prepared', async () => {
    let sqlite!: DatabaseSync;
    let armed = false;
    let headReads = 0;
    let setGuardReads = 0;
    const fixture = releaseDb({ beforeExecute(sql) {
      if (!armed) return;
      if (sql.includes('SELECT * FROM daily_release_heads WHERE date=?')) {
        headReads++;
        if (headReads === 2) {
          sqlite.prepare("UPDATE sources SET config=json_set(config,'$.enabled',json('false')) WHERE id='blog:openai'").run();
        }
      }
      if (sql.includes('daily_release:outward_set_final_guard')) setGuardReads++;
    } });
    sqlite = fixture.sqlite;
    const r2 = r2Bucket();
    const firstItem = 'blog:openai:set-race-first';
    const secondItem = 'blog:anthropic:set-race-second';
    seedScheduledFormalItem(sqlite, 'blog:openai', firstItem);
    seedScheduledFormalItem(sqlite, 'blog:anthropic', secondItem);
    await publishScheduledPage(fixture, r2, {
      date: '2026-08-26', itemId: firstItem, revision: '1'.repeat(64),
    });
    await publishScheduledPage(fixture, r2, {
      date: '2026-08-27', itemId: secondItem, revision: '2'.repeat(64),
    });
    armed = true;

    await expect(assertCurrentDailyReleaseSetAuthorization(
      { DB: fixture.DB, READMES: r2.bucket } as never,
      ['2026-08-26', '2026-08-27'],
    )).rejects.toThrow('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');

    expect(headReads).toBe(2);
    expect(setGuardReads).toBe(1);
    expect(sqlite.prepare("SELECT json_extract(config,'$.enabled') enabled FROM sources WHERE id='blog:openai'").get())
      .toEqual({ enabled: 0 });
  });

  test('one final set SQL authorizes the complete unchanged two-date collection', async () => {
    const fixture = releaseDb();
    const r2 = r2Bucket();
    const firstItem = 'blog:openai:set-valid-first';
    const secondItem = 'blog:anthropic:set-valid-second';
    seedScheduledFormalItem(fixture.sqlite, 'blog:openai', firstItem);
    seedScheduledFormalItem(fixture.sqlite, 'blog:anthropic', secondItem);
    await publishScheduledPage(fixture, r2, {
      date: '2026-08-26', itemId: firstItem, revision: '6'.repeat(64),
    });
    await publishScheduledPage(fixture, r2, {
      date: '2026-08-27', itemId: secondItem, revision: '7'.repeat(64),
    });

    await expect(assertCurrentDailyReleaseSetAuthorization(
      { DB: fixture.DB, READMES: r2.bucket } as never,
      ['2026-08-26', '2026-08-27'],
    )).resolves.toBeUndefined();
  });

  test('one final set SQL rejects a valid date-one head supersede during date-two preparation', async () => {
    let sqlite!: DatabaseSync;
    let armed = false;
    let headReads = 0;
    let setGuardReads = 0;
    let oldHead!: Awaited<ReturnType<typeof promoteDailyRelease>>;
    let newHead!: Awaited<ReturnType<typeof promoteDailyRelease>>;
    let replacementReservationToken = '';
    const fixture = releaseDb({ beforeExecute(sql) {
      if (!armed) return;
      if (sql.includes('SELECT * FROM daily_release_heads WHERE date=?')) {
        headReads++;
        if (headReads === 2) {
          sqlite.prepare(`UPDATE daily_release_heads SET release_generation=?,page_publication_id=?,
            page_manifest_digest=?,promoted_at_ms=? WHERE date=?`).run(
            newHead.release_generation, newHead.page_publication_id,
            newHead.page_manifest_digest, newHead.promoted_at_ms, newHead.date,
          );
          sqlite.prepare("UPDATE append_only_publications SET state='published',published_at_ms=9,updated_at_ms=9 WHERE publication_id=?")
            .run(newHead.page_publication_id);
          sqlite.prepare("UPDATE append_only_publication_objects SET state='publication_bound',updated_at_ms=9 WHERE publication_id=?")
            .run(newHead.page_publication_id);
          sqlite.prepare("UPDATE publication_reservations SET state='published',updated_at_ms=9 WHERE reservation_token=?")
            .run(replacementReservationToken);
        }
      }
      if (sql.includes('daily_release:outward_set_final_guard')) setGuardReads++;
    } });
    sqlite = fixture.sqlite;
    const r2 = r2Bucket();
    const firstItem = 'blog:openai:set-head-first';
    const secondItem = 'blog:anthropic:set-head-second';
    seedScheduledFormalItem(sqlite, 'blog:openai', firstItem);
    seedScheduledFormalItem(sqlite, 'blog:anthropic', secondItem);
    const first = await publishScheduledPage(fixture, r2, {
      date: '2026-08-26', itemId: firstItem, revision: '3'.repeat(64),
    });
    oldHead = first.release;
    const replacementAuthorization = await authorizeFormalNewsSet(
      { DB: fixture.DB } as never, '2026-08-26', [firstItem], 'release_set_head_replacement',
    );
    const replacementBytes = new TextEncoder().encode('<html>valid replacement</html>');
    const replacement = await reserveAppendOnlyPublication({ DB: fixture.DB } as never, {
      publication_date: '2026-08-26', publication_type: 'page', business_revision_id: '4'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: replacementBytes }],
      metadata: { title: 'valid replacement', item_count: 1 },
      formal_news_item_ids: [firstItem],
      formal_guard_expected: JSON.parse(replacementAuthorization.final_guard!.expected_json) as unknown[],
      release_binding: {
        video_mode: 'none', base_release_generation: oldHead.release_generation,
        base_page_publication_id: oldHead.page_publication_id,
        base_video_publication_id: null, base_video_digest: null,
      },
    });
    await materializeAppendOnlyPublication(
      { DB: fixture.DB, READMES: r2.bucket } as never,
      replacement.reservation,
      { html: replacementBytes },
    );
    replacementReservationToken = replacement.reservation.reservation_token;
    newHead = {
      ...oldHead,
      status: 'published',
      release_generation: oldHead.release_generation + 1,
      page_publication_id: replacement.reservation.publication_id,
      page_manifest_digest: replacement.reservation.manifest.manifest_digest,
      promoted_at_ms: 9,
    };
    await publishScheduledPage(fixture, r2, {
      date: '2026-08-27', itemId: secondItem, revision: '5'.repeat(64),
    });
    armed = true;

    await expect(assertCurrentDailyReleaseSetAuthorization(
      { DB: fixture.DB, READMES: r2.bucket } as never,
      ['2026-08-26', '2026-08-27'],
    )).rejects.toThrow('PUBLICATION_OUTWARD_AUTHORIZATION_STALE');

    expect(headReads).toBe(2);
    expect(setGuardReads).toBe(1);
    expect(sqlite.prepare('SELECT release_generation,page_publication_id FROM daily_release_heads WHERE date=?')
      .get('2026-08-26')).toEqual({
      release_generation: newHead.release_generation,
      page_publication_id: newHead.page_publication_id,
    });
  });

  test('executes the full 64 MiB video reserve→PUT→promotion→outward verification path', async () => {
    const { DB } = releaseDb();
    const r2 = r2Bucket();
    const mp4 = new Uint8Array(64 * 1024 * 1024);
    mp4[0] = 1;
    mp4[mp4.byteLength - 1] = 2;
    const poster = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const vtt = new TextEncoder().encode('WEBVTT\n');
    const video = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'video',
      business_revision_id: '6'.repeat(64),
      objects: [
        { object_role: 'mp4', mime: 'video/mp4', bytes: mp4 },
        { object_role: 'poster', mime: 'image/jpeg', bytes: poster },
        { object_role: 'vtt', mime: 'text/vtt; charset=utf-8', bytes: vtt },
      ],
      metadata: { title: '64 MiB', description: 'boundary', duration_millis: 1_000 },
      release_binding: { base_release_generation: 0 },
    });
    const pageBytes = new TextEncoder().encode('<html>64 MiB video</html>');
    const page = await reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page',
      business_revision_id: '7'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: pageBytes }],
      formal_news_item_ids: [], formal_guard_expected: [],
      release_binding: {
        video_mode: 'joint_new', base_release_generation: 0,
        bound_video_publication_id: video.reservation.publication_id,
        bound_video_digest: video.reservation.manifest.manifest_digest,
      },
    });
    await materializeAppendOnlyPublication(
      { DB, READMES: r2.bucket } as never, video.reservation, { mp4, poster, vtt },
    );
    await materializeAppendOnlyPublication(
      { DB, READMES: r2.bucket } as never, page.reservation, { html: pageBytes },
    );
    await promoteDailyRelease({ DB, READMES: r2.bucket } as never, page.reservation.publication_id);
    const outward = await readAuthorizedDailyVideoObject(
      { DB, READMES: r2.bucket } as never, video.reservation.publication_id, 'mp4',
    );
    expect(outward.size).toBe(64 * 1024 * 1024);
    expect(outward.bytes[0]).toBe(1);
    expect(outward.bytes[outward.bytes.byteLength - 1]).toBe(2);
    expect('delete' in r2.bucket).toBe(false);
  }, 30_000);
});
