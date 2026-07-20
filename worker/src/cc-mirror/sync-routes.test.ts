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
import { signCcSyncRequest } from "./auth";
import { ccItemPageR2Key } from "./page-run";
import { handleCcSyncRoute } from "./sync-routes";

const SECRET = "cc-sync-route-fixture-secret";
const API = "https://api.ai-feeds.com";
const HASH_1 = "1".repeat(64);
const HASH_2 = "2".repeat(64);
const HASH_3 = "3".repeat(64);

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = [
  "029-cc-content-mirror.sql",
  "030-cc-content-mirror-decision-token.sql",
  "031-cc-content-mirror-bootstrap-index.sql",
].map((file) =>
  fs.readFileSync(path.resolve(here, "../../migrations", file), "utf8")
).join("\n");

class ObservableD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  calls = 0;

  constructor() {
    this.sqlite.exec(migration);
  }

  page(input: {
    itemId: string;
    source?: string;
    urlPath: string;
    hash: string | null;
    title?: string;
    publishedAt?: string | null;
    status?: "live" | "gone";
  }): void {
    this.sqlite.prepare(
      `INSERT INTO cc_item_pages (
         item_id, source, url_path, r2_key, content_hash, title,
         published_at, generated_at, status, reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, '2026-07-20T00:00:00Z', ?, 'test')`,
    ).run(
      input.itemId,
      input.source ?? "news",
      input.urlPath,
      input.hash
        ? ccItemPageR2Key(input.itemId, input.hash)
        : "cc-item-pages/gone",
      input.hash,
      input.title ?? input.itemId,
      input.publishedAt ?? null,
      input.status ?? "live",
    );
  }

  event(
    itemId: string,
    op: "upsert" | "delete",
    hash: string | null,
  ): number {
    const result = this.sqlite.prepare(
      `INSERT INTO cc_page_events (item_id, op, content_hash, created_at)
       VALUES (?, ?, ?, '2026-07-20T00:00:00Z')`,
    ).run(itemId, op, hash);
    return Number(result.lastInsertRowid);
  }

  prepare(sql: string) {
    this.calls += 1;
    let bindings: SQLInputValue[] = [];
    const statement = this.sqlite.prepare(sql);
    const prepared = {
      bind: (...values: unknown[]) => {
        bindings = values as SQLInputValue[];
        return prepared;
      },
      first: async <T>() =>
        (statement.get(...bindings) as T | undefined) ?? null,
      all: async <T>() => ({
        results: statement.all(...bindings) as T[],
        success: true,
        meta: {},
      }),
      run: async () => {
        const result = statement.run(...bindings);
        return {
          success: true,
          meta: { changes: Number(result.changes) },
        };
      },
    };
    return prepared;
  }

  close(): void {
    this.sqlite.close();
  }
}

class ObservableR2 {
  readonly objects = new Map<string, {
    bytes: Uint8Array;
    contentHash?: string;
  }>();
  calls = 0;

  put(
    itemId: string,
    hash: string,
    html: string,
    contentHash = hash,
  ): void {
    const key = ccItemPageR2Key(itemId, hash);
    if (!key) throw new Error("invalid test R2 key");
    this.objects.set(key, {
      bytes: new TextEncoder().encode(html),
      contentHash,
    });
  }

  async get(key: string) {
    this.calls += 1;
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      customMetadata: object.contentHash === undefined
        ? undefined
        : { contentHash: object.contentHash },
      arrayBuffer: async () =>
        object.bytes.buffer.slice(
          object.bytes.byteOffset,
          object.bytes.byteOffset + object.bytes.byteLength,
        ),
    };
  }
}

const databases: ObservableD1[] = [];
afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

function makeEnv(
  db = new ObservableD1(),
  r2 = new ObservableR2(),
  overrides: Partial<Env> = {},
): Env {
  databases.push(db);
  return {
    DB: db,
    READMES: r2,
    CC_SYNC_SECRET: SECRET,
    ...overrides,
  } as unknown as Env;
}

function unsigned(
  pathname: string,
  init: RequestInit = {},
): Request {
  return new Request(`${API}${pathname}`, init);
}

async function signed(
  pathname: string,
  init: RequestInit = {},
): Promise<Request> {
  const req = unsigned(pathname, init);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signCcSyncRequest(req, SECRET, timestamp);
  const headers = new Headers(req.headers);
  headers.set("X-CC-Timestamp", timestamp);
  headers.set("X-CC-Signature", signature);
  return new Request(req, { headers });
}

