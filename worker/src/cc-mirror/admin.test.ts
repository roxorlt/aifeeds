import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    ctx: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import worker, { type Env } from "../index";
import { serveAdminToolsHtml } from "../admin";
import {
  backfillCcMirror,
  handleCcMirrorAdmin,
  reconcileCcMirror,
} from "./admin";
import { buildCcReviewText } from "./review-text";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.resolve(here, "../../migrations/029-cc-content-mirror.sql"),
  "utf8",
);

class TestD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  writes = 0;
  prepares = 0;
  activeItemReads = 0;
  maxActiveItemReads = 0;
  itemReadDelayMs = 0;

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

  insertItem(opts: {
    id: string;
    sourceType?: string;
    extra?: Record<string, unknown> | string | null;
    title?: string;
  }): void {
    const sourceType = opts.sourceType ?? "x_list";
    const extra = typeof opts.extra === "string" || opts.extra === null
      ? opts.extra
      : JSON.stringify(opts.extra ?? {});
    this.sqlite.prepare(
      `INSERT INTO items (
         id, title, content, content_translated, author, handle, url, media,
         extra, source_type, is_relevant, deleted_at, published_at, scraped_at
       ) VALUES (?, ?, 'AI product details', 'AI 产品详情', 'Author', 'author',
         'https://example.com/item', '[]', ?, ?, 1, NULL,
         '2026-07-20T00:00:00.000Z', '2026-07-20T00:00:00.000Z')`,
    ).run(opts.id, opts.title ?? `Title ${opts.id}`, extra, sourceType);
  }

  insertOverride(itemId: string, action: "allow" | "deny"): void {
    this.sqlite.prepare(
      `INSERT INTO cc_item_overrides (item_id, action, reason, updated_at)
       VALUES (?, ?, 'fixture', '2026-07-20T00:00:00.000Z')`,
    ).run(itemId, action);
  }

  insertLivePage(itemId: string, hash = "a".repeat(64)): void {
    this.sqlite.prepare(
      `INSERT INTO cc_item_pages (
         item_id, source, url_path, r2_key, content_hash, title,
         published_at, generated_at, status, reason
       ) VALUES (?, 'news', ?, ?, ?, 'Fixture', NULL,
         '2026-07-20T00:00:00.000Z', 'live', 'fixture')`,
    ).run(
      itemId,
      `/i/news/${encodeURIComponent(itemId)}`,
      `cc-item-pages/news/${encodeURIComponent(itemId)}/${hash}.html`,
      hash,
    );
  }

  prepare(sql: string) {
    this.prepares += 1;
    let bindings: SQLInputValue[] = [];
    const statement = this.sqlite.prepare(sql);
    const prepared = {
      bind: (...values: unknown[]) => {
        bindings = values as SQLInputValue[];
        return prepared;
      },
      first: async <T>() => {
        const isItemRead = /SELECT\s+\*\s+FROM\s+items\s+WHERE\s+id/i.test(sql);
        if (isItemRead) {
          this.activeItemReads += 1;
          this.maxActiveItemReads = Math.max(
            this.maxActiveItemReads,
            this.activeItemReads,
          );
          if (this.itemReadDelayMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.itemReadDelayMs)
            );
          }
        }
        try {
          return (statement.get(...bindings) as T | undefined) ?? null;
        } finally {
          if (isItemRead) this.activeItemReads -= 1;
        }
      },
      all: async <T>() => ({
        results: statement.all(...bindings) as T[],
        success: true,
        meta: {},
      }),
      run: async () => {
        if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
          this.writes += 1;
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

class TestR2 {
  readonly objects = new Map<string, {
    value: string;
    customMetadata?: Record<string, string>;
  }>();
  puts = 0;

  async head(key: string) {
    const object = this.objects.get(key);
    return object
      ? { customMetadata: object.customMetadata }
      : null;
  }

  async put(
    key: string,
    value: string,
    options?: R2PutOptions,
  ): Promise<void> {
    this.puts += 1;
    this.objects.set(key, {
      value,
      customMetadata: options?.customMetadata,
    });
  }
}

const dbs: TestD1[] = [];
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  const db = new TestD1();
  const r2 = new TestR2();
  dbs.push(db);
  const env = {
    DB: db as unknown as D1Database,
    READMES: r2 as unknown as R2Bucket,
    ADMIN_USER: "admin",
    ADMIN_PASS: "pass",
    SITE_BASE: "https://ai-feeds.com",
    CC_SITE_BASE: "https://ai-feeds.cc",
    API_BASE: "https://api.ai-feeds.com",
  } as Env;
  return { db, r2, env };
}

