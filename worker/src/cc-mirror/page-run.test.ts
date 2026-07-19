import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../index";
import type { RenderRow } from "../digest/render";
import { CC_REVIEW_POLICY_VERSION } from "./review";
import { buildCcReviewText } from "./review-text";
import {
  ccItemPageR2Key,
  markCcItemPageGone,
  syncCcItemPage,
} from "./page-run";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.resolve(here, "../../migrations/029-cc-content-mirror.sql"),
  "utf8",
);

type MutationHook = (db: StatefulD1) => void;

class StatefulD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  writeCount = 0;
  itemReads = 0;
  overrideReads = 0;
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

  setOverride(itemId: string, action: "allow" | "deny"): void {
    this.sqlite.prepare(
      `INSERT INTO cc_item_overrides (item_id, action, reason, updated_at)
       VALUES (?, ?, 'test', '2026-07-20T00:00:00.000Z')
       ON CONFLICT(item_id) DO UPDATE SET action = excluded.action`,
    ).run(itemId, action);
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
  readonly objects = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string }> = [];
  failNextPut = false;

  async put(key: string, value: string): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("R2 unavailable");
    }
    this.puts.push({ key, value });
    this.objects.set(key, value);
  }
}

const resources: StatefulD1[] = [];
afterEach(() => {
  while (resources.length) resources.pop()!.close();
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

describe("ccItemPageR2Key", () => {
  it("uses an isolated cc-item-pages namespace and rejects malformed/unsupported ids", () => {
    expect(ccItemPageR2Key("github:owner/repo")).toBe(
      "cc-item-pages/gh/github%3Aowner%2Frepo.html",
    );
    expect(ccItemPageR2Key("blog:openai:item-1")).toBe(
      "cc-item-pages/news/blog%3Aopenai%3Aitem-1.html",
    );
    expect(ccItemPageR2Key("github:missing-repo")).toBeNull();
    expect(ccItemPageR2Key("clawhub:item")).toBeNull();
    expect(ccItemPageR2Key("../escape")).toBeNull();
  });
});

describe("syncCcItemPage", () => {
  it("review pass writes R2 first, records a live page with the exact HTML hash, and appends one upsert event", async () => {
    const { db, r2, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");

    const result = await syncCcItemPage(env, id);
    const page = db.page(id)!;
    const html = r2.objects.get(String(page.r2_key))!;

    expect(result).toEqual({
      itemId: id,
      status: "live",
      reason: "override-allow",
      eventCreated: true,
    });
    expect(String(page.status)).toBe("live");
    expect(String(page.url_path)).toBe("/i/news/blog%3Aopenai%3Aitem-1");
    expect(String(page.content_hash)).toBe(await sha256(html));
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
    await syncCcItemPage(env, id);
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
});

describe("markCcItemPageGone", () => {
  it("changes live to gone with one delete event and does nothing on repeats", async () => {
    const { db, env } = setup();
    const id = db.insertSafeBlog();
    db.setOverride(id, "allow");
    await syncCcItemPage(env, id);

    await markCcItemPageGone(env, id, "enrich-not-relevant");
    await markCcItemPageGone(env, id, "enrich-not-relevant");

    expect(db.page(id)!.status).toBe("gone");
    expect(db.page(id)!.reason).toBe("enrich-not-relevant");
    expect(db.events(id).map((event) => event.op)).toEqual(["upsert", "delete"]);
  });
});