async function route(
  pathname: string,
  env: Env,
  init: RequestInit = {},
): Promise<Response> {
  const response = await handleCcSyncRoute(
    await signed(pathname, init),
    env,
  );
  if (!response) throw new Error("expected cc sync response");
  return response;
}

function expectNoStore(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

describe("cc sync routing and auth order", () => {
  it("authenticates every sync path before parsing params or touching D1/R2", async () => {
    const db = new ObservableD1();
    const r2 = new ObservableR2();
    const env = makeEnv(db, r2);
    for (const pathname of [
      "/api/cc-sync/bootstrap?limit=not-a-number",
      "/api/cc-sync/changes?after_seq=not-a-number",
      `/api/cc-sync/page?item_id=x_list%3A1&content_hash=${HASH_1}`,
      "/api/cc-sync/health",
      "/api/cc-sync/unknown",
    ]) {
      const response = await handleCcSyncRoute(unsigned(pathname), env);
      expect(response?.status, pathname).toBe(401);
      expectNoStore(response!);
    }
    expect(db.calls).toBe(0);
    expect(r2.calls).toBe(0);
  });

  it("returns 503 without its dedicated secret; authenticates before 405/404", async () => {
    const db = new ObservableD1();
    const r2 = new ObservableR2();
    const missingSecret = makeEnv(db, r2, {
      CC_SYNC_SECRET: undefined,
      BRIDGE_SECRET: SECRET,
    });
    const unavailable = await handleCcSyncRoute(
      unsigned("/api/cc-sync/health"),
      missingSecret,
    );
    expect(unavailable?.status).toBe(503);
    expectNoStore(unavailable!);

    const env = makeEnv(new ObservableD1(), new ObservableR2());
    const wrongMethod = await route(
      "/api/cc-sync/health",
      env,
      { method: "POST", body: "signed-body" },
    );
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("Allow")).toBe("GET");
    expectNoStore(wrongMethod);

    const unknown = await route("/api/cc-sync/not-real", env);
    expect(unknown.status).toBe(404);
    expectNoStore(unknown);
  });

  it("serves an authenticated minimal health response without CORS credentials", async () => {
    const env = makeEnv();
    const response = await route("/api/cc-sync/health", env);
    expect(response.status).toBe(200);
    expectNoStore(response);
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(false);
    expect(await response.json()).toEqual({
      ok: true,
      db_configured: true,
      r2_configured: true,
    });
  });
});

describe("cc sync bootstrap", () => {
  it("paginates only live pages with a fixed watermark and converges later events", async () => {
    const db = new ObservableD1();
    const env = makeEnv(db);
    db.page({
      itemId: "blog:openai:b",
      urlPath: "/i/news/openai/b",
      hash: HASH_1,
      title: "B",
    });
    db.page({
      itemId: "blog:openai:c",
      urlPath: "/i/news/openai/c",
      hash: HASH_2,
      title: "C",
      publishedAt: "2026-07-19T00:00:00Z",
    });
    db.page({
      itemId: "blog:openai:d",
      urlPath: "/i/news/openai/d",
      hash: HASH_3,
      status: "gone",
    });
    db.event("blog:openai:b", "upsert", HASH_1);
    const watermark = db.event("blog:openai:c", "upsert", HASH_2);

    const first = await route(
      "/api/cc-sync/bootstrap?after_item_id=&limit=1&watermark=",
      env,
    );
    expect(first.status).toBe(200);
    expectNoStore(first);
    const firstBody = await first.json() as {
      watermark: number;
      items: Array<Record<string, unknown>>;
      next_after_item_id: string | null;
    };
    expect(firstBody).toEqual({
      watermark,
      items: [{
        item_id: "blog:openai:b",
        source: "news",
        url_path: "/i/news/openai/b",
        content_hash: HASH_1,
        title: "B",
        published_at: null,
      }],
      next_after_item_id: "blog:openai:b",
    });

    // This event lands after the bootstrap watermark and sorts before the
    // already-consumed item cursor. It must be recovered by `changes`.
    db.page({
      itemId: "blog:openai:a",
      urlPath: "/i/news/openai/a",
      hash: HASH_3,
      title: "A",
    });
    const laterSeq = db.event("blog:openai:a", "upsert", HASH_3);

    const second = await route(
      `/api/cc-sync/bootstrap?after_item_id=blog%3Aopenai%3Ab&limit=1&watermark=${watermark}`,
      env,
    );
    expect(await second.json()).toEqual({
      watermark,
      items: [{
        item_id: "blog:openai:c",
        source: "news",
        url_path: "/i/news/openai/c",
        content_hash: HASH_2,
        title: "C",
        published_at: "2026-07-19T00:00:00Z",
      }],
      next_after_item_id: null,
    });

    const changes = await route(
      `/api/cc-sync/changes?after_seq=${watermark}&limit=200`,
      env,
    );
    const changeBody = await changes.json() as {
      items: Array<Record<string, unknown>>;
      next_after_seq: number;
    };
    expect(changeBody.items.map((item) => item.seq)).toEqual([laterSeq]);
    expect(changeBody.next_after_seq).toBe(laterSeq);
  });

  it("validates canonical cursors, watermark, and bounded limit", async () => {
    const db = new ObservableD1();
    const env = makeEnv(db);
    db.event("seed", "delete", null);

    for (const pathname of [
      "/api/cc-sync/bootstrap?after_item_id=x",
      "/api/cc-sync/bootstrap?after_item_id=x&watermark=2",
      "/api/cc-sync/bootstrap?watermark=1",
      "/api/cc-sync/bootstrap?limit=0",
      "/api/cc-sync/bootstrap?limit=501",
      "/api/cc-sync/bootstrap?limit=0200",
      "/api/cc-sync/bootstrap?limit=200&limit=201",
      "/api/cc-sync/bootstrap?watermark=-1",
    ]) {
      const response = await route(pathname, env);
      expect(response.status, pathname).toBe(400);
      expectNoStore(response);
    }
  });
});