function authed(
  path: string,
  init: RequestInit = {},
): Request {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Basic ${btoa("admin:pass")}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`https://admin.ai-feeds.com${path}`, {
    ...init,
    headers,
  });
}

function post(path: string, body: unknown): Request {
  return authed(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

describe("cc mirror admin authorization and routing", () => {
  it.each([
    ["GET", "/api/admin/cc-mirror/stats"],
    ["GET", "/api/admin/cc-mirror/reviews?status=review"],
    ["POST", "/api/admin/cc-mirror/decision"],
    ["POST", "/api/admin/cc-mirror/backfill"],
    ["POST", "/api/admin/cc-mirror/reconcile"],
  ])("authenticates before parsing or touching storage for %s %s", async (
    method,
    path,
  ) => {
    const poison = new Proxy({}, {
      get() {
        throw new Error("storage must not be touched");
      },
    });
    const env = {
      DB: poison,
      READMES: poison,
    } as unknown as Env;
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await handleCcMirrorAdmin(
      new Request(`https://example.com${path}`, {
        method,
        body: method === "POST" ? "not-json" : undefined,
      }),
      env,
    );

    expect(response?.status).toBe(401);
    expect(response?.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns authenticated 405/404 responses without caching", async () => {
    const { env } = setup();
    const methodResponse = await handleCcMirrorAdmin(
      authed("/api/admin/cc-mirror/stats", { method: "POST", body: "{}" }),
      env,
    );
    const missingResponse = await handleCcMirrorAdmin(
      authed("/api/admin/cc-mirror/nope"),
      env,
    );

    expect(methodResponse?.status).toBe(405);
    expect(methodResponse?.headers.get("Allow")).toBe("GET");
    expect(methodResponse?.headers.get("Cache-Control")).toBe(
      "private, no-store",
    );
    expect(missingResponse?.status).toBe(404);
  });

  it("is wired through the Worker fetch router", async () => {
    const { env } = setup();
    const response = await worker.fetch(
      authed("/api/admin/cc-mirror/stats"),
      env,
      {
        waitUntil() {},
        passThroughOnException() {},
      } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expect(await json(response)).toHaveProperty("source_policy");
  });

  it("adds a minimal safe operations form to the existing tools page", async () => {
    const { env } = setup();
    const response = await serveAdminToolsHtml(
      authed("/admin/tools"),
      env,
    );
    const html = await response.text();
    expect(html).toContain('data-testid="card-cc-mirror"');
    expect(html).toContain("/api/admin/cc-mirror/stats");
    expect(html).toContain("/api/admin/cc-mirror/decision");
    expect(html).toContain("ccMirrorOut");
    expect(html).toContain("out.textContent");
  });
});

describe("cc mirror review list and stats", () => {
  it("paginates reviews by strict item_id cursor and survives malformed flags", async () => {
    const { db, env } = setup();
    for (const id of ["x_list:001", "x_list:002", "x_list:003"]) {
      db.insertItem({ id, title: `Summary ${id}` });
      db.sqlite.prepare(
        `INSERT INTO cc_item_reviews (
           item_id, policy_version, source_policy, review_status, flags_json,
           reason, review_text_hash, model, reviewed_at
         ) VALUES (?, 1, 'allow', 'review', ?, 'needs review', ?, 'model',
           '2026-07-20T00:00:00.000Z')`,
      ).run(
        id,
        id === "x_list:002"
          ? "{"
          : JSON.stringify({
            china_negative: 0,
            politics_governance: 0,
            military_conflict: 0,
            sanctions_export_control: 1,
            other_cn_distribution_risk: 0,
            uncertain: 0,
            reasons: ["出口限制"],
          }),
        "b".repeat(64),
      );
    }

    const first = await handleCcMirrorAdmin(
      authed("/api/admin/cc-mirror/reviews?status=review&limit=2"),
      env,
    );
    expect(first?.status).toBe(200);
    const firstBody = await json(first!);
    expect(firstBody.items.map((row: any) => row.item_id)).toEqual([
      "x_list:001",
      "x_list:002",
    ]);
    expect(firstBody.items[1]).toMatchObject({
      flags_invalid: true,
      flags: { uncertain: 1 },
      title: "Summary x_list:002",
      source_type: "x_list",
      source_policy: "allow",
    });
    expect(firstBody.next_cursor).toBe("x_list:002");

    const second = await handleCcMirrorAdmin(
      authed(
        `/api/admin/cc-mirror/reviews?status=review&limit=2&cursor=${
          encodeURIComponent(firstBody.next_cursor)
        }`,
      ),
      env,
    );
    const secondBody = await json(second!);
    expect(secondBody.items.map((row: any) => row.item_id)).toEqual([
      "x_list:003",
    ]);
    expect(secondBody.next_cursor).toBeNull();
  });

  it.each([
    "/api/admin/cc-mirror/reviews?status=all",
    "/api/admin/cc-mirror/reviews?status=review&limit=0",
    "/api/admin/cc-mirror/reviews?status=review&limit=1.5",
    "/api/admin/cc-mirror/reviews?status=review&cursor=",
  ])("rejects invalid review query parameters: %s", async (path) => {
    const { env } = setup();
    const response = await handleCcMirrorAdmin(authed(path), env);
    expect(response?.status).toBe(400);
  });

  it("returns an explicit real-SQLite operations stats contract", async () => {
    const { db, env } = setup();
    db.insertItem({ id: "x_list:1" });
    db.insertItem({
      id: "podcast:lex:1",
      sourceType: "podcast",
      extra: { show_key: "lex-fridman" },
    });
    db.insertItem({
      id: "blog:qbitai:1",
      sourceType: "blog",
      extra: { feed_key: "qbitai" },
    });
    for (const [id, status] of [
      ["x_list:1", "pass"],
      ["podcast:lex:1", "review"],
      ["blog:qbitai:1", "deny"],
    ]) {
      db.sqlite.prepare(
        `INSERT INTO cc_item_reviews (
           item_id, policy_version, source_policy, review_status, flags_json,
           reason, review_text_hash, model, reviewed_at
         ) VALUES (?, 1, 'allow', ?, '{}', 'fixture', ?, NULL,
           '2026-07-20T00:00:00.000Z')`,
      ).run(id, status, "c".repeat(64));
    }
    db.insertLivePage("x_list:1");
    db.sqlite.prepare(
      `INSERT INTO cc_item_pages (
         item_id, source, url_path, r2_key, content_hash, title,
         generated_at, status, reason
       ) VALUES ('podcast:lex:1', 'news', '/i/news/lex',
         'cc-item-pages/news/lex/hash.html', ?, 'Lex',
         '2026-07-20T00:00:00.000Z', 'gone', 'fixture')`,
    ).run("d".repeat(64));
    db.sqlite.exec(
      `INSERT INTO cc_page_events (item_id, op, content_hash, created_at)
       VALUES ('x_list:1', 'upsert', '${"a".repeat(64)}', '2026-07-20T00:00:00.000Z');
       INSERT INTO cc_page_events (item_id, op, content_hash, created_at)
       VALUES ('podcast:lex:1', 'delete', NULL, '2026-07-20T01:00:00.000Z');`,
    );

    const response = await handleCcMirrorAdmin(
      authed("/api/admin/cc-mirror/stats"),
      env,
    );
    expect(response?.status).toBe(200);
    expect(await json(response!)).toEqual({
      source_policy: { allow: 1, manual: 1, deny: 1 },
      review_status: {
        pending: 0,
        pass: 1,
        review: 1,
        deny: 1,
        other: 0,
      },
      page_status: { live: 1, gone: 1, other: 0 },
      events: { total_events: 2, max_seq: 2 },
    });
  });
});

describe("cc mirror manual decisions", () => {
  it.each([
    ["invalid action", { item_id: "x_list:1", action: "pass", reason: "x" }],
    ["blank reason", { item_id: "x_list:1", action: "allow", reason: "   " }],
    [
      "long reason",
      { item_id: "x_list:1", action: "allow", reason: "x".repeat(501) },
    ],
    ["missing item", { item_id: "x_list:404", action: "allow", reason: "x" }],
  ])("rejects %s without an override write", async (_label, body) => {
    const { db, env } = setup();
    db.insertItem({ id: "x_list:1" });
    const response = await handleCcMirrorAdmin(
      post("/api/admin/cc-mirror/decision", body),
      env,
    );
    expect(response?.status).toBe(400);
    expect(
      db.sqlite.prepare("SELECT COUNT(*) AS n FROM cc_item_overrides").get(),
    ).toEqual({ n: 0 });
  });

  it("rejects malformed and oversized JSON bodies", async () => {
    const { env } = setup();
    const malformed = await handleCcMirrorAdmin(
      authed("/api/admin/cc-mirror/decision", {
        method: "POST",
        body: "{",
      }),
      env,
    );
    const oversized = await handleCcMirrorAdmin(
      authed("/api/admin/cc-mirror/decision", {
        method: "POST",
        body: JSON.stringify({ padding: "x".repeat(20_000) }),
      }),
      env,
    );
    expect(malformed?.status).toBe(400);
    expect(oversized?.status).toBe(413);
  });

  it("trims and stores allow reason, then immediately publishes", async () => {
    const { db, r2, env } = setup();
    db.insertItem({ id: "x_list:1" });
    const response = await handleCcMirrorAdmin(
      post("/api/admin/cc-mirror/decision", {
        item_id: "x_list:1",
        action: "allow",
        reason: "  人工确认纯 AI 产品内容  ",
      }),
      env,
    );

    expect(response?.status).toBe(200);
    expect(await json(response!)).toMatchObject({
      ok: true,
      item_id: "x_list:1",
      action: "allow",
      sync: { status: "live", eventCreated: true },
    });
    expect(
      db.sqlite.prepare(
        "SELECT action, reason FROM cc_item_overrides WHERE item_id = ?",
      ).get("x_list:1"),
    ).toEqual({
      action: "allow",
      reason: "人工确认纯 AI 产品内容",
    });
    expect(
      db.sqlite.prepare(
        "SELECT status FROM cc_item_pages WHERE item_id = ?",
      ).get("x_list:1"),
    ).toEqual({ status: "live" });
    expect(r2.puts).toBe(1);
  });

  it("stores deny and immediately creates one safe delete event", async () => {
    const { db, env } = setup();
    db.insertItem({ id: "x_list:1" });
    db.insertLivePage("x_list:1");

    const response = await handleCcMirrorAdmin(
      post("/api/admin/cc-mirror/decision", {
        item_id: "x_list:1",
        action: "deny",
        reason: "风险内容",
      }),
      env,
    );
    expect(response?.status).toBe(200);
    expect(await json(response!)).toMatchObject({
      ok: true,
      sync: { status: "gone", eventCreated: true },
    });
    expect(
      db.sqlite.prepare(
        "SELECT status, reason FROM cc_item_pages WHERE item_id = ?",
      ).get("x_list:1"),
    ).toEqual({ status: "gone", reason: "override-deny" });
    expect(
      db.sqlite.prepare(
        "SELECT op FROM cc_page_events WHERE item_id = ?",
      ).all("x_list:1"),
    ).toEqual([{ op: "delete" }]);
  });

  it("does not report success when the immediate sync fails", async () => {
    const { db, env } = setup();
    db.insertItem({ id: "x_list:1" });
    env.READMES = {
      head: async () => null,
      put: async () => {
        throw new Error("secret-looking downstream detail");
      },
    } as unknown as R2Bucket;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleCcMirrorAdmin(
      post("/api/admin/cc-mirror/decision", {
        item_id: "x_list:1",
        action: "allow",
        reason: "人工允许",
      }),
      env,
    );
    expect(response?.status).toBe(502);
    expect(await json(response!)).toEqual({
      error: "cc_mirror_sync_failed",
      item_id: "x_list:1",
    });
    expect(log.mock.calls.flat().join(" ")).not.toContain("secret-looking");
  });
});

describe("cc mirror backfill and reconcile", () => {
  it("uses strict source/feed mapping, stable cursors, and accurate result buckets", async () => {
    const { db, env } = setup();
    db.insertItem({
      id: "blog:openai:001",
      sourceType: "blog",
      extra: { feed_key: "openai", title_zh: "AI 更新", excerpt_zh: "摘要" },
    });
    db.insertItem({
      id: "blog:openai:002",
      sourceType: "blog",
      extra: { feed_key: "openai", title_zh: "AI 更新", excerpt_zh: "摘要" },
    });
    db.insertItem({
      id: "blog:anthropic:001",
      sourceType: "blog",
      extra: { feed_key: "anthropic" },
    });
    db.insertOverride("blog:openai:001", "allow");
    db.insertOverride("blog:openai:002", "deny");
    db.insertOverride("blog:anthropic:001", "allow");

    const first = await backfillCcMirror(env, {
      source: "news",
      feedKey: "openai",
      limit: 1,
      dry: true,
    });
    expect(first).toEqual({
      scanned: 1,
      live: 1,
      review: 0,
      denied: 0,
      pending: 0,
      nextCursor: "blog:openai:001",
    });
    const second = await backfillCcMirror(env, {
      source: "news",
      feedKey: "openai",
      cursor: first.nextCursor!,
      limit: 1,
      dry: true,
    });
    expect(second).toEqual({
      scanned: 1,
      live: 0,
      review: 0,
      denied: 1,
      pending: 0,
      nextCursor: null,
    });
  });

  it("caps per-item concurrency at five and keeps dry runs D1/R2 write-free", async () => {
    const { db, r2, env } = setup();
    for (let i = 1; i <= 9; i++) {
      const id = `x_list:${String(i).padStart(3, "0")}`;
      db.insertItem({ id });
      db.insertOverride(id, "allow");
    }
    db.itemReadDelayMs = 5;
    db.writes = 0;

    const result = await backfillCcMirror(env, {
      source: "x",
      limit: 9,
      dry: true,
    });

    expect(result).toMatchObject({ scanned: 9, live: 9 });
    expect(db.maxActiveItemReads).toBe(5);
    expect(db.writes).toBe(0);
    expect(r2.puts).toBe(0);
  });

  it.each([
    [{ source: "bad" }, 400],
    [{ source: "x", feed_key: "openai" }, 400],
    [{ source: "x", limit: 101 }, 400],
    [{ source: "x", limit: 1.5 }, 400],
    [{ source: "x", dry: "yes" }, 400],
    [{ source: "x", force_review: 2 }, 400],
    [{ source: "x", limti: 20 }, 400],
  ])("validates backfill body %j", async (body, status) => {
    const { env } = setup();
    const response = await handleCcMirrorAdmin(
      post("/api/admin/cc-mirror/backfill", body),
      env,
    );
    expect(response?.status).toBe(status);
  });

  it("ignores malformed news extra safely while binding feed_key", async () => {
    const { db, env } = setup();
    db.insertItem({
      id: "blog:broken:001",
      sourceType: "blog",
      extra: "{",
    });
    const response = await handleCcMirrorAdmin(
      post("/api/admin/cc-mirror/backfill", {
        source: "news",
        feed_key: "openai",
        limit: 20,
        dry: 1,
      }),
      env,
    );
    expect(response?.status).toBe(200);
    expect(await json(response!)).toMatchObject({ scanned: 0 });
  });

  it("restores persisted pending reviews with force_review", async () => {
    const { db, env } = setup();
    db.insertItem({ id: "x_list:001" });
    const row = db.sqlite.prepare(
      "SELECT * FROM items WHERE id = ?",
    ).get("x_list:001") as Record<string, unknown>;
    const reviewText = buildCcReviewText(row as never, env);
    const currentHash = await sha256(reviewText.hashInput);
    db.sqlite.prepare(
      `INSERT INTO cc_item_reviews (
         item_id, policy_version, source_policy, review_status, flags_json,
         reason, review_text_hash, model, reviewed_at
       ) VALUES (?, 1, 'allow', 'pending', ?, 'missing-api-key', ?, NULL,
         '2026-07-20T00:00:00.000Z')`,
    ).run(
      "x_list:001",
      JSON.stringify({
        china_negative: 0,
        politics_governance: 0,
        military_conflict: 0,
        sanctions_export_control: 0,
        other_cn_distribution_risk: 0,
        uncertain: 1,
        reasons: ["old"],
      }),
      currentHash,
    );
    env.DEEPSEEK_API_KEY = "fake-key";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              china_negative: 0,
              politics_governance: 0,
              military_conflict: 0,
              sanctions_export_control: 0,
              other_cn_distribution_risk: 0,
              uncertain: 0,
              reasons: [],
            }),
          },
          finish_reason: "stop",
        }],
      }), { status: 200 })
    ));

    const cached = await handleCcMirrorAdmin(
      post("/api/admin/cc-mirror/backfill", {
        source: "x",
        limit: 1,
      }),
      env,
    );
    expect(await json(cached!)).toMatchObject({
      scanned: 1,
      live: 0,
      pending: 1,
    });
    expect(fetch).not.toHaveBeenCalled();

    const response = await handleCcMirrorAdmin(
      post("/api/admin/cc-mirror/backfill", {
        source: "x",
        limit: 1,
        force_review: 1,
      }),
      env,
    );
    expect(response?.status).toBe(200);
    expect(await json(response!)).toMatchObject({
      scanned: 1,
      live: 1,
      pending: 0,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      db.sqlite.prepare(
        "SELECT review_status FROM cc_item_reviews WHERE item_id = ?",
      ).get("x_list:001"),
    ).toEqual({ review_status: "pass" });
  });

  it("reapplies current policy, emits one delete, and is idempotent", async () => {
    const { db, env } = setup();
    db.insertItem({
      id: "blog:qbitai:001",
      sourceType: "blog",
      extra: { feed_key: "qbitai" },
    });
    db.insertLivePage("blog:qbitai:001");

    const first = await reconcileCcMirror(env, { limit: 20 });
    const second = await reconcileCcMirror(env, { limit: 20 });

    expect(first).toMatchObject({ scanned: 1, denied: 1 });
    expect(second).toMatchObject({ scanned: 1, denied: 1 });
    expect(
      db.sqlite.prepare(
        "SELECT status FROM cc_item_pages WHERE item_id = ?",
      ).get("blog:qbitai:001"),
    ).toEqual({ status: "gone" });
    expect(
      db.sqlite.prepare(
        "SELECT op FROM cc_page_events WHERE item_id = ? ORDER BY seq",
      ).all("blog:qbitai:001"),
    ).toEqual([{ op: "delete" }]);
  });
});
