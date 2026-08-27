import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import * as storage from './publication-storage';
import { canonicalizePublicationObject } from './publication-canonical';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const modulePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'publication-storage.ts');

describe('append-only publication storage adapter', () => {
  test('exists as the only publication R2 boundary', () => {
    expect(existsSync(modulePath)).toBe(true);
    expect(Object.keys(storage)).not.toContain('deletePublicationObject');
  });

  test('reuses only an exact HEAD tuple and never overwrites a mismatch', async () => {
    const attempt = 'a'.repeat(64);
    const bytes = new Uint8Array([1, 2, 3]);
    const object = await canonicalizePublicationObject({
      schema_version: 1, r2_key: `daily/versions/${attempt}/page.html`,
      business_revision_id: 'b'.repeat(64), attempt_key: attempt,
      object_role: 'html', mime: 'text/html; charset=utf-8',
    }, bytes);
    const puts: string[] = [];
    const exactBucket = {
      async head() { return storage.publicationObjectHeadFixture(object); },
      async put(key: string) { puts.push(key); },
    };
    await expect(storage.putImmutablePublicationObject(exactBucket as never, object, bytes))
      .resolves.toEqual({ status: 'reused' });
    expect(puts).toEqual([]);

    const mismatchBucket = {
      async head() {
        return storage.publicationObjectHeadFixture({ ...object, sha256: '0'.repeat(64) });
      },
      async put(key: string) { puts.push(key); },
    };
    await expect(storage.putImmutablePublicationObject(mismatchBucket as never, object, bytes))
      .rejects.toThrow('PUBLICATION_R2_INTEGRITY_MISMATCH');
    expect(puts).toEqual([]);
  });

  test('puts an absent key with exact metadata and reports unknown without changing key', async () => {
    const attempt = 'c'.repeat(64);
    const bytes = new Uint8Array([4, 5, 6]);
    const object = await canonicalizePublicationObject({
      schema_version: 1, r2_key: `daily/versions/${attempt}/page.html`,
      business_revision_id: 'd'.repeat(64), attempt_key: attempt,
      object_role: 'html', mime: 'text/html; charset=utf-8',
    }, bytes);
    const calls: Array<{ key: string; metadata: Record<string, string> }> = [];
    const bucket = {
      async head() { return null; },
      async put(key: string, _body: unknown, options: { customMetadata: Record<string, string> }) {
        calls.push({ key, metadata: options.customMetadata });
        throw new Error('timeout');
      },
    };
    await expect(storage.putImmutablePublicationObject(bucket as never, object, bytes))
      .rejects.toThrow('PUBLICATION_PUT_UNKNOWN');
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe(object.r2_key);
    expect(calls[0].metadata.sha256).toBe(object.sha256);
  });

  test('allocates one slot/bytes and replays the same business revision exactly', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(path.resolve(path.dirname(modulePath), '../../migrations/040-daily-release-publications.sql'), 'utf8'));
    sqlite.prepare(`UPDATE publication_storage_budget SET state='active',legacy_inventory_digest=?,
      legacy_inventory_object_count=0,legacy_inventory_at_ms=1,version=1,updated_at_ms=1 WHERE singleton_id=1`)
      .run('a'.repeat(64));
    const DB = sqliteD1(sqlite);
    const input = {
      publication_date: '2026-08-27', publication_type: 'page' as const,
      business_revision_id: 'b'.repeat(64),
      objects: [{ object_role: 'html' as const, mime: 'text/html; charset=utf-8', bytes: new TextEncoder().encode('hello') }],
    };
    const first = await storage.reserveAppendOnlyPublication({ DB } as never, input);
    const replay = await storage.reserveAppendOnlyPublication({ DB } as never, input);
    expect(first.status).toBe('reserved');
    expect(replay.status).toBe('replayed');
    expect(replay.reservation).toMatchObject({
      reservation_token: first.reservation.reservation_token,
      attempt_key: first.reservation.attempt_key,
      slot_no: 1,
    });
    expect(sqlite.prepare('SELECT reserved_bytes,version FROM publication_storage_budget').get())
      .toEqual({ reserved_bytes: 5, version: 2 });
    expect(sqlite.prepare('SELECT COUNT(*) n FROM publication_reservations').get()).toEqual({ n: 1 });
  });

  test('fails closed at the page slot quota without calling R2', async () => {
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec(readFileSync(path.resolve(path.dirname(modulePath), '../../migrations/040-daily-release-publications.sql'), 'utf8'));
    sqlite.prepare(`UPDATE publication_storage_budget SET state='active',legacy_inventory_digest=?,
      legacy_inventory_object_count=0,legacy_inventory_at_ms=1,version=1,updated_at_ms=1 WHERE singleton_id=1`)
      .run('a'.repeat(64));
    const DB = sqliteD1(sqlite);
    for (let index = 0; index < 16; index++) {
      await storage.reserveAppendOnlyPublication({ DB } as never, {
        publication_date: '2026-08-27', publication_type: 'page',
        business_revision_id: index.toString(16).padStart(64, '0'),
        objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: new Uint8Array([index]) }],
      });
    }
    await expect(storage.reserveAppendOnlyPublication({ DB } as never, {
      publication_date: '2026-08-27', publication_type: 'page', business_revision_id: 'f'.repeat(64),
      objects: [{ object_role: 'html', mime: 'text/html; charset=utf-8', bytes: new Uint8Array([99]) }],
    })).rejects.toThrow('PUBLICATION_QUOTA_EXHAUSTED');
    expect(sqlite.prepare('SELECT COUNT(*) n FROM publication_reservations').get()).toEqual({ n: 16 });
  });

  test('concurrent same revision commits one graph and replays the exact winner without double accounting', async () => {
    const sqlite = publicationDb();
    const barrier = twoArrivalBarrier();
    const DB = sqliteD1(sqlite, { beforeBatch: barrier.wait });
    const input = pageInput('1'.repeat(64), 11);
    const results = await Promise.all([
      storage.reserveAppendOnlyPublication({ DB } as never, input),
      storage.reserveAppendOnlyPublication({ DB } as never, input),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['replayed', 'reserved']);
    expect(new Set(results.map((result) => result.reservation.reservation_token)).size).toBe(1);
    expect(new Set(results.map((result) => result.reservation.attempt_key)).size).toBe(1);
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM publication_reservations`).get()).toEqual({ n: 1 });
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM append_only_publication_objects`).get()).toEqual({ n: 1 });
    expect(sqlite.prepare(`SELECT reserved_bytes FROM publication_storage_budget`).get())
      .toEqual({ reserved_bytes: 11 });
  });

  test('concurrent final page slot leaves one complete winner and returns quota exhaustion for the loser', async () => {
    const sqlite = publicationDb();
    const hooks: SqliteD1Hooks = {};
    const DB = sqliteD1(sqlite, hooks);
    for (let index = 0; index < 15; index++) {
      await storage.reserveAppendOnlyPublication({ DB } as never, pageInput(
        index.toString(16).padStart(64, '0'), 1,
      ));
    }
    const barrier = twoArrivalBarrier();
    hooks.beforeBatch = barrier.wait;
    const settled = await Promise.allSettled([
      storage.reserveAppendOnlyPublication({ DB } as never, pageInput('a'.repeat(64), 2)),
      storage.reserveAppendOnlyPublication({ DB } as never, pageInput('b'.repeat(64), 3)),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(failure.reason)).toContain('PUBLICATION_QUOTA_EXHAUSTED');
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM publication_reservations`).get()).toEqual({ n: 16 });
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM publication_manifest_commits`).get()).toEqual({ n: 16 });
    expect(sqlite.prepare(`SELECT reserved_bytes FROM publication_storage_budget`).get())
      .toEqual({ reserved_bytes: 15 + (settled[0].status === 'fulfilled' ? 2 : 3) });
  });

  test('concurrent final budget bytes account only one complete winner', async () => {
    const sqlite = publicationDb(6);
    const barrier = twoArrivalBarrier();
    const DB = sqliteD1(sqlite, { beforeBatch: barrier.wait });
    const settled = await Promise.allSettled([
      storage.reserveAppendOnlyPublication({ DB } as never, pageInput('c'.repeat(64), 6)),
      storage.reserveAppendOnlyPublication({ DB } as never, pageInput('d'.repeat(64), 6)),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(sqlite.prepare(`SELECT reserved_bytes,version FROM publication_storage_budget`).get())
      .toEqual({ reserved_bytes: 6, version: 2 });
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM publication_reservations`).get()).toEqual({ n: 1 });
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM append_only_publications`).get()).toEqual({ n: 1 });
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM append_only_publication_objects`).get()).toEqual({ n: 1 });
    expect(sqlite.prepare(`SELECT COUNT(*) n FROM publication_manifest_commits`).get()).toEqual({ n: 1 });
  });

  test('reconciles committed unknown and retries an uncommitted unknown with the original planned tuple', async () => {
    for (const outcome of ['throw_after', 'throw_before'] as const) {
      const sqlite = publicationDb();
      const hooks: SqliteD1Hooks = { batchOutcome: outcome };
      const result = await storage.reserveAppendOnlyPublication(
        { DB: sqliteD1(sqlite, hooks) } as never,
        pageInput(outcome === 'throw_after' ? 'e'.repeat(64) : 'f'.repeat(64), 4),
      );
      expect(result.status).toBe(outcome === 'throw_after' ? 'replayed' : 'reserved');
      expect(sqlite.prepare(`SELECT reserved_bytes,version FROM publication_storage_budget`).get())
        .toEqual({ reserved_bytes: 4, version: 2 });
      expect(sqlite.prepare(`SELECT COUNT(*) n FROM publication_reservations`).get()).toEqual({ n: 1 });
      expect(sqlite.prepare(`SELECT COUNT(DISTINCT attempt_key) n FROM publication_reservations`).get())
        .toEqual({ n: 1 });
    }
  });
});

interface SqliteD1Hooks {
  beforeBatch?: () => Promise<void>;
  batchOutcome?: 'normal' | 'throw_before' | 'throw_after';
}

function publicationDb(budgetBytes = 3_298_534_883_328): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(path.resolve(path.dirname(modulePath), '../../migrations/040-daily-release-publications.sql'), 'utf8'));
  sqlite.prepare(`UPDATE publication_storage_budget SET budget_bytes=?,state='active',
    legacy_inventory_digest=?,legacy_inventory_object_count=0,legacy_inventory_at_ms=1,
    version=1,updated_at_ms=1 WHERE singleton_id=1`).run(budgetBytes, 'a'.repeat(64));
  return sqlite;
}

function pageInput(businessRevisionId: string, size: number) {
  return {
    publication_date: '2026-08-27', publication_type: 'page' as const,
    business_revision_id: businessRevisionId,
    objects: [{
      object_role: 'html' as const,
      mime: 'text/html; charset=utf-8',
      bytes: new Uint8Array(size).fill(1),
    }],
  };
}

function twoArrivalBarrier() {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  return {
    async wait() {
      arrivals++;
      if (arrivals === 2) release();
      await ready;
    },
  };
}

function sqliteD1(sqlite: DatabaseSync, hooks: SqliteD1Hooks = {}) {
  let batchTail = Promise.resolve();
  return {
    prepare(sql: string) {
      let binds: SQLInputValue[] = [];
      const statement = {
        bind(...values: unknown[]) { binds = values as SQLInputValue[]; return statement; },
        async first<T>() { return (sqlite.prepare(sql).get(...binds) || null) as T | null; },
        async all<T>() { return { results: sqlite.prepare(sql).all(...binds) as T[] }; },
        async run() {
          const result = sqlite.prepare(sql).run(...binds);
          return { success: true, meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      await hooks.beforeBatch?.();
      let release!: () => void;
      const previous = batchTail;
      batchTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        if (hooks.batchOutcome === 'throw_before') {
          hooks.batchOutcome = 'normal';
          throw new Error('D1 response unknown before commit');
        }
        sqlite.exec('BEGIN IMMEDIATE');
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        if (hooks.batchOutcome === 'throw_after') {
          hooks.batchOutcome = 'normal';
          throw new Error('D1 response unknown after commit');
        }
        return result;
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec('ROLLBACK');
        throw error;
      } finally {
        release();
      }
    },
  };
}
