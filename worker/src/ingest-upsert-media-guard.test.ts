import { describe, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    ctx: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { ingestItems, type Env } from './index';

// node:sqlite 在部分 Node 版本下不可用(实验特性),拿不到就只跑 SQL 文本断言。
const sqlite = await import('node:sqlite').catch(() => null);

interface Captured { sql: string; binds: unknown[] }

/** 最小 fake DB:只记录 prepare 出来的 SQL 与绑定值,batch 一律成功。 */
function captureEnv(): { env: Env; captured: Captured[] } {
  const captured: Captured[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const rec: Captured = { sql, binds: [] };
        const stmt = {
          bind(...binds: unknown[]) {
            rec.binds = binds;
            captured.push(rec);
            return stmt;
          },
        };
        return stmt;
      },
      async batch(stmts: unknown[]) {
        return stmts.map(() => ({ meta: { changes: 1 } }));
      },
    },
  } as unknown as Env;
  return { env, captured };
}

const MEDIA_GUARD_CASE = `media = CASE
              WHEN items.media LIKE '%"url":"/r/%' AND coalesce(excluded.media, '') NOT LIKE '%"url":"/r/%'
                THEN items.media
              ELSE excluded.media
            END`;

async function captureUpsertSql(): Promise<Captured> {
  const { env, captured } = captureEnv();
  await ingestItems(env, [
    {
      source_type: 'hf_paper',
      source_id: '2609.11412',
      scraped_at: '2026-09-16T01:00:00.000Z',
      title: 'X-AuT',
      media: [{ type: 'image', url: 'https://cdn-thumbnails.huggingface.co/x.png' }],
    },
  ]);
  expect(captured).toHaveLength(1);
  return captured[0];
}

describe('ingestItems upsert — 媒体指针保护', () => {
  test('ON CONFLICT 的 media 分支带上 R2 保护 CASE，不再无条件覆盖', async () => {
    const { sql } = await captureUpsertSql();
    expect(sql).toContain(MEDIA_GUARD_CASE);
    // 老写法(无条件覆盖)必须消失
    expect(sql).not.toMatch(/^\s*media = excluded\.media,\s*$/m);
  });
});

describe.skipIf(!sqlite)('ingestItems upsert — 真 SQLite 跑一遍 CASE 语义', () => {
  // 拿 ingestItems 真实生成的 SQL,灌进内存 SQLite 验行为(夹具里手抄一份 SQL 会漂移)。
  async function run(existingMedia: string | null, incomingMedia: string | null): Promise<string | null> {
    const { DatabaseSync } = sqlite!;
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, source_type TEXT, source_id TEXT, source_ref TEXT,
        title TEXT, content TEXT, content_translated TEXT, author TEXT, handle TEXT,
        url TEXT, media TEXT, metrics TEXT, published_at TEXT, scraped_at TEXT,
        is_relevant INTEGER, matched_by TEXT, lang TEXT, extra TEXT
      );
    `);
    const stmt = db.prepare(
      `INSERT INTO items (id, media, source_type, source_id, scraped_at) VALUES (?, ?, 'hf_paper', 'x', '2026-09-15T00:00:00Z')`,
    );
    stmt.run('hf_paper:2609.11412', existingMedia);

    const { sql, binds } = await captureUpsertSql();
    const values = binds.map((b) => (b === undefined ? null : b)) as (string | number | null)[];
    values[10] = incomingMedia;                       // media 是第 11 个绑定位
    db.prepare(sql).run(...values);

    const row = db.prepare(`SELECT media FROM items WHERE id = ?`).get('hf_paper:2609.11412') as
      | { media: string | null }
      | undefined;
    db.close();
    return row?.media ?? null;
  }

  test('库里已迁 R2、来的是外链 → 保留库里的 /r/ 地址', async () => {
    const kept = '[{"type":"image","url":"/r/hf/abc.png","role":"figure"}]';
    expect(await run(kept, '[{"type":"image","url":"https://arxiv.org/html/x1.png"}]')).toBe(kept);
  });

  test('来的也是 R2 → 照旧用新的(迁移结果能刷新)', async () => {
    const fresh = '[{"type":"image","url":"/r/hf/new.png"}]';
    expect(await run('[{"type":"image","url":"/r/hf/old.png"}]', fresh)).toBe(fresh);
  });

  test('库里是外链 → 照旧用新的', async () => {
    const fresh = '[{"type":"image","url":"https://cdn.example.com/b.png"}]';
    expect(await run('[{"type":"image","url":"https://cdn.example.com/a.png"}]', fresh)).toBe(fresh);
  });

  test('库里已迁 R2、来的是 null → 保留库里的', async () => {
    const kept = '[{"type":"image","url":"/r/hf/abc.png"}]';
    expect(await run(kept, null)).toBe(kept);
  });

  test('库里为空 → 照旧写入新的', async () => {
    const fresh = '[{"type":"image","url":"https://cdn.example.com/a.png"}]';
    expect(await run(null, fresh)).toBe(fresh);
  });
});
