import { describe, expect, test, vi } from "vitest";

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

import worker from "./index";
import {
  HOME_FEED_SOURCES,
  buildHomeFeedQuery,
  encodeHomeFeedCursor,
  handleHomeFeed,
  isHomeRendererRequest,
  parseHomeFeedRequest,
} from "./home-feed";

const NOW = "2026-07-17T04:05:06.000Z";

function makeRow(index: number): Record<string, unknown> {
  const sourceType = HOME_FEED_SOURCES[index % HOME_FEED_SOURCES.length];
  return {
    id: `${sourceType}:fixture-${index}`,
    source_type: sourceType,
    source_id: `fixture-${index}`,
    source_ref: null,
    title: `Fixture ${index}`,
    content: `Body ${index}`,
    content_translated: null,
    author: "AI-Feeds",
    handle: null,
    url: null,
    media: "[]",
    metrics: "{}",
    published_at: `2026-07-17T03:${String(index).padStart(2, "0")}:00.000Z`,
    scraped_at: `2026-07-17T03:${String(index).padStart(2, "0")}:00.000Z`,
    is_relevant: 1,
    is_hot: 0,
    matched_by: null,
    lang: "zh",
    extra: "{}",
    _home_score: 1_752_720_000 - index,
    _sort_time: `2026-07-17T03:${String(index).padStart(2, "0")}:00.000Z`,
  };
}

function fakeDb(rows = Array.from({ length: 13 }, (_, index) => makeRow(index))) {
  const captures: { sql?: string; params?: unknown[] } = {};
  const all = vi.fn(async () => ({
    results: rows,
    meta: { duration: 4.25 },
  }));
  const bind = vi.fn((...params: unknown[]) => {
    captures.params = params;
    return { all };
  });
  const prepare = vi.fn((sql: string) => {
    captures.sql = sql;
    return { bind };
  });
  return { db: { prepare }, captures, prepare, bind, all };
}

describe("home feed request contract", () => {
  test("limits clamp to 12..48 and a fresh request freezes the supplied clock", () => {
    expect(parseHomeFeedRequest(new URL("https://internal/api/home-feed?limit=1"), NOW)).toEqual({
      limit: 12,
      asOf: NOW,
      cursor: null,
    });
    expect(parseHomeFeedRequest(new URL("https://internal/api/home-feed?limit=999"), NOW).limit).toBe(48);
    expect(parseHomeFeedRequest(new URL("https://internal/api/home-feed"), NOW).limit).toBe(24);
  });

  test("cursor round-trips a frozen as-of and strict keyset values", () => {
    const encoded = encodeHomeFeedCursor({
      version: 2,
      asOf: NOW,
      score: 1_752_720_000,
      sortTime: "2026-07-17T03:04:05.000Z",
      id: "github:openai/codex",
    });
    const parsed = parseHomeFeedRequest(
      new URL(`https://internal/api/home-feed?cursor=${encodeURIComponent(encoded)}`),
      "2027-01-01T00:00:00.000Z",
    );
    expect(parsed.asOf).toBe(NOW);
    expect(parsed.cursor).toEqual({
      version: 2,
      asOf: NOW,
      score: 1_752_720_000,
      sortTime: "2026-07-17T03:04:05.000Z",
      id: "github:openai/codex",
    });
  });

  test.each([
    "not-base64",
    Buffer.from(JSON.stringify({ version: 3, asOf: NOW, score: 1, sortTime: NOW, id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ version: 1, asOf: "tomorrow", score: 1, sortTime: NOW, id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ version: 1, asOf: NOW, score: 1.2, sortTime: NOW, id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ version: 1, asOf: NOW, score: 1, sortTime: "2026-02-31 03:04:05", id: "x" })).toString("base64url"),
    Buffer.from(JSON.stringify({ version: 1, asOf: NOW, score: 1, sortTime: NOW, id: "" })).toString("base64url"),
  ])("malformed cursor is rejected before query construction: %s", (cursor) => {
    expect(() => parseHomeFeedRequest(
      new URL(`https://internal/api/home-feed?cursor=${encodeURIComponent(cursor)}`),
      NOW,
    )).toThrow(/invalid home feed cursor/i);
  });

  test("legacy v1 cursors remain replayable during the rolling deployment", () => {
    const encoded = encodeHomeFeedCursor({
      version: 1,
      asOf: NOW,
      score: 1_752_720_000,
      sortTime: "2026-07-17T03:04:05.000Z",
      id: "github:openai/codex",
    });
    expect(parseHomeFeedRequest(
      new URL(`https://internal/api/home-feed?cursor=${encodeURIComponent(encoded)}`),
      "2027-01-01T00:00:00.000Z",
    ).cursor?.version).toBe(1);
  });
});

