import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Env } from "../index";
import {
  CC_REVIEW_POLICY_VERSION,
  type CcRiskFlags,
  reviewCcItem,
} from "./review";

const here = path.dirname(fileURLToPath(import.meta.url));
const migration = fs.readFileSync(
  path.resolve(here, "../../migrations/029-cc-content-mirror.sql"),
  "utf8",
);

const SAFE_FLAGS: CcRiskFlags = {
  china_negative: 0,
  politics_governance: 0,
  military_conflict: 0,
  sanctions_export_control: 0,
  other_cn_distribution_risk: 0,
  uncertain: 0,
  reasons: [],
};

interface ItemInput {
  id?: string;
  title?: string | null;
  content?: string | null;
  content_translated?: string | null;
  author?: string | null;
  handle?: string | null;
  url?: string | null;
  media?: string | null;
  extra?: string | null;
  source_type?: string;
  is_relevant?: number | null;
  deleted_at?: string | null;
}

class StatefulD1 {
  readonly sqlite = new DatabaseSync(":memory:");
  writeCount = 0;
  readonly preparedSql: string[] = [];

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
        deleted_at TEXT
      );
    `);
    this.sqlite.exec(migration);
  }

  insertItem(input: ItemInput = {}): string {
    const item = {
      id: "blog:openai:item-1",
      title: "AI 产品更新",
      content: null,
      content_translated: null,
      author: null,
      handle: null,
      url: "https://openai.com/news/item-1",
      media: null,
      extra: JSON.stringify({
        feed_key: "openai",
        ai_summary_zh: "这是面向开发者的中性 AI 产品更新。",
      }),
      source_type: "blog",
      is_relevant: 1,
      deleted_at: null,
      ...input,
    };
    this.sqlite
      .prepare(
        `INSERT INTO items (
          id, title, content, content_translated, author, handle, url, media,
          extra, source_type, is_relevant, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.title,
        item.content,
        item.content_translated,
        item.author,
        item.handle,
        item.url,
        item.media,
        item.extra,
        item.source_type,
        item.is_relevant,
        item.deleted_at,
      );
    return item.id;
  }

  setOverride(itemId: string, action: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO cc_item_overrides (item_id, action, reason, updated_at)
         VALUES (?, ?, 'test override', '2026-07-20T00:00:00.000Z')`,
      )
      .run(itemId, action);
  }

  prepare(sql: string) {
    this.preparedSql.push(sql);
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

  close(): void {
    this.sqlite.close();
  }
}

function makeEnv(db: StatefulD1, apiKey = "unit-test-key"): Env {
  return {
    DB: db as unknown as D1Database,
    DEEPSEEK_API_KEY: apiKey,
    API_BASE: "https://api.example.test",
  } as Env;
}

function deepSeekResponse(data: unknown): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: JSON.stringify(data) },
          finish_reason: "stop",
        },
      ],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function mockFlags(flags: Partial<CcRiskFlags> = {}) {
  const fetchMock = vi.fn(async () =>
    deepSeekResponse({ ...SAFE_FLAGS, ...flags }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function finishRetry<T>(
  promise: Promise<T>,
  fetchMock: ReturnType<typeof vi.fn>,
): Promise<T> {
  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalled();
  });
  await vi.advanceTimersByTimeAsync(2_001);
  return promise;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reviewCcItem decisions", () => {
  it("passes an allowed source only when every risk flag is zero and sends the visible text policy prompt", async () => {
    const db = new StatefulD1();
    const hidden = "BLOG_FULLTEXT_MUST_NOT_REACH_PROMPT";
    const itemId = db.insertItem({
      title: "公开页面标题",
      extra: JSON.stringify({
        feed_key: "openai",
        ai_summary_zh: "公开 AI 摘要",
        body_markdown_zh: `${"正文摘录。".repeat(150)}${hidden}`,
      }),
    });
    const fetchMock = mockFlags();

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result).toMatchObject({
      status: "pass",
      reused: false,
      flags: SAFE_FLAGS,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<
      [unknown, RequestInit?]
    >;
    const request = JSON.parse(String(calls[0]?.[1]?.body)) as {
      messages: Array<{ content: string }>;
    };
    const prompt = request.messages[0]!.content;
    expect(prompt).toContain("是否适合在中国大陆公开静态发布");
    expect(prompt).toContain("不是事实核查");
    expect(prompt).toContain("中性产品、技术或研究");
    expect(prompt).toContain("对华负面");
    expect(prompt).toContain("政治治理");
    expect(prompt).toContain("军事冲突");
    expect(prompt).toContain("出口管制");
    expect(prompt).toContain("uncertain");
    expect(prompt).toContain("只输出");
    expect(prompt).toContain("reasons");
    expect(prompt).toContain("公开页面标题");
    expect(prompt).toContain("公开 AI 摘要");
    expect(prompt).not.toContain(hidden);
    db.close();
  });

  it.each([
    "china_negative",
    "politics_governance",
    "military_conflict",
    "other_cn_distribution_risk",
  ] as const)("denies when %s is flagged", async (flag) => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    mockFlags({ [flag]: 1 });

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("deny");
    expect(result.flags[flag]).toBe(1);
    db.close();
  });

  it.each([
    "sanctions_export_control",
    "uncertain",
  ] as const)("routes %s to manual review", async (flag) => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    mockFlags({ [flag]: 1 });

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("review");
    expect(result.flags[flag]).toBe(1);
    db.close();
  });

  it("keeps a manual source in review even when all model flags are zero", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem({
      id: "podcast:last-week-in-ai:episode-1",
      source_type: "podcast",
      extra: JSON.stringify({
        show_key: "last-week-in-ai",
        ai_summary_zh: "本周 AI 新闻摘要",
      }),
    });
    mockFlags();

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("review");
    expect(result.reason).toContain("source-manual");
    db.close();
  });

  it("denies a source-policy deny without calling the model", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem({
      id: "blog:qbitai:item-1",
      extra: JSON.stringify({
        feed_key: "qbitai",
        ai_summary_zh: "国内来源内容",
      }),
    });
    const fetchMock = mockFlags();

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("deny");
    expect(result.reason).toContain("source-deny");
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });
});

describe("reviewCcItem fail-closed model handling", () => {
  it.each([
    ["HTTP failure", async () => new Response("upstream", { status: 500 }), 2],
    [
      "Abort",
      async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
      2,
    ],
    [
      "bad JSON",
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "{not-json" } }],
          }),
          { status: 200 },
        ),
      2,
    ],
    ["data null", async () => deepSeekResponse(null), 1],
  ] as const)("returns pending on %s", async (_label, response, attempts) => {
    vi.useFakeTimers();
    const db = new StatefulD1();
    const itemId = db.insertItem();
    const fetchMock = vi.fn(response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await finishRetry(
      reviewCcItem(makeEnv(db), itemId),
      fetchMock,
    );

    expect(result.status).toBe("pending");
    expect(result.reused).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
    const stored = db.sqlite
      .prepare(
        `SELECT review_status, model FROM cc_item_reviews WHERE item_id = ?`,
      )
      .get(itemId) as { review_status: string; model: string | null };
    expect(stored.review_status).toBe("pending");
    expect(stored.model).toBeNull();
    db.close();
  });

  it("returns pending without a model call when the API key is missing", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    const fetchMock = mockFlags();

    const result = await reviewCcItem(makeEnv(db, ""), itemId);

    expect(result.status).toBe("pending");
    expect(result.reason).toContain("missing-api-key");
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it("reviews the renderer's visible no-title fallback instead of treating the row as empty", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem({
      title: null,
      content: null,
      content_translated: null,
      url: null,
      extra: JSON.stringify({ feed_key: "openai" }),
    });
    const fetchMock = mockFlags();

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("pass");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("returns pending without a model call when the renderer fails", async () => {
    const db = new StatefulD1();
    const hidden = "HIDDEN_X_FULLTEXT_MUST_NOT_REACH_LLM";
    const itemId = db.insertItem({
      id: "x_list:renderer-error",
      source_type: "x_list",
      title: "安全标题",
      content_translated: hidden,
      extra: "null",
    });
    const fetchMock = mockFlags();

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("pending");
    expect(result.reason).toContain("render-failed");
    expect(fetchMock).not.toHaveBeenCalled();
    const stored = db.sqlite
      .prepare(
        `SELECT review_status, flags_json
         FROM cc_item_reviews
         WHERE item_id = ?`,
      )
      .get(itemId) as { review_status: string; flags_json: string };
    expect(stored.review_status).toBe("pending");
    expect(stored.flags_json).not.toContain(hidden);
    db.sqlite
      .prepare(
        `UPDATE cc_item_reviews
         SET review_status = 'pass', flags_json = ?, reason = 'model-pass'
         WHERE item_id = ?`,
      )
      .run(JSON.stringify(SAFE_FLAGS), itemId);

    const reused = await reviewCcItem(makeEnv(db), itemId);

    expect(reused).toMatchObject({
      status: "pending",
      reused: true,
      reason: "render-failed:render-item-failed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it.each([
    {
      ...SAFE_FLAGS,
      china_negative: "0",
    },
    {
      china_negative: 0,
      politics_governance: 0,
      military_conflict: 0,
      sanctions_export_control: 0,
      other_cn_distribution_risk: 0,
      reasons: [],
    },
    [],
    {
      ...SAFE_FLAGS,
      reasons: ["valid", 7],
    },
  ])("routes invalid model shape to review with uncertain=1", async (payload) => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    vi.stubGlobal("fetch", vi.fn(async () => deepSeekResponse(payload)));

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("review");
    expect(result.flags.uncertain).toBe(1);
    expect(result.reason).toContain("invalid-shape");
    db.close();
  });

  it("normalizes model reasons to five strings of at most 80 code points", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    mockFlags({
      reasons: [
        "甲".repeat(100),
        "二",
        "三",
        "四",
        "五",
        "六",
      ],
    });

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("pass");
    expect(result.flags.reasons).toHaveLength(5);
    expect(Array.from(result.flags.reasons[0]!)).toHaveLength(80);
    db.close();
  });
});

describe("reviewCcItem cache, overrides and writes", () => {
  it("reuses matching hash/version/source policy and force bypasses the cache", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    const fetchMock = mockFlags();
    const env = makeEnv(db);

    const first = await reviewCcItem(env, itemId);
    const reused = await reviewCcItem(env, itemId);
    const forced = await reviewCcItem(env, itemId, { force: true });

    expect(first.reused).toBe(false);
    expect(reused).toMatchObject({ status: "pass", reused: true });
    expect(forced.reused).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      db.sqlite
        .prepare(
          `SELECT policy_version, source_policy FROM cc_item_reviews WHERE item_id = ?`,
        )
        .get(itemId),
    ).toMatchObject({
      policy_version: CC_REVIEW_POLICY_VERSION,
      source_policy: "allow",
    });
    db.close();
  });

  it("does not reuse the same hash after source policy changes", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    const fetchMock = mockFlags();
    const env = makeEnv(db);
    await reviewCcItem(env, itemId);
    db.sqlite
      .prepare(
        `UPDATE cc_item_reviews SET source_policy = 'manual' WHERE item_id = ?`,
      )
      .run(itemId);

    const result = await reviewCcItem(env, itemId);

    expect(result.reused).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    db.close();
  });

  it("never passes malformed cached flags", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    const fetchMock = mockFlags();
    const env = makeEnv(db);
    await reviewCcItem(env, itemId);
    db.sqlite
      .prepare(
        `UPDATE cc_item_reviews
         SET flags_json = '{"china_negative":0}', review_status = 'pass'
         WHERE item_id = ?`,
      )
      .run(itemId);
    fetchMock.mockClear();

    const result = await reviewCcItem(env, itemId);

    expect(result.status).toBe("review");
    expect(result.flags.uncertain).toBe(1);
    expect(result.reused).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it("applies deny override before cache or model", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    db.setOverride(itemId, "deny");
    const fetchMock = mockFlags();

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("deny");
    expect(result.reason).toContain("override-deny");
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it("lets allow override pass a manual candidate without model access", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem({
      id: "podcast:lex-fridman:episode-1",
      source_type: "podcast",
      extra: JSON.stringify({
        show_key: "lex-fridman",
        ai_summary_zh: "人工已确认可发布的访谈",
      }),
    });
    db.setOverride(itemId, "allow");
    const fetchMock = mockFlags({ politics_governance: 1 });

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("pass");
    expect(result.reason).toContain("override-allow");
    expect(fetchMock).not.toHaveBeenCalled();
    db.close();
  });

  it.each([
    [
      "missing item",
      null,
      "blog:missing",
      "item-not-found",
    ],
    [
      "not relevant",
      { is_relevant: 0 },
      "blog:openai:item-1",
      "item-not-relevant",
    ],
    [
      "deleted",
      { deleted_at: "2026-07-20T00:00:00.000Z" },
      "blog:openai:item-1",
      "item-deleted",
    ],
    [
      "deduplicated",
      {
        extra: JSON.stringify({
          feed_key: "openai",
          ai_summary_zh: "摘要",
          dedup_of: "blog:canonical",
        }),
      },
      "blog:openai:item-1",
      "item-deduplicated",
    ],
    [
      "source denied",
      {
        extra: JSON.stringify({
          feed_key: "qbitai",
          ai_summary_zh: "国内源",
        }),
      },
      "blog:openai:item-1",
      "source-deny",
    ],
  ] as const)(
    "does not let allow override bypass %s",
    async (_label, item, expectedItemId, reason) => {
      const db = new StatefulD1();
      const itemId = item ? db.insertItem(item) : expectedItemId;
      db.setOverride(itemId, "allow");
      const fetchMock = mockFlags();

      const result = await reviewCcItem(makeEnv(db), itemId);

      expect(result.status).not.toBe("pass");
      expect(result.reason).toContain(reason);
      expect(fetchMock).not.toHaveBeenCalled();
      db.close();
    },
  );

  it("does not treat an unknown override action as allow", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    db.setOverride(itemId, "approve");
    const fetchMock = mockFlags();

    const result = await reviewCcItem(makeEnv(db), itemId);

    expect(result.status).toBe("pass");
    expect(result.reason).not.toContain("override-allow");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it("performs no D1 write during a dry review", async () => {
    const db = new StatefulD1();
    const itemId = db.insertItem();
    mockFlags();

    const result = await reviewCcItem(makeEnv(db), itemId, { dry: true });

    expect(result.status).toBe("pass");
    expect(db.writeCount).toBe(0);
    expect(
      db.sqlite
        .prepare(`SELECT COUNT(*) AS count FROM cc_item_reviews`)
        .get(),
    ).toEqual({ count: 0 });
    db.close();
  });
});