describe("cc sync changes", () => {
  it("preserves repeated item events in seq order and uses current page metadata", async () => {
    const db = new ObservableD1();
    const env = makeEnv(db);
    db.page({
      itemId: "x_list:42",
      source: "x",
      urlPath: "/i/x/42",
      hash: HASH_2,
      title: "Current title",
      publishedAt: "2026-07-18T00:00:00Z",
      status: "gone",
    });
    const seq1 = db.event("x_list:42", "upsert", HASH_1);
    const seq2 = db.event("x_list:42", "upsert", HASH_2);
    const seq3 = db.event("x_list:42", "delete", null);

    const first = await route(
      "/api/cc-sync/changes?after_seq=0&limit=2",
      env,
    );
    expect(await first.json()).toEqual({
      items: [
        {
          seq: seq1,
          item_id: "x_list:42",
          op: "upsert",
          source: "x",
          url_path: "/i/x/42",
          content_hash: HASH_1,
          title: "Current title",
          published_at: "2026-07-18T00:00:00Z",
        },
        {
          seq: seq2,
          item_id: "x_list:42",
          op: "upsert",
          source: "x",
          url_path: "/i/x/42",
          content_hash: HASH_2,
          title: "Current title",
          published_at: "2026-07-18T00:00:00Z",
        },
      ],
      next_after_seq: seq2,
    });

    const second = await route(
      `/api/cc-sync/changes?after_seq=${seq2}&limit=2`,
      env,
    );
    expect((await second.json() as { items: unknown[] }).items).toEqual([{
      seq: seq3,
      item_id: "x_list:42",
      op: "delete",
      source: "x",
      url_path: "/i/x/42",
      content_hash: null,
      title: "Current title",
      published_at: "2026-07-18T00:00:00Z",
    }]);
  });

  it("is conservative when a historical event has no page row", async () => {
    const db = new ObservableD1();
    const env = makeEnv(db);
    const seq = db.event("missing:item", "delete", null);
    const response = await route(
      "/api/cc-sync/changes?after_seq=0&limit=200",
      env,
    );
    expect(await response.json()).toEqual({
      items: [{
        seq,
        item_id: "missing:item",
        op: "delete",
        source: "",
        url_path: "",
        content_hash: null,
        title: "",
        published_at: null,
      }],
      next_after_seq: seq,
    });
  });

  it("requires canonical after_seq and validates limit", async () => {
    const env = makeEnv();
    for (const pathname of [
      "/api/cc-sync/changes",
      "/api/cc-sync/changes?after_seq=",
      "/api/cc-sync/changes?after_seq=-1",
      "/api/cc-sync/changes?after_seq=01",
      "/api/cc-sync/changes?after_seq=1.0",
      "/api/cc-sync/changes?after_seq=0&limit=501",
      "/api/cc-sync/changes?after_seq=0&after_seq=1",
    ]) {
      const response = await route(pathname, env);
      expect(response.status, pathname).toBe(400);
      expectNoStore(response);
    }
  });
});