describe("home feed SQL", () => {
  test("bounds each source before deterministic family and source-aware scoring", () => {
    const { sql, params } = buildHomeFeedQuery({
      limit: 24,
      asOf: NOW,
      cursor: null,
      workflowCompletedFilter: true,
    });

    expect(HOME_FEED_SOURCES).toContain("youtube");
    for (const source of HOME_FEED_SOURCES) expect(sql).toContain(`'${source}'`);
    expect(sql).toMatch(/ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION BY items\.source_type[\s\S]*AS _candidate_rank/i);
    expect(sql).toContain("_candidate_rank <= 48");
    expect(sql).not.toMatch(/\bUNION(?:\s+ALL)?\b/i);
    expect(params.filter((value) => value === NOW)).toHaveLength(3);
    expect(sql).toMatch(/ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION BY items\.source_type/i);
    expect(sql).toMatch(/PARTITION BY _home_family[\s\S]*AS _family_rank/i);
    expect(sql).toMatch(/CASE\s+aged\.source_type[\s\S]*AS _heat_signal/i);
    expect(sql).toMatch(/COUNT\(_heat_signal\)\s+OVER\s*\(\s*PARTITION BY source_type\s*\)/i);
    expect(sql).toMatch(/RANK\(\)\s+OVER\s*\([\s\S]*PARTITION BY source_type[\s\S]*_heat_signal ASC[\s\S]*AS _heat_rank/i);
    expect(sql).toMatch(
      /_sort_epoch\s*-\s*\(\(_family_rank\s*-\s*1\)\s*\*\s*7200\)\s*-\s*\(\(_source_rank\s*-\s*1\)\s*\*\s*3600\)\s*\+\s*_heat_bonus/i,
    );
    expect(sql).toMatch(/WHEN _heat_signal IS NULL THEN 3600/i);
    expect(sql).toMatch(/MIN\(7200,\s*MAX\(0,/i);
    expect(sql).toContain("json_extract(items.extra, '$.workflow_completed_at') IS NOT NULL");
    expect(sql).toContain("json_extract(items.extra, '$.dedup_of') IS NULL");
    expect(sql).toContain("COALESCE(json_extract(items.extra, '$.cn_sensitive'), 0) != 1");
    expect(sql).toContain("items.deleted_at IS NULL");
    expect(sql).not.toMatch(/\bSELECT\s+\*/i);
    expect(params.at(-1)).toBe(25);
  });

  test("cursor query uses score, sort time, and id as one stable keyset", () => {
    const cursor = {
      version: 2 as const,
      asOf: NOW,
      score: 1_752_720_000,
      sortTime: "2026-07-17T03:04:05.000Z",
      id: "github:openai/codex",
    };
    const { sql, params } = buildHomeFeedQuery({
      limit: 12,
      asOf: NOW,
      cursor,
      workflowCompletedFilter: false,
    });

    expect(sql).toMatch(/_home_score < \?[\s\S]*_sort_time < \?[\s\S]*id < \?/);
    expect(params).toEqual(expect.arrayContaining([
      cursor.score,
      cursor.sortTime,
      cursor.id,
    ]));
    expect(sql).not.toContain("workflow_completed_at");
  });

  test("a legacy v1 cursor uses the former score while v2 remains the fresh default", () => {
    const { sql } = buildHomeFeedQuery({
      limit: 12,
      asOf: NOW,
      cursor: {
        version: 1,
        asOf: NOW,
        score: 1_752_720_000,
        sortTime: "2026-07-17T03:04:05.000Z",
        id: "x_list:legacy",
      },
      workflowCompletedFilter: false,
    });
    expect(sql).toMatch(/_sort_epoch\s*-\s*\(\(_source_rank\s*-\s*1\)\s*\*\s*10800\)/i);
  });
});

describe("home feed handler and origin scope", () => {
  test("renderer authentication is exact and route-scoped", () => {
    const token = "renderer-secret";
    expect(isHomeRendererRequest(
      new Request("https://worker/api/home-feed", {
        headers: { "X-Home-Renderer-Token": token },
      }),
      token,
    )).toBe(true);
    expect(isHomeRendererRequest(
      new Request("https://worker/api/items", {
        headers: { "X-Home-Renderer-Token": token },
      }),
      token,
    )).toBe(false);
    expect(isHomeRendererRequest(
      new Request("https://worker/api/home-feed", {
        headers: { "X-Home-Renderer-Token": `${token}-wrong` },
      }),
      token,
    )).toBe(false);
    expect(isHomeRendererRequest(
      new Request("https://worker/api/home-feed", {
        headers: { "X-Home-Renderer-Token": token },
      }),
      undefined,
    )).toBe(false);
  });

  test("wrong token and malformed cursor return before D1 work", async () => {
    const fake = fakeDb();
    const env = { DB: fake.db as unknown as D1Database, HOME_RENDERER_TOKEN: "right" };

    const forbidden = await handleHomeFeed(
      new Request("https://worker/api/home-feed", {
        headers: { "X-Home-Renderer-Token": "wrong" },
      }),
      env,
    );
    expect(forbidden.status).toBe(403);

    const invalid = await handleHomeFeed(
      new Request("https://worker/api/home-feed?cursor=bad", {
        headers: { "X-Home-Renderer-Token": "right" },
      }),
      env,
    );
    expect(invalid.status).toBe(400);
    expect(fake.prepare).not.toHaveBeenCalled();
  });

  test("valid response is private, timed, compact, and emits a stable next cursor", async () => {
    const fake = fakeDb();
    const response = await handleHomeFeed(
      new Request("https://worker/api/home-feed?limit=12", {
        headers: { "X-Home-Renderer-Token": "right" },
      }),
      {
        DB: fake.db as unknown as D1Database,
        HOME_RENDERER_TOKEN: "right",
        WORKFLOW_COMPLETED_FILTER: "true",
      },
      NOW,
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Server-Timing")).toBe("d1;dur=4.25");
    expect(body.view_mode).toBe("waterfall");
    expect(body.ranking_version).toBe(2);
    expect(body.generated_at).toBe(NOW);
    expect((body.items as unknown[])).toHaveLength(12);
    expect(body.has_more).toBe(true);
    expect(typeof body.next_cursor).toBe("string");
    expect(JSON.stringify(body)).not.toContain("_home_score");
    expect(fake.captures.sql).not.toMatch(/\bSELECT\s+\*/i);
  });

  test("D1 naive sort timestamps emit an exact cursor that can be replayed", async () => {
    const rows = Array.from({ length: 13 }, (_, index) => makeRow(index));
    rows[11] = {
      ...rows[11],
      _sort_time: "2026-07-17 03:11:00",
    };
    const fake = fakeDb(rows);
    const response = await handleHomeFeed(
      new Request("https://worker/api/home-feed?limit=12", {
        headers: { "X-Home-Renderer-Token": "right" },
      }),
      {
        DB: fake.db as unknown as D1Database,
        HOME_RENDERER_TOKEN: "right",
      },
      NOW,
    );
    const body = await response.json() as { next_cursor: string | null };

    expect(typeof body.next_cursor).toBe("string");
    const replay = parseHomeFeedRequest(
      new URL(`https://worker/api/home-feed?cursor=${encodeURIComponent(body.next_cursor!)}`),
      "2027-01-01T00:00:00.000Z",
    );
    expect(replay.cursor?.sortTime).toBe("2026-07-17 03:11:00");
  });

  test("scoped renderer token bypasses the production origin gate only for home-feed", async () => {
    const fake = fakeDb(Array.from({ length: 12 }, (_, index) => makeRow(index)));
    const env = {
      DB: fake.db as unknown as D1Database,
      AUTH_KV: {} as KVNamespace,
      ORIGIN_SECRET: "relay-secret",
      HOME_RENDERER_TOKEN: "renderer-secret",
    };

    const denied = await worker.fetch(
      new Request("https://xlist-api.workers.dev/api/home-feed"),
      env as never,
      {} as ExecutionContext,
    );
    expect(denied.status).toBe(403);

    const accepted = await worker.fetch(
      new Request("https://xlist-api.workers.dev/api/home-feed", {
        headers: { "X-Home-Renderer-Token": "renderer-secret" },
      }),
      env as never,
      {} as ExecutionContext,
    );
    expect(accepted.status).toBe(200);
  });
});
