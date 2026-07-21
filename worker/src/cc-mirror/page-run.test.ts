import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../index";
import type { RenderRow } from "../digest/render";
import {
  bindCcPassToCurrentRow,
  CC_REVIEW_POLICY_VERSION,
  reviewCcItem,
} from "./review";
import { buildCcReviewText } from "./review-text";
import {
  ccItemPageR2Key,
  markCcItemPageGone,
  syncCcItemPage,
} from "./page-run";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = [
  "029-cc-content-mirror.sql",
  "030-cc-content-mirror-decision-token.sql",
].map((file) =>
  fs.readFileSync(path.resolve(here, "../../migrations", file), "utf8")
).join("\n");

type MutationHook = (db: StatefulD1) => void;

class StatefulD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  writeCount = 0;
  itemReads = 0;
  overrideReads = 0;
  failNextBatch = false;
  beforeNextBatch?: MutationHook;
  afterFirstItemRead?: MutationHook;
  afterFirstOverrideRead?: MutationHook;

  constructor() {
    this.sqlite.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY,
        title TEXT,
        content TEXT,
        content_translated TEXT,
        author TEXT,
        handle TEXT,
        url TEXT,
        media TEXT,
        extra TEXT,
        source_type TEXT NOT NULL,
        is_relevant INTEGER,
        deleted_at TEXT,
        published_at TEXT,
        scraped_at TEXT
      );
    `);
    this.sqlite.exec(migration);
  }

  insertSafeBlog(id = "blog:openai:item-1"): string {
    this.sqlite.prepare(
      `INSERT INTO items (
        id, title, content, content_translated, author, handle, url, media,
        extra, source_type, is_relevant, deleted_at, published_at, scraped_at
      ) VALUES (?, 'Raw title', NULL, NULL, NULL, NULL, ?, NULL, ?, 'blog', 1, NULL, ?, ?)`,
    ).run(
      id,
      "https://openai.com/news/item-1",
      JSON.stringify({
        feed_key: "openai",
        title_zh: "AI 产品更新",
        ai_summary_zh: "这是面向开发者的中性 AI 产品更新。",
        excerpt_zh: "编辑整理的短要点。",
      }),
      "2026-07-20T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
    );
    return id;
  }

  setOverride(
    itemId: string,
    action: "allow" | "deny",
    decisionToken = "fixture-token",
  ): void {
    this.sqlite.prepare(
      `INSERT INTO cc_item_overrides (
         item_id, action, reason, decision_token, updated_at
       ) VALUES (?, ?, 'test', ?,
         '2026-07-20T00:00:00.000Z')
       ON CONFLICT(item_id) DO UPDATE SET
         action = excluded.action,
         decision_token = excluded.decision_token`,
    ).run(itemId, action, decisionToken);
  }

  page(itemId: string): Record<string, unknown> | undefined {
    return this.sqlite.prepare(
      `SELECT * FROM cc_item_pages WHERE item_id = ?`,
    ).get(itemId) as Record<string, unknown> | undefined;
  }

  events(itemId: string): Array<Record<string, unknown>> {
    return this.sqlite.prepare(
      `SELECT * FROM cc_page_events WHERE item_id = ? ORDER BY seq`,
    ).all(itemId) as Array<Record<string, unknown>>;
  }

  prepare(sql: string) {
    let bindings: SQLInputValue[] = [];
    const statement = this.sqlite.prepare(sql);
    const prepared = {
      bind: (...values: unknown[]) => {
        bindings = values as SQLInputValue[];
        return prepared;
      },
      first: async <T>() => {
        const value = (statement.get(...bindings) as T | undefined) ?? null;
        if (/FROM\s+items\s+WHERE\s+id/i.test(sql)) {
          this.itemReads += 1;
          if (this.itemReads === 1) this.afterFirstItemRead?.(this);
        }
        if (/FROM\s+cc_item_overrides/i.test(sql)) {
          this.overrideReads += 1;
          if (this.overrideReads === 1) this.afterFirstOverrideRead?.(this);
        }
        return value;
      },
      all: async <T>() => ({
        results: statement.all(...bindings) as T[],
        success: true,
        meta: {},
      }),
      run: async () => {
        if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
          this.writeCount += 1;
        }
        const result = statement.run(...bindings);
        return {
          success: true,
          meta: { changes: Number(result.changes) },
        };
      },
    };
    return prepared;
  }

  async batch(statements: Array<{ run(): Promise<unknown> }>): Promise<unknown[]> {
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error("D1 batch unavailable");
    }
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = undefined;
    beforeBatch?.(this);
    this.sqlite.exec("BEGIN");
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.sqlite.close();
  }
}

class ObservableR2 {
  readonly objects = new Map<string, {
    bytes: Uint8Array;
    httpMetadata?: R2PutOptions["httpMetadata"];
    customMetadata?: Record<string, string>;
  }>();
  readonly puts: Array<{ key: string; value: string }> = [];
  failNextPut = false;
  private pausedPut: {
    started: () => void;
    wait: Promise<void>;
  } | null = null;

  async put(
    key: string,
    value: string | ArrayBuffer,
    options: R2PutOptions = {},
  ): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("R2 unavailable");
    }
    const paused = this.pausedPut;
    if (paused) {
      this.pausedPut = null;
      paused.started();
      await paused.wait;
    }
    const bytes = typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
    this.puts.push({ key, value: new TextDecoder().decode(bytes) });
    this.objects.set(key, {
      bytes: new Uint8Array(bytes),
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    });
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      arrayBuffer: async () =>
        object.bytes.buffer.slice(
          object.bytes.byteOffset,
          object.bytes.byteOffset + object.bytes.byteLength,
        ),
    };
  }

  async head(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      customMetadata: object.customMetadata,
      httpMetadata: object.httpMetadata,
    };
  }

  text(key: string): string | undefined {
    const object = this.objects.get(key);
    return object ? new TextDecoder().decode(object.bytes) : undefined;
  }

  pauseNextPut(): { started: Promise<void>; release: () => void } {
    let signalStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.pausedPut = { started: signalStarted, wait };
    return { started, release };
  }
}

const resources: StatefulD1[] = [];
afterEach(() => {
  while (resources.length) resources.pop()!.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(opts: { apiKey?: string } = {}) {
  const db = new StatefulD1();
  resources.push(db);
  const r2 = new ObservableR2();
  const env = {
    DB: db as unknown as D1Database,
    READMES: r2 as unknown as R2Bucket,
    SITE_BASE: "https://ai-feeds.com",
    CC_SITE_BASE: "https://ai-feeds.cc",
    API_BASE: "https://api.ai-feeds.com",
    DEEPSEEK_API_KEY: opts.apiKey,
  } as Env;
  return { db, r2, env };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

const SAFE_FLAGS = {
  china_negative: 0,
  politics_governance: 0,
  military_conflict: 0,
  sanctions_export_control: 0,
  other_cn_distribution_risk: 0,
  uncertain: 0,
  reasons: [],
};

async function seedModelReview(
  db: StatefulD1,
  env: Env,
  itemId: string,
  status = "pass",
): Promise<string> {
  const row = db.sqlite.prepare(
    `SELECT * FROM items WHERE id = ?`,
  ).get(itemId) as unknown as RenderRow;
  const hash = await sha256(buildCcReviewText(row, env).hashInput);
  db.sqlite.prepare(
    `INSERT INTO cc_item_reviews (
       item_id, policy_version, source_policy, review_status, flags_json,
       reason, review_text_hash, model, reviewed_at
     ) VALUES (?, ?, 'allow', ?, ?, 'seeded model result', ?, 'test-model', ?)
     ON CONFLICT(item_id) DO UPDATE SET
       policy_version = excluded.policy_version,
       source_policy = excluded.source_policy,
       review_status = excluded.review_status,
       flags_json = excluded.flags_json,
       reason = excluded.reason,
       review_text_hash = excluded.review_text_hash,
       model = excluded.model,
       reviewed_at = excluded.reviewed_at`,
  ).run(
    itemId,
    CC_REVIEW_POLICY_VERSION,
    status,
    JSON.stringify(SAFE_FLAGS),
    hash,
    "2026-07-20T00:00:00.000Z",
  );
  return hash;
}

function mockReviewFlags(flags: Partial<typeof SAFE_FLAGS>): void {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(
      JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({ ...SAFE_FLAGS, ...flags }),
          },
          finish_reason: "stop",
        }],
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    )
  ));
}

describe("ccItemPageR2Key", () => {
  it("uses an immutable content-addressed private namespace and rejects malformed ids or hashes", () => {
    const hash = "a".repeat(64);
    expect(ccItemPageR2Key("github:owner/repo", hash)).toBe(
      `cc-item-pages/gh/github%3Aowner%2Frepo/${hash}.html`,
    );
    expect(ccItemPageR2Key("blog:openai:item-1", hash)).toBe(
      `cc-item-pages/news/blog%3Aopenai%3Aitem-1/${hash}.html`,
    );
    expect(ccItemPageR2Key("github:missing-repo", hash)).toBeNull();
    expect(ccItemPageR2Key("clawhub:item", hash)).toBeNull();
    expect(ccItemPageR2Key("../escape", hash)).toBeNull();
    expect(ccItemPageR2Key("github:owner/repo", "abc")).toBeNull();
    expect(ccItemPageR2Key("github:owner/repo", "A".repeat(64))).toBeNull();
  });
});

describe("syncCcItemPage", () => {
  it("review pass writes R2 first, records a live page with the exact HTML hash, and appends one upsert event", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");

    const result = await syncCcItemPage(env, id);
    const page = db.page(id)!;
    const html = r2.text(String(page.r2_key))!;

    expect(result).toEqual({
      itemId: id,
      status: "live",
      reason: "override-allow",
      eventCreated: true,
    });
    expect(String(page.status)).toBe("live");
    expect(String(page.url_path)).toBe("/i/news/blog%3Aopenai%3Aitem-1");
    expect(String(page.content_hash)).toBe(await sha256(html));
    expect(String(page.r2_key)).toBe(
      ccItemPageR2Key(id, String(page.content_hash)),
    );
    expect(r2.objects.get(String(page.r2_key))!.customMetadata).toEqual({
      contentHash: page.content_hash,
    });
    expect(html).toContain("https://ai-feeds.cc/i/news/");
    expect(db.events(id)).toMatchObject([
      { op: "upsert", content_hash: page.content_hash },
    ]);
  });

  it("same live HTML is idempotent, while changed approved visible text creates exactly one new upsert", async () => {
    const { db, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");

    await syncCcItemPage(env, id);
    const firstHash = String(db.page(id)!.content_hash);
    const unchanged = await syncCcItemPage(env, id);
    expect(unchanged.eventCreated).toBe(false);
    expect(db.events(id)).toHaveLength(1);

    db.sqlite.prepare(
      `UPDATE items
       SET extra = json_set(extra, '$.ai_summary_zh', '更新后的中性 AI 摘要。')
       WHERE id = ?`,
    ).run(id);
    const changed = await syncCcItemPage(env, id);

    expect(changed.eventCreated).toBe(true);
    expect(String(db.page(id)!.content_hash)).not.toBe(firstHash);
    expect(db.events(id).map((event) => event.op)).toEqual(["upsert", "upsert"]);
  });

  it.each(["pending", "review", "deny"] as const)(
    "%s review never writes HTML; an existing live page becomes gone with one delete event and repeated gone is idempotent",
    async (mode) => {
      const { db, r2, env } = setup();
      const id = db.insertSafeBlog();
      db.setOverride(id, "allow");
      await syncCcItemPage(env, id);
      const putCount = r2.puts.length;

      if (mode === "deny") {
        db.setOverride(id, "deny");
      } else if (mode === "review") {
        db.sqlite.prepare(
          `UPDATE items
           SET source_type = 'podcast',
               extra = ?
           WHERE id = ?`,
        ).run(
          JSON.stringify({
            show_key: "last-week-in-ai",
            title_zh: "AI 周报播客",
            ai_summary_zh: "中性 AI 周报摘要。",
            shownotes_zh: "节目简介。",
          }),
          id,
        );
        db.sqlite.prepare(
          `DELETE FROM cc_item_overrides WHERE item_id = ?`,
        ).run(id);
        const row = db.sqlite.prepare(
          `SELECT * FROM items WHERE id = ?`,
        ).get(id) as unknown as RenderRow;
        const reviewTextHash = await sha256(buildCcReviewText(row, env).hashInput);
        db.sqlite.prepare(
          `INSERT INTO cc_item_reviews (
             item_id, policy_version, source_policy, review_status, flags_json,
             reason, review_text_hash, model, reviewed_at
           ) VALUES (?, ?, 'manual', 'pass', ?, 'cached safe flags', ?, NULL, ?)`,
        ).run(
          id,
          CC_REVIEW_POLICY_VERSION,
          JSON.stringify({
            china_negative: 0,
            politics_governance: 0,
            military_conflict: 0,
            sanctions_export_control: 0,
            other_cn_distribution_risk: 0,
            uncertain: 0,
            reasons: [],
          }),
          reviewTextHash,
          "2026-07-20T00:00:00.000Z",
        );
      } else {
        db.sqlite.prepare(
          `DELETE FROM cc_item_overrides WHERE item_id = ?`,
        ).run(id);
      }
      const first = await syncCcItemPage(env, id);
      const second = await syncCcItemPage(env, id);

      expect(first.status).toBe("gone");
      expect(first.eventCreated).toBe(true);
      expect(second.status).toBe("gone");
      expect(second.eventCreated).toBe(false);
      expect(r2.puts).toHaveLength(putCount);
      expect(db.page(id)!.status).toBe("gone");
      expect(db.events(id).map((event) => event.op)).toEqual(["upsert", "delete"]);
    },
  );

  it("dry mode performs no D1 or R2 writes, including review persistence", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    const writesBefore = db.writeCount;

    const result = await syncCcItemPage(env, id, { dry: true });

    expect(result.status).toBe("skipped");
    expect(db.writeCount).toBe(writesBefore);
    expect(r2.puts).toHaveLength(0);
    expect(db.page(id)).toBeUndefined();
    expect(db.events(id)).toHaveLength(0);
  });

  it("R2 failure cannot leave D1 claiming a new live page or append an event", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    r2.failNextPut = true;

    await expect(syncCcItemPage(env, id)).rejects.toThrow("R2 unavailable");
    expect(db.page(id)).toBeUndefined();
    expect(db.events(id)).toHaveLength(0);
  });

  it("retains an unreferenced immutable version when the following D1 batch fails", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    db.failNextBatch = true;

    await expect(syncCcItemPage(env, id)).rejects.toThrow(
      "D1 batch unavailable",
    );

    expect(r2.objects.size).toBe(1);
    const [key] = r2.objects.keys();
    expect(key).toMatch(
      /^cc-item-pages\/news\/blog%3Aopenai%3Aitem-1\/[0-9a-f]{64}\.html$/,
    );
    expect(db.page(id)).toBeUndefined();
    expect(db.events(id)).toHaveLength(0);
  });

  it("keeps the old live pointer and both immutable versions when an update D1 batch fails", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    await syncCcItemPage(env, id);
    const pageBefore = db.page(id)!;
    const oldKey = String(pageBefore.r2_key);
    const oldBytes = r2.text(oldKey)!;
    const oldHash = String(pageBefore.content_hash);
    const eventCount = db.events(id).length;

    db.sqlite.prepare(
      `UPDATE items
       SET extra = json_set(extra, '$.ai_summary_zh', '审核通过后的更新正文。')
       WHERE id = ?`,
    ).run(id);
    db.failNextBatch = true;

    await expect(syncCcItemPage(env, id)).rejects.toThrow(
      "D1 batch unavailable",
    );

    expect(r2.text(oldKey)).toBe(oldBytes);
    expect(await sha256(r2.text(oldKey)!)).toBe(oldHash);
    expect(db.page(id)!.content_hash).toBe(oldHash);
    expect(db.page(id)!.r2_key).toBe(oldKey);
    expect(db.events(id)).toHaveLength(eventCount);
    expect(r2.objects.size).toBe(2);
  });

  it("retains every event-addressable immutable version across two successful updates", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    await syncCcItemPage(env, id);
    db.sqlite.prepare(
      `UPDATE items
       SET extra = json_set(extra, '$.ai_summary_zh', '第二版已审核正文。')
       WHERE id = ?`,
    ).run(id);
    await syncCcItemPage(env, id);

    const upserts = db.events(id).filter((event) => event.op === "upsert");
    expect(upserts).toHaveLength(2);
    for (const event of upserts) {
      const hash = String(event.content_hash);
      const key = ccItemPageR2Key(id, hash)!;
      const html = r2.text(key);
      expect(html).toBeDefined();
      expect(await sha256(html!)).toBe(hash);
    }
    expect(r2.objects.size).toBe(2);
  });

  it.each(["missing", "metadata-mismatch"] as const)(
    "self-heals a live same-hash immutable object when it is %s without creating an event",
    async (mode) => {
      const { db, r2, env } = setup();
      const id = db.insertSafeBlog();
      db.setOverride(id, "allow");
      await syncCcItemPage(env, id);
      const page = db.page(id)!;
      const key = String(page.r2_key);
      const eventsBefore = db.events(id).length;
      const putsBefore = r2.puts.length;

      if (mode === "missing") {
        r2.objects.delete(key);
      } else {
        r2.objects.get(key)!.customMetadata = {
          contentHash: "0".repeat(64),
        };
      }

      const result = await syncCcItemPage(env, id);

      expect(result.status).toBe("live");
      expect(result.eventCreated).toBe(false);
      expect(r2.puts).toHaveLength(putsBefore + 1);
      expect(r2.objects.get(key)!.customMetadata).toEqual({
        contentHash: page.content_hash,
      });
      expect(await sha256(r2.text(key)!)).toBe(page.content_hash);
      expect(db.events(id)).toHaveLength(eventsBefore);
    },
  );

  it.each([
    ["visible content changed", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items SET extra = json_set(extra, '$.ai_summary_zh', '审核后被替换的正文') WHERE id = ?`,
      ).run(id);
    }],
    ["item became deleted", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(`UPDATE items SET deleted_at = '2026-07-20' WHERE id = ?`).run(id);
    }],
    ["item became irrelevant", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(`UPDATE items SET is_relevant = 0 WHERE id = ?`).run(id);
    }],
    ["source policy became deny", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items
         SET extra = json_set(extra, '$.feed_key', '36kr')
         WHERE id = ?`,
      ).run(id);
    }],
  ] as const)(
    "revalidates immediately before R2 and fails closed when %s after review",
    async (_label, mutate) => {
      const { db, r2, env } = setup();
      const id = db.insertSafeBlog();
      db.setOverride(id, "allow");
      db.afterFirstOverrideRead = (state) => mutate(state, id);

      const result = await syncCcItemPage(env, id);

      expect(result.status).toBe("skipped");
      expect(r2.puts).toHaveLength(0);
      expect(db.page(id)).toBeUndefined();
      expect(db.events(id)).toHaveLength(0);
    },
  );

  it("rechecks a deny override immediately before R2 and never upserts live", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    db.afterFirstOverrideRead = (state) => state.setOverride(id, "deny");

    const result = await syncCcItemPage(env, id);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("override-deny");
    expect(r2.puts).toHaveLength(0);
    expect(db.page(id)).toBeUndefined();
  });

  it("fails closed when an override-allow pass loses that allow before binding", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    db.afterFirstOverrideRead = (state) => {
      state.sqlite.prepare(
        `DELETE FROM cc_item_overrides WHERE item_id = ?`,
      ).run(id);
    };

    const result = await syncCcItemPage(env, id);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("override-allow-no-longer-active");
    expect(r2.puts).toHaveLength(0);
    expect(db.page(id)).toBeUndefined();
    expect(db.events(id)).toHaveLength(0);
  });

  it("requires a current allow override when a model pass is bound to a manual source", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.sqlite.prepare(
      `UPDATE items
       SET source_type = 'podcast',
           extra = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify({
        show_key: "last-week-in-ai",
        title_zh: "AI 周报播客",
        ai_summary_zh: "中性 AI 周报摘要。",
        shownotes_zh: "节目简介。",
      }),
      id,
    );
    const current = db.sqlite.prepare(
      `SELECT * FROM items WHERE id = ?`,
    ).get(id) as unknown as RenderRow;
    const currentHash = await sha256(buildCcReviewText(current, env).hashInput);

    const bound = await bindCcPassToCurrentRow(
      env,
      id,
      currentHash,
      "model",
    );

    expect(bound).toMatchObject({
      ok: false,
      reason: "manual-source-requires-allow-override",
    });
    expect(r2.puts).toHaveLength(0);
    expect(db.page(id)).toBeUndefined();
    expect(db.events(id)).toHaveLength(0);
  });

  it.each([
    ["deny override", (db: StatefulD1, id: string) => db.setOverride(id, "deny")],
    ["allow override removed", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(`DELETE FROM cc_item_overrides WHERE item_id = ?`).run(id);
    }],
    ["irrelevant", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(`UPDATE items SET is_relevant = 0 WHERE id = ?`).run(id);
    }],
    ["deleted", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(`UPDATE items SET deleted_at = '2026-07-21' WHERE id = ?`).run(id);
    }],
    ["deduplicated", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items SET extra = json_set(extra, '$.dedup_of', 'blog:canonical') WHERE id = ?`,
      ).run(id);
    }],
    ["visible extra", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items SET extra = json_set(extra, '$.ai_summary_zh', 'CAS 后变化') WHERE id = ?`,
      ).run(id);
    }],
    ["title snapshot", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(`UPDATE items SET title = 'CAS 后标题变化' WHERE id = ?`).run(id);
    }],
    ["media snapshot", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items SET media = '[{"type":"image","url":"https://example.test/new.png"}]' WHERE id = ?`,
      ).run(id);
    }],
    ["feed policy", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items SET extra = json_set(extra, '$.feed_key', '36kr') WHERE id = ?`,
      ).run(id);
    }],
  ] as const)(
    "final D1 authorization CAS blocks initial publish when %s commits after bind",
    async (_label, mutate) => {
      const { db, r2, env } = setup();
      const id = db.insertSafeBlog();
      db.setOverride(id, "allow");
      db.beforeNextBatch = (state) => mutate(state, id);

      const result = await syncCcItemPage(env, id);

      expect(result.status).toBe("skipped");
      expect(result.eventCreated).toBe(false);
      expect(db.page(id)).toBeUndefined();
      expect(db.events(id)).toHaveLength(0);
      expect(r2.objects.size).toBe(1);
    },
  );

  it("final CAS cannot upsert a changed live page after a deny wins; it transitions the old page gone", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    await syncCcItemPage(env, id);
    const oldHash = db.page(id)!.content_hash;
    db.sqlite.prepare(
      `UPDATE items SET extra = json_set(extra, '$.ai_summary_zh', '待发布第二版') WHERE id = ?`,
    ).run(id);
    db.beforeNextBatch = (state) => state.setOverride(id, "deny");

    const result = await syncCcItemPage(env, id);

    expect(result.status).toBe("gone");
    expect(result.reason).toBe("final-authorization-changed");
    expect(db.page(id)!.status).toBe("gone");
    expect(db.page(id)!.content_hash).toBe(oldHash);
    expect(db.events(id).map((event) => event.op)).toEqual(["upsert", "delete"]);
    expect(r2.objects.size).toBe(2);
  });

  it("two different contents interleave safely: D1 commit order selects a matching immutable pointer", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    const pause = r2.pauseNextPut();
    const first = syncCcItemPage(env, id);
    await pause.started;

    db.sqlite.prepare(
      `UPDATE items SET extra = json_set(extra, '$.ai_summary_zh', '并发第二版') WHERE id = ?`,
    ).run(id);
    const second = await syncCcItemPage(env, id);
    pause.release();
    const firstResult = await first;

    expect(second.status).toBe("live");
    expect(firstResult.status).toBe("skipped");
    const page = db.page(id)!;
    const html = r2.text(String(page.r2_key))!;
    expect(await sha256(html)).toBe(page.content_hash);
    expect(String(page.r2_key)).toBe(
      ccItemPageR2Key(id, String(page.content_hash)),
    );
    expect(db.events(id).map((event) => event.op)).toEqual(["upsert"]);
    expect(r2.objects.size).toBe(2);
  });

  it("reports no delete event when a concurrent actor already marked the page gone", async () => {
    const { db, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    await syncCcItemPage(env, id);
    db.setOverride(id, "deny");
    db.beforeNextBatch = (state) => {
      state.sqlite.prepare(
        `UPDATE cc_item_pages SET status = 'gone' WHERE item_id = ?`,
      ).run(id);
    };

    const result = await syncCcItemPage(env, id);

    expect(result.status).toBe("gone");
    expect(result.eventCreated).toBe(false);
    expect(db.events(id).map((event) => event.op)).toEqual(["upsert"]);
  });

  it.each([
    ["deny", { china_negative: 1 }, "deny"],
    ["review", { uncertain: 1 }, "review"],
    ["pending", null, "pending"],
  ] as const)(
    "a force model %s with the same text hash wins before publish CAS and the stale pass cannot keep live",
    async (_label, flags, expectedStatus) => {
      const { db, r2, env } = setup({ apiKey: "unit-test-key" });
      const id = db.insertSafeBlog();
      await seedModelReview(db, env, id);
      await syncCcItemPage(env, id);
      const live = db.page(id)!;
      r2.objects.delete(String(live.r2_key));
      const pause = r2.pauseNextPut();
      const stalePublish = syncCcItemPage(env, id);
      await pause.started;

      if (flags === null) {
        env.DEEPSEEK_API_KEY = undefined;
      } else {
        mockReviewFlags(flags);
      }
      const newerReview = await reviewCcItem(env, id, { force: true });
      expect(newerReview.status).toBe(expectedStatus);
      expect(newerReview.reviewTextHash).toMatch(/^[0-9a-f]{64}$/);

      pause.release();
      const staleResult = await stalePublish;

      expect(staleResult.status).toBe("gone");
      expect(db.page(id)!.status).toBe("gone");
      expect(db.events(id).map((event) => event.op)).toEqual([
        "upsert",
        "delete",
      ]);
    },
  );

  it("a current allow override can explicitly bypass a newer model deny at final CAS", async () => {
    const { db, r2, env } = setup({ apiKey: "unit-test-key" });
    const id = db.insertSafeBlog();
    const reviewHash = await seedModelReview(db, env, id);
    await syncCcItemPage(env, id);
    const live = db.page(id)!;
    r2.objects.delete(String(live.r2_key));
    const pause = r2.pauseNextPut();
    const staleModelPublish = syncCcItemPage(env, id);
    await pause.started;

    db.sqlite.prepare(
      `UPDATE cc_item_reviews
       SET review_status = 'deny', reason = 'newer model deny'
       WHERE item_id = ?`,
    ).run(id);
    db.setOverride(id, "allow");
    pause.release();

    const result = await staleModelPublish;
    expect(result.status).toBe("live");
    expect(result.eventCreated).toBe(false);
    expect(db.page(id)!.status).toBe("live");
    expect(db.page(id)!.content_hash).toBe(live.content_hash);
    expect(reviewHash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.events(id).map((event) => event.op)).toEqual(["upsert"]);
  });

  it("does not publish allow A after a same-action allow B replaces its token", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow", "allow-token-a");
    db.beforeNextBatch = (state) => {
      state.setOverride(id, "allow", "allow-token-b");
    };

    const result = await syncCcItemPage(env, id, {
      expectedDecision: {
        action: "allow",
        token: "allow-token-a",
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("final-authorization-changed");
    expect(result.eventCreated).toBe(false);
    expect(db.page(id)).toBeUndefined();
    expect(db.events(id)).toHaveLength(0);
    expect(r2.objects.size).toBe(1);
  });

  it.each([
    ["source deny", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items
         SET extra = json_set(extra, '$.feed_key', 'qbitai')
         WHERE id = ?`,
      ).run(id);
    }, "source-deny:registry-policy:deny"],
    ["deleted item", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items
         SET deleted_at = '2026-07-21T00:00:00.000Z'
         WHERE id = ?`,
      ).run(id);
    }, "item-deleted"],
    ["irrelevant item", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items
         SET is_relevant = 0
         WHERE id = ?`,
      ).run(id);
    }, "item-not-relevant"],
    ["deduplicated item", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items
         SET extra = json_set(extra, '$.dedup_of', 'blog:canonical')
         WHERE id = ?`,
      ).run(id);
    }, "item-deduplicated"],
    ["review renderer failure", (db: StatefulD1, id: string) => {
      db.sqlite.prepare(
        `UPDATE items
         SET source_type = 'x_list', extra = 'null'
         WHERE id = ?`,
      ).run(id);
    }, "render-failed:render-item-failed"],
  ] as const)(
    "fails closed and removes H0 when the current allow token encounters %s",
    async (_label, mutate, expectedReason) => {
      const { db, r2, env } = setup();
      const id = db.insertSafeBlog();
      db.setOverride(id, "allow", "allow-token-current");
      await syncCcItemPage(env, id);
      const putsBefore = r2.puts.length;
      mutate(db, id);

      const result = await syncCcItemPage(env, id, {
        expectedDecision: {
          action: "allow",
          token: "allow-token-current",
        },
      });

      expect(result).toMatchObject({
        status: "gone",
        reason: expectedReason,
        eventCreated: true,
      });
      expect(db.page(id)).toMatchObject({
        status: "gone",
        reason: expectedReason,
      });
      expect(db.events(id).map((event) => event.op)).toEqual([
        "upsert",
        "delete",
      ]);
      expect(r2.puts).toHaveLength(putsBefore);
    },
  );

  it("fails closed and removes H0 when final authorization changes under the current allow token", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow", "allow-token-current");
    await syncCcItemPage(env, id);
    const oldHash = db.page(id)!.content_hash;
    db.sqlite.prepare(
      `UPDATE items
       SET extra = json_set(extra, '$.ai_summary_zh', '待发布第二版')
       WHERE id = ?`,
    ).run(id);
    db.beforeNextBatch = (state) => {
      state.sqlite.prepare(
        `UPDATE items
         SET deleted_at = '2026-07-21T00:00:00.000Z'
         WHERE id = ?`,
      ).run(id);
    };

    const result = await syncCcItemPage(env, id, {
      expectedDecision: {
        action: "allow",
        token: "allow-token-current",
      },
    });

    expect(result).toEqual({
      itemId: id,
      status: "gone",
      reason: "final-authorization-changed",
      eventCreated: true,
    });
    expect(db.page(id)).toMatchObject({
      status: "gone",
      content_hash: oldHash,
      reason: "final-authorization-changed",
    });
    expect(db.events(id).map((event) => event.op)).toEqual([
      "upsert",
      "delete",
    ]);
    expect(r2.objects.size).toBe(2);
  });

  it.each(["allow", "deny"] as const)(
    "does not let allow A remove B/H1 after a newer %s token replaces it",
    async (successorAction) => {
      const { db, env } = setup();
      const id = db.insertSafeBlog();
      db.setOverride(id, "allow", "initial-allow");
      await syncCcItemPage(env, id);
      db.setOverride(id, "allow", "allow-token-a");
      db.sqlite.prepare(
        `UPDATE items
         SET deleted_at = '2026-07-21T00:00:00.000Z'
         WHERE id = ?`,
      ).run(id);
      const successorHash = successorAction === "allow"
        ? "d".repeat(64)
        : "e".repeat(64);
      const successorKey = ccItemPageR2Key(id, successorHash)!;
      db.beforeNextBatch = (state) => {
        state.setOverride(id, successorAction, `${successorAction}-token-b`);
        state.sqlite.prepare(
          `UPDATE cc_item_pages
           SET content_hash = ?, r2_key = ?, status = 'live', reason = 'B live'
           WHERE item_id = ?`,
        ).run(successorHash, successorKey, id);
        state.sqlite.prepare(
          `INSERT INTO cc_page_events (
             item_id, op, content_hash, created_at
           ) VALUES (?, 'upsert', ?, '2026-07-21T00:00:00.000Z')`,
        ).run(id, successorHash);
      };

      const result = await syncCcItemPage(env, id, {
        expectedDecision: {
          action: "allow",
          token: "allow-token-a",
        },
      });

      expect(result.status).toBe("skipped");
      expect(result.eventCreated).toBe(false);
      expect(db.page(id)).toMatchObject({
        status: "live",
        content_hash: successorHash,
        r2_key: successorKey,
      });
      expect(db.events(id).map((event) => event.op)).toEqual([
        "upsert",
        "upsert",
      ]);
    },
  );

  it("does not let deny A remove a live page after same-action deny B replaces its token", async () => {
    const { db, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow", "initial-allow");
    await syncCcItemPage(env, id);
    const liveHash = db.page(id)!.content_hash;
    db.setOverride(id, "deny", "deny-token-a");
    db.beforeNextBatch = (state) => {
      state.setOverride(id, "deny", "deny-token-b");
    };

    const result = await syncCcItemPage(env, id, {
      expectedDecision: {
        action: "deny",
        token: "deny-token-a",
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.eventCreated).toBe(false);
    expect(db.page(id)).toMatchObject({
      status: "live",
      content_hash: liveHash,
    });
    expect(db.events(id).map((event) => event.op)).toEqual(["upsert"]);
  });
});

describe("markCcItemPageGone", () => {
  it("changes live to gone with one delete event and does nothing on repeats", async () => {
    const { db, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    await syncCcItemPage(env, id);

    const first = await markCcItemPageGone(env, id, "enrich-not-relevant");
    const second = await markCcItemPageGone(env, id, "enrich-not-relevant");

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(db.page(id)!.status).toBe("gone");
    expect(db.page(id)!.reason).toBe("enrich-not-relevant");
    expect(db.events(id).map((event) => event.op)).toEqual(["upsert", "delete"]);
  });

  it("does not let a stale gone operation delete a newer live content hash", async () => {
    const { db, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    await syncCcItemPage(env, id);
    const successorHash = "f".repeat(64);
    const successorKey = ccItemPageR2Key(id, successorHash)!;
    db.beforeNextBatch = (state) => {
      state.sqlite.prepare(
        `UPDATE cc_item_pages
         SET content_hash = ?, r2_key = ?, status = 'live', reason = 'new allow'
         WHERE item_id = ?`,
      ).run(successorHash, successorKey, id);
      state.sqlite.prepare(
        `INSERT INTO cc_page_events (item_id, op, content_hash, created_at)
         VALUES (?, 'upsert', ?, '2026-07-21T00:00:00.000Z')`,
      ).run(id, successorHash);
    };

    const deleted = await markCcItemPageGone(env, id, "stale deny");

    expect(deleted).toBe(false);
    expect(db.page(id)).toMatchObject({
      status: "live",
      content_hash: successorHash,
      r2_key: successorKey,
    });
    expect(db.events(id).map((event) => event.op)).toEqual([
      "upsert",
      "upsert",
    ]);
  });

  it("transitionToGone also leaves a newer allow/live successor untouched", async () => {
    const { db, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    await syncCcItemPage(env, id);
    db.setOverride(id, "deny");
    const successorHash = "e".repeat(64);
    const successorKey = ccItemPageR2Key(id, successorHash)!;
    db.beforeNextBatch = (state) => {
      state.setOverride(id, "allow");
      state.sqlite.prepare(
        `UPDATE cc_item_pages
         SET content_hash = ?, r2_key = ?, status = 'live', reason = 'new allow'
         WHERE item_id = ?`,
      ).run(successorHash, successorKey, id);
      state.sqlite.prepare(
        `INSERT INTO cc_page_events (item_id, op, content_hash, created_at)
         VALUES (?, 'upsert', ?, '2026-07-21T00:00:00.000Z')`,
      ).run(id, successorHash);
    };

    const staleDeny = await syncCcItemPage(env, id);

    expect(staleDeny.status).toBe("skipped");
    expect(staleDeny.eventCreated).toBe(false);
    expect(db.page(id)).toMatchObject({
      status: "live",
      content_hash: successorHash,
      r2_key: successorKey,
    });
    expect(db.events(id).map((event) => event.op)).toEqual([
      "upsert",
      "upsert",
    ]);
  });
});