describe("cc sync immutable page retrieval", () => {
  it("serves H1 and H2 after the current page is gone", async () => {
    const db = new ObservableD1();
    const r2 = new ObservableR2();
    const env = makeEnv(db, r2);
    const itemId = "x_list:42";
    const html1 = "<!doctype html><title>H1</title>";
    const html2 = "<!doctype html><title>H2</title>";
    const realHash1 = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(html1),
    ).then((value) =>
      [...new Uint8Array(value)].map((v) => v.toString(16).padStart(2, "0"))
        .join("")
    );
    const realHash2 = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(html2),
    ).then((value) =>
      [...new Uint8Array(value)].map((v) => v.toString(16).padStart(2, "0"))
        .join("")
    );
    db.page({
      itemId,
      source: "x",
      urlPath: "/i/x/42",
      hash: realHash2,
      status: "gone",
    });
    db.event(itemId, "upsert", realHash1);
    db.event(itemId, "upsert", realHash2);
    db.event(itemId, "delete", null);
    r2.put(itemId, realHash1, html1);
    r2.put(itemId, realHash2, html2);

    for (const [hash, html] of [
      [realHash1, html1],
      [realHash2, html2],
    ]) {
      const response = await route(
        `/api/cc-sync/page?item_id=${encodeURIComponent(itemId)}&content_hash=${hash}`,
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(response.headers.get("ETag")).toBe(hash);
      expectNoStore(response);
      expect(await response.text()).toBe(html);
    }
  });

  it("returns uniform 404 for invalid/unpublished/missing versions without unsafe R2 reads", async () => {
    const db = new ObservableD1();
    const r2 = new ObservableR2();
    const env = makeEnv(db, r2);
    for (const pathname of [
      "/api/cc-sync/page",
      `/api/cc-sync/page?item_id=x_list%3A42&content_hash=${HASH_1.toUpperCase()}`,
      `/api/cc-sync/page?item_id=x_list%3A42&content_hash=${HASH_1}`,
      `/api/cc-sync/page?item_id=x_list%3A42&item_id=x_list%3A43&content_hash=${HASH_1}`,
    ]) {
      const before = r2.calls;
      const response = await route(pathname, env);
      expect(response.status, pathname).toBe(404);
      expectNoStore(response);
      expect(r2.calls, pathname).toBe(before);
    }

    db.event("x_list:42", "upsert", HASH_1);
    const missing = await route(
      `/api/cc-sync/page?item_id=x_list%3A42&content_hash=${HASH_1}`,
      env,
    );
    expect(missing.status).toBe(404);
    expectNoStore(missing);
  });

  it("fails closed when immutable metadata or bytes are tampered", async () => {
    const db = new ObservableD1();
    const r2 = new ObservableR2();
    const env = makeEnv(db, r2);
    const itemId = "blog:openai:tampered";
    db.event(itemId, "upsert", HASH_1);
    r2.put(itemId, HASH_1, "wrong bytes", HASH_1);

    const bytesMismatch = await route(
      `/api/cc-sync/page?item_id=${encodeURIComponent(itemId)}&content_hash=${HASH_1}`,
      env,
    );
    expect(bytesMismatch.status).toBe(503);
    expectNoStore(bytesMismatch);

    r2.put(itemId, HASH_1, "wrong bytes", HASH_2);
    const metadataMismatch = await route(
      `/api/cc-sync/page?item_id=${encodeURIComponent(itemId)}&content_hash=${HASH_1}`,
      env,
    );
    expect(metadataMismatch.status).toBe(503);
    expectNoStore(metadataMismatch);
  });
});

describe("index wiring", () => {
  it("lets blocked bot UAs reach only the HMAC-protected sync prefix", async () => {
    const env = makeEnv();
    const req = await signed("/api/cc-sync/health");
    const headers = new Headers(req.headers);
    headers.set("User-Agent", "python-requests/2.32");
    const response = await worker.fetch(
      new Request(req, { headers }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(200);
    expectNoStore(response);

    const unsignedResponse = await worker.fetch(
      new Request(`${API}/api/cc-sync/health`, {
        headers: { "User-Agent": "python-requests/2.32" },
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    );
    expect(unsignedResponse.status).toBe(401);
    expectNoStore(unsignedResponse);
  });
});
