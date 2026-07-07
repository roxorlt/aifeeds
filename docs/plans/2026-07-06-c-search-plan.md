# C 端站内搜索 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 设计依据：`docs/plans/2026-07-06-c-search-design.md`（用户已批准 4 项关键决策，本计划与之一致；cursor 细节以本计划为准：list 模式用「召回集内 offset」cursor，单 query 单源最多可翻 200 条）

**Goal:** 匿名可用的站内搜索全链路：放大镜入口 → /search 起始页（历史/热搜/源入口）→ suggestion → 按源分组结果页 → 单源下钻流 → 抽屉详情，配 FTS5 检索后端、限流、缓存、埋点与 admin 监控。

**Architecture:** D1 FTS5 影子表 `items_fts`（中文 bigram 预分词，cron 每 5 分钟增量同步，与主管线解耦）+ `search_terms` suggestion 词表（每小时物化）。Worker 新增 `src/search/` 模块（tokenize / ranking / sync / terms / handlers），index.ts 只加路由 if 行。前端新增 `/search` lazy 路由页，卡片渲染复用现有按源分派（抽取公共 ItemCard）。

**Tech Stack:** CF Worker + D1(FTS5) + KV(限流) + Cache API；React 19 + react-router 7 + Tailwind v4；测试 node:test（worker 纯函数）+ staging curl 断言 + Playwright E2E（orchestrator 执行）。

## Global Constraints

- 分支：`feat/c-search`（从 main 开出）；只允许 `git add` 明确列出的文件，**严禁 `git add -A`**（工作区有其他 session 的 `worker/src/digest/node-run.ts` 未提交改动，绝不能带入 commit）
- **严禁触碰** `worker/src/digest/**`、`codex-daily-payload-sample.json`、`daily-email-preview.html`、`drawer-snap.md` 等他人工作区文件
- migration 编号：写文件前先 `ls worker/migrations/ | sort | tail -3` 取 max+1（预期 026，若被占则顺延，并同步改本计划中所有引用）
- 合规过滤五条件（任何搜索出口必须同时满足，写入侧+查询侧双保险）：`json_extract(extra,'$.workflow_completed_at') IS NOT NULL`、`json_extract(extra,'$.dedup_of') IS NULL`、`COALESCE(json_extract(extra,'$.cn_sensitive'),0) != 1`、`is_relevant = 1`、`deleted_at IS NULL`
- staging D1 操作：`cd worker && npx wrangler d1 execute xlist-staging --env staging --remote --file=...`（先 `set -a; . ../.secrets/aifeeds-staging.env; set +a`）
- staging deploy：`cd worker && set -a; . ../.secrets/aifeeds-staging.env; set +a && npx wrangler deploy --env staging`；**prod 一律不部署**（用户验收后才做）
- UI：全中文文案；neutral 灰阶 token（见 `docs/frontend-ux-guidelines.md`）；icon 一律 `icons.tsx` 手写 lucide 风 SVG，**禁止 emoji 当 icon、禁止引入图标库**；移动端 input `text-base`
- worker 单测用 `node:test` + `node:assert/strict`，跑法 `cd worker && npx tsx --test src/search/*.test.ts`
- API_BASE 前端只从 `src/lib/apiBase.ts` import；worker 对外 URL 用 env（SITE_BASE/API_BASE）
- 每个任务完成即 commit（中文 commit message，`feat(search): ...` / `test(search): ...`），commit footer 带 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Migration（items_fts / search_terms / search_sync_state）+ staging FTS5 冒烟

**Files:**
- Create: `worker/migrations/026-search-fts.sql`（编号按 Global Constraints 确认）

**Interfaces:**
- Produces: 三张表结构，后续所有任务依赖。列名以本 SQL 为准。

- [ ] **Step 1: 冒烟验证 staging D1 支持 FTS5**

```bash
cd worker && set -a; . ../.secrets/aifeeds-staging.env; set +a
npx wrangler d1 execute xlist-staging --env staging --remote --command \
"CREATE VIRTUAL TABLE _fts_smoke USING fts5(a); INSERT INTO _fts_smoke(a) VALUES ('hello world'); SELECT * FROM _fts_smoke WHERE _fts_smoke MATCH 'hello'; DROP TABLE _fts_smoke;"
```
Expected: 查询返回 1 行 `hello world`，无报错。**若报错（FTS5 不可用）：立即停止，回报 orchestrator 重议方案，不要继续。**

- [ ] **Step 2: 写 migration 文件**

```sql
-- 026-search-fts.sql — C 端搜索：FTS5 影子表 + suggestion 词表 + 同步水位
-- 影子表列内容是预分词后的空格分隔 token 流（见 src/search/tokenize.ts），
-- rowid 与 items.rowid 对齐（插入时显式指定）。
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title_tok,
  body_tok,
  author_tok,
  item_id UNINDEXED,
  source_type UNINDEXED,
  published_at UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS search_terms (
  term        TEXT NOT NULL,
  term_norm   TEXT NOT NULL,
  term_type   TEXT NOT NULL,            -- 'entity' | 'hot_query'
  source_type TEXT,
  weight      REAL NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (term_norm, term_type)
);
CREATE INDEX IF NOT EXISTS idx_search_terms_norm ON search_terms(term_norm, weight DESC);

CREATE TABLE IF NOT EXISTS search_sync_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
```

- [ ] **Step 3: staging 跑 migration 并验证**

```bash
npx wrangler d1 execute xlist-staging --env staging --remote --file=migrations/026-search-fts.sql
npx wrangler d1 execute xlist-staging --env staging --remote --command \
"SELECT name FROM sqlite_master WHERE name IN ('items_fts','search_terms','search_sync_state');"
```
Expected: 返回 3 行表名。**不跑 prod migration。**

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/026-search-fts.sql
git commit -m "feat(search): migration 026 — items_fts/search_terms/search_sync_state（staging 已验证 FTS5 可用）"
```

---

### Task 2: 分词与 MATCH 构造器（tokenize.ts）

**Files:**
- Create: `worker/src/search/tokenize.ts`
- Test: `worker/src/search/tokenize.test.ts`

**Interfaces:**
- Produces: `tokenizeForSearch(text: string | null | undefined): string[]`；`buildMatchQuery(tokens: string[]): string | null`（null = 无有效 token）。后续 sync/handlers 均 import 此二函数。

- [ ] **Step 1: 写失败测试**

```ts
// worker/src/search/tokenize.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { tokenizeForSearch, buildMatchQuery } from "./tokenize";

test("中文切 bigram", () => {
  assert.deepEqual(tokenizeForSearch("大模型"), ["大模", "模型"]);
});
test("单个汉字保留单字", () => {
  assert.deepEqual(tokenizeForSearch("深"), ["深"]);
});
test("中英混排：拉丁整词+连接符拆分+中文 bigram", () => {
  assert.deepEqual(tokenizeForSearch("Claude-Code 智能体"),
    ["claude-code", "claude", "code", "智能", "能体"]);
});
test("全角经 NFKC 归一", () => {
  assert.deepEqual(tokenizeForSearch("ＡＩ"), ["ai"]);
});
test("emoji/纯符号产出空数组", () => {
  assert.deepEqual(tokenizeForSearch("🔥🔥 !!!"), []);
  assert.deepEqual(tokenizeForSearch(""), []);
  assert.deepEqual(tokenizeForSearch(null), []);
});
test("超长拉丁词截断到 32 字符", () => {
  const t = tokenizeForSearch("a".repeat(50));
  assert.equal(t[0].length, 32);
});
test("MATCH：普通多 token 引号包裹 AND", () => {
  assert.equal(buildMatchQuery(["大模", "模型"]), '"大模" "模型"');
});
test("MATCH：末位拉丁≥3 加前缀星", () => {
  assert.equal(buildMatchQuery(["claude"]), '"claude"*');
  assert.equal(buildMatchQuery(["ab"]), '"ab"');
});
test("MATCH：末位中文单字加前缀星", () => {
  assert.equal(buildMatchQuery(["深"]), '"深"*');
});
test("MATCH：注入字符被中和（双引号剔除，语法词只是普通 token）", () => {
  assert.equal(buildMatchQuery(['fo"o', "or", "near"]), '"foo" "or" "near"');
  assert.equal(buildMatchQuery(['"""']), null);
});
test("MATCH：token 上限 12", () => {
  const q = buildMatchQuery(Array.from({ length: 20 }, (_, i) => `t${i}`));
  assert.equal((q!.match(/"/g) || []).length / 2, 12);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd worker && npx tsx --test src/search/tokenize.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// worker/src/search/tokenize.ts
// 索引侧与查询侧共用的分词器。中文（含日文假名/韩文）连续段切 bigram，
// 拉丁数字段整词保留（词内 - _ . 连接时整词与拆分都入 token），其余字符丢弃。
const CJK_SINGLE = /^[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]$/;
const RUN_RE =
  /([a-z0-9]+(?:[-_.][a-z0-9]+)*)|([぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]+)/g;

export function tokenizeForSearch(text: string | null | undefined): string[] {
  if (!text) return [];
  const norm = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  RUN_RE.lastIndex = 0;
  while ((m = RUN_RE.exec(norm))) {
    if (m[1]) {
      const word = m[1].slice(0, 32);
      tokens.push(word);
      if (/[-_.]/.test(word)) {
        for (const part of word.split(/[-_.]/)) if (part) tokens.push(part.slice(0, 32));
      }
    } else if (m[2]) {
      const run = m[2];
      if (run.length === 1) tokens.push(run);
      else for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

// 用户输入 → MATCH 表达式的唯一入口。token 双引号包裹（内部双引号剔除），
// 隐式 AND；末位拉丁≥3 或中文单字追加 * 前缀匹配。禁止任何裸拼接。
export function buildMatchQuery(tokens: string[]): string | null {
  const t = tokens
    .slice(0, 12)
    .map((x) => x.replace(/"/g, ""))
    .filter(Boolean);
  if (t.length === 0) return null;
  return t
    .map((tok, i) => {
      const last = i === t.length - 1;
      const prefix = last && (CJK_SINGLE.test(tok) || (/^[a-z0-9]+$/.test(tok) && tok.length >= 3));
      return prefix ? `"${tok}"*` : `"${tok}"`;
    })
    .join(" ");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd worker && npx tsx --test src/search/tokenize.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/search/tokenize.ts worker/src/search/tokenize.test.ts
git commit -m "feat(search): 分词器与 MATCH 构造器（中文 bigram + 注入中和）"
```

---

### Task 3: 排序与分组（ranking.ts）

**Files:**
- Create: `worker/src/search/ranking.ts`
- Test: `worker/src/search/ranking.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `finalScore(bm25: number, publishedAt: string | null, sourceType: string, nowMs: number): number`
  - `rankHits<T extends Hit>(hits: T[], nowMs: number): (T & { score: number })[]`（降序）
  - `groupHits<T extends Hit & { score: number }>(ranked: T[]): { source_type: string; total: number; top: T[] }[]`（组内 top3，组序按组内最高分，空组不产生）
  - `encodeOffsetCursor(offset: number): string` / `decodeOffsetCursor(cursor: string | null): number`（非法返回 0）
  - `type Hit = { source_type: string; published_at: string | null; b: number }`（b = bm25 原始负值）
  - 常量 `HALF_LIFE_DAYS: Record<string, number>`（x_list/blog/weibo=7；podcast/hf_paper/huodongxing/youtube/arxiv=30；github/product_hunt/clawhub=180；默认 30）、`RECALL_LIMIT = 200`、`GROUP_TOP_N = 3`、`LIST_PAGE_SIZE = 20`

- [ ] **Step 1: 写失败测试**

```ts
// worker/src/search/ranking.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { finalScore, rankHits, groupHits, encodeOffsetCursor, decodeOffsetCursor } from "./ranking";

const NOW = Date.parse("2026-07-06T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();

test("同相关性下，x_list 7 天衰减快于 github 180 天", () => {
  const fresh = finalScore(-10, daysAgo(0), "x_list", NOW);
  const oldX = finalScore(-10, daysAgo(30), "x_list", NOW);
  const oldGh = finalScore(-10, daysAgo(30), "github", NOW);
  assert.ok(fresh > oldX);
  assert.ok(oldGh > oldX); // 30 天前的 GH 仓库分数远高于 30 天前的推文
});
test("published_at 缺失按 365 天衰减兜底", () => {
  assert.ok(finalScore(-10, null, "github", NOW) < finalScore(-10, daysAgo(0), "github", NOW));
});
test("rankHits 降序、groupHits 组序按组内最高分且每组最多 3 条", () => {
  const hits = [
    { source_type: "github", published_at: daysAgo(1), b: -8 },
    { source_type: "x_list", published_at: daysAgo(0), b: -20 },
    { source_type: "x_list", published_at: daysAgo(0), b: -5 },
    { source_type: "x_list", published_at: daysAgo(0), b: -6 },
    { source_type: "x_list", published_at: daysAgo(0), b: -7 },
  ];
  const groups = groupHits(rankHits(hits, NOW));
  assert.equal(groups[0].source_type, "x_list"); // 最高分 -20 在 x_list 组
  assert.equal(groups[0].total, 4);
  assert.equal(groups[0].top.length, 3);
  assert.equal(groups[1].source_type, "github");
});
test("offset cursor 编解码，非法输入回 0", () => {
  assert.equal(decodeOffsetCursor(encodeOffsetCursor(40)), 40);
  assert.equal(decodeOffsetCursor(null), 0);
  assert.equal(decodeOffsetCursor("garbage!!"), 0);
  assert.equal(decodeOffsetCursor(encodeOffsetCursor(-5)), 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd worker && npx tsx --test src/search/ranking.test.ts` → FAIL

- [ ] **Step 3: 实现**

```ts
// worker/src/search/ranking.ts
// 排序公式：final = (-bm25) × 0.5^(age_days / half_life)。
// 半衰期按源分组；调参只改这张表。
export const HALF_LIFE_DAYS: Record<string, number> = {
  x_list: 7, blog: 7, weibo: 7,
  podcast: 30, hf_paper: 30, huodongxing: 30, youtube: 30, arxiv: 30,
  github: 180, product_hunt: 180, clawhub: 180,
};
export const DEFAULT_HALF_LIFE = 30;
export const RECALL_LIMIT = 200;
export const GROUP_TOP_N = 3;
export const LIST_PAGE_SIZE = 20;

export type Hit = { source_type: string; published_at: string | null; b: number };

export function finalScore(bm25: number, publishedAt: string | null, sourceType: string, nowMs: number): number {
  const rel = -bm25; // sqlite bm25() 返回负值，越小越相关
  const ts = publishedAt ? Date.parse(publishedAt) : NaN;
  const ageDays = Number.isFinite(ts) ? Math.max(0, (nowMs - ts) / 86400000) : 365;
  const hl = HALF_LIFE_DAYS[sourceType] ?? DEFAULT_HALF_LIFE;
  return rel * Math.pow(0.5, ageDays / hl);
}

export function rankHits<T extends Hit>(hits: T[], nowMs: number): (T & { score: number })[] {
  return hits
    .map((h) => ({ ...h, score: finalScore(h.b, h.published_at, h.source_type, nowMs) }))
    .sort((a, b) => b.score - a.score);
}

export function groupHits<T extends Hit & { score: number }>(
  ranked: T[],
): { source_type: string; total: number; top: T[] }[] {
  const map = new Map<string, { source_type: string; total: number; top: T[]; best: number }>();
  for (const h of ranked) {
    let g = map.get(h.source_type);
    if (!g) { g = { source_type: h.source_type, total: 0, top: [], best: h.score }; map.set(h.source_type, g); }
    g.total += 1;
    if (g.top.length < GROUP_TOP_N) g.top.push(h);
  }
  return [...map.values()].sort((a, b) => b.best - a.best)
    .map(({ best: _b, ...g }) => g);
}

export function encodeOffsetCursor(offset: number): string {
  return btoa(`o:${Math.max(0, Math.floor(offset))}`);
}
export function decodeOffsetCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const m = /^o:(\d+)$/.exec(atob(cursor));
    return m ? parseInt(m[1], 10) : 0;
  } catch { return 0; }
}
```

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/search/ranking.ts worker/src/search/ranking.test.ts
git commit -m "feat(search): 排序（BM25×时间衰减）、分组与 offset cursor"
```

---

### Task 4: 索引同步（sync.ts：字段抽取 / 增量 / backfill / reconcile）+ cron 接线 + admin reindex

**Files:**
- Create: `worker/src/search/sync.ts`
- Test: `worker/src/search/sync.test.ts`（只测纯函数 `extractSearchFields`）
- Modify: `worker/src/index.ts`（scheduled() 加两处调用 + admin 路由 1 行）

**Interfaces:**
- Consumes: `tokenizeForSearch`（Task 2）
- Produces:
  - `extractSearchFields(row: ItemRow): { title: string; body: string; author: string } | null`（null = 不满足入索引门槛；`ItemRow = { id, source_type, title, content, content_translated, author, handle, published_at, extra(string|null), is_relevant, deleted_at }`）
  - `syncSearchIndex(env: Env): Promise<{ scanned: number; upserted: number }>`（增量，含首次自动 backfill 推进）
  - `reconcileSearchIndex(env: Env): Promise<{ itemsEligible: number; ftsRows: number; purged: number }>`
  - `handleSearchReindex(request, env): Promise<Response>`（POST /api/admin/search/reindex，admin auth，循环批次 ~20s 时间预算）

- [ ] **Step 1: 写 extractSearchFields 失败测试**

```ts
// worker/src/search/sync.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { extractSearchFields } from "./sync";

const base = {
  id: "github:foo/bar", source_type: "github", title: "foo/bar",
  content: null, content_translated: null, author: "foo", handle: null,
  published_at: "2026-07-01T00:00:00Z", is_relevant: 1, deleted_at: null,
  extra: JSON.stringify({ workflow_completed_at: "2026-07-01T00:05:00Z", ai_summary: "一个 AI 工具", ai_category: "agent" }),
};

test("github：title=repo，body 含 ai_summary+category，author=owner", () => {
  const f = extractSearchFields(base as any)!;
  assert.equal(f.title, "foo/bar");
  assert.match(f.body, /一个 AI 工具/);
  assert.match(f.body, /agent/);
  assert.match(f.author, /foo/);
});
test("未完成 workflow 的行返回 null", () => {
  assert.equal(extractSearchFields({ ...base, extra: JSON.stringify({}) } as any), null);
});
test("cn_sensitive / dedup_of / 软删 / is_relevant=0 返回 null", () => {
  const mk = (patch: object) =>
    extractSearchFields({ ...base, extra: JSON.stringify({ workflow_completed_at: "x", ...patch }) } as any);
  assert.equal(mk({ cn_sensitive: 1 }), null);
  assert.equal(mk({ dedup_of: "github:a/b" }), null);
  assert.equal(extractSearchFields({ ...base, deleted_at: 123 } as any), null);
  assert.equal(extractSearchFields({ ...base, is_relevant: 0 } as any), null);
});
test("x_list：body 含原文与译文，author 含名字+handle", () => {
  const f = extractSearchFields({
    ...base, id: "x_list:1", source_type: "x_list", title: null,
    content: "hello world", content_translated: "你好世界", author: "Some One", handle: "someone",
  } as any)!;
  assert.match(f.body, /hello world/);
  assert.match(f.body, /你好世界/);
  assert.match(f.author, /someone/);
});
test("podcast：shownotes_zh 截 1000 字，不含 transcript", () => {
  const f = extractSearchFields({
    ...base, id: "podcast:1", source_type: "podcast", title: "第 1 期",
    extra: JSON.stringify({ workflow_completed_at: "x", title_zh: "中文标题",
      shownotes_zh: "长".repeat(3000), transcript_text_zh: "禁止出现" }),
  } as any)!;
  assert.ok(f.body.length <= 1100);
  assert.ok(!f.body.includes("禁止出现"));
  assert.match(f.title, /中文标题/);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现 sync.ts**

字段映射表（设计文档 §3.2，实现为一个 per-source switch；所有 extra 字段读取都要 try/parse 容错）：

| source_type | title | body（截断上限见括号） | author |
|---|---|---|---|
| x_list | — | content + content_translated | author + handle |
| github | title | extra.ai_summary + extra.readme_translated(500) + extra.ai_category | title 的 owner 段 + author |
| product_hunt | title | content + extra.ai_summary + extra.maker_post_text_translated(500) | extra.makers 各名字 |
| clawhub | title | extra.summary_translated + extra.category | author |
| hf_paper | title + extra.title_zh | extra.deep_analysis.tldr + extra.ai_keywords(join) | author |
| blog | title + extra.title_zh | extra.excerpt_zh + extra.ai_summary_zh | author |
| podcast | title + extra.title_zh | extra.shownotes_zh(1000) + extra.timeline 各章节 title | author + extra.guests(join) |
| huodongxing | title | content + extra.city + extra.organizer | author |
| 其他 | title | (content_translated ?? content)(1000) | author + handle |

核心结构（完整实现由执行者按此骨架补齐，行为以 Step 1 测试为准）：

```ts
// worker/src/search/sync.ts
import { tokenizeForSearch } from "./tokenize";

export type ItemRow = { id: string; source_type: string; title: string | null; content: string | null;
  content_translated: string | null; author: string | null; handle: string | null;
  published_at: string | null; extra: string | null; is_relevant: number; deleted_at: number | null };

const cut = (s: string | null | undefined, n: number) => (s ? String(s).slice(0, n) : "");

export function extractSearchFields(row: ItemRow): { title: string; body: string; author: string } | null {
  if (row.deleted_at != null || row.is_relevant !== 1) return null;
  let extra: any = {};
  try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch { extra = {}; }
  if (!extra.workflow_completed_at || extra.dedup_of || Number(extra.cn_sensitive) === 1) return null;
  // ...per-source switch，按上表拼 title/body/author，超长字段用 cut()
}

const ITEM_COLS = "id, source_type, title, content, content_translated, author, handle, published_at, extra, is_relevant, deleted_at";

export async function syncSearchIndex(env: Env): Promise<{ scanned: number; upserted: number }> {
  // 1) 读水位：SELECT v FROM search_sync_state WHERE k IN ('fts_wm_scraped','fts_wm_translated','fts_backfill_rowid','fts_backfill_done')
  // 2) backfill 未完成：SELECT rowid AS rid, <ITEM_COLS> FROM items WHERE rowid > ?last ORDER BY rowid LIMIT 2000
  //    追平（返回 < 2000 行）后写 fts_backfill_done='1'
  // 3) backfill 完成后走增量：WHERE scraped_at > ?wm_scraped_minus_10min OR COALESCE(translated_at,0) > ?wm_translated_minus_600
  // 4) 每行 extractSearchFields → null 则 DELETE FROM items_fts WHERE rowid=?rid；
  //    否则 db.batch([DELETE ..., INSERT INTO items_fts(rowid, title_tok, body_tok, author_tok, item_id, source_type, published_at) VALUES (?rid, ?, ?, ?, ?, ?, ?)])
  //    token 流 = tokenizeForSearch(x).join(" ")
  // 5) 更新水位（本轮最大 scraped_at / translated_at / rowid）；全程 try/catch，失败只 console.error 不抛出
}

export async function reconcileSearchIndex(env: Env): Promise<{...}> {
  // 1) 清出事后不合规行：
  //    DELETE FROM items_fts WHERE rowid IN (
  //      SELECT i.rowid FROM items i WHERE i.deleted_at IS NOT NULL OR i.is_relevant != 1
  //        OR json_extract(i.extra,'$.dedup_of') IS NOT NULL
  //        OR COALESCE(json_extract(i.extra,'$.cn_sensitive'),0) = 1)
  // 2) 统计 itemsEligible（items 满足五条件的 COUNT）与 ftsRows（SELECT COUNT(*) FROM items_fts）
  // 3) 差值 > 500 时调用现有 notifier 告警；结果写 search_sync_state k='last_reconcile'（JSON）
}

export async function handleSearchReindex(request: Request, env: Env): Promise<Response> {
  // checkAdminAuth（复用 src/admin.ts）→ 401/403 直接返回
  // 重置 fts_backfill_done/fts_backfill_rowid 可选参数 ?reset=1
  // while (Date.now()-t0 < 20000) { const r = await syncSearchIndex(env); if (r.scanned < 2000) break; }
  // 返回 JSON 进度 { rounds, lastScanned, backfillDone }
}
```

- [ ] **Step 4: 跑纯函数测试确认通过** → PASS

- [ ] **Step 5: index.ts 接线（先读现有 scheduled() 分流模式再动手）**

- 每次 cron tick（*/5 全量档）追加 `ctx.waitUntil(syncSearchIndex(env))`
- 整点档（读现有「小时级任务」分流写法，跟随同款判断）追加 `ctx.waitUntil(rebuildSearchTerms(env))` —— 该函数 Task 5 提供，本任务先接 sync，terms 接线留给 Task 5
- 每日 cleanup 档（03:35 UTC 现有分支）追加 `ctx.waitUntil(reconcileSearchIndex(env))`
- 路由段（admin 区）加：`if (path === "/api/admin/search/reindex" && request.method === "POST") return withCors(await handleSearchReindex(request, env), request, env);`（对齐现有 admin 路由写法）

- [ ] **Step 6: 本地类型检查**

Run: `cd worker && npx tsc --noEmit`
Expected: 零错误

- [ ] **Step 7: Commit**

```bash
git add worker/src/search/sync.ts worker/src/search/sync.test.ts worker/src/index.ts
git commit -m "feat(search): FTS 索引增量同步/backfill/reconcile + cron 接线 + admin reindex"
```

---

### Task 5: Suggestion 词表（terms.ts）+ 整点 cron 接线

**Files:**
- Create: `worker/src/search/terms.ts`
- Test: `worker/src/search/terms.test.ts`（纯函数 `collectEntityTerms`）
- Modify: `worker/src/index.ts`（整点档接 `rebuildSearchTerms`）

**Interfaces:**
- Consumes: 无
- Produces:
  - `collectEntityTerms(rows: TermSourceRow[]): Map<string, { term: string; weight: number; source_type: string }>`（key = term_norm；`TermSourceRow = { source_type, title, author, handle, extra, metrics }` 全 string|null）
  - `rebuildSearchTerms(env: Env): Promise<{ entities: number; hotQueries: number }>`

- [ ] **Step 1: 写失败测试**

```ts
// worker/src/search/terms.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { collectEntityTerms } from "./terms";

test("github 仓库名拆 owner 与 repo 各一条 + 全名一条", () => {
  const m = collectEntityTerms([{ source_type: "github", title: "anthropics/claude-code",
    author: "anthropics", handle: null, metrics: JSON.stringify({ stars: 1000 }),
    extra: JSON.stringify({ ai_category: "agent" }) }]);
  assert.ok(m.has("anthropics/claude-code"));
  assert.ok(m.has("claude-code"));
  assert.ok(m.has("agent")); // ai_category 也成词
});
test("作者出现 3 次以上才成词", () => {
  const row = { source_type: "x_list", title: null, author: "Karpathy", handle: "karpathy", metrics: null, extra: null };
  assert.ok(!collectEntityTerms([row]).has("karpathy"));
  assert.ok(collectEntityTerms([row, row, row]).has("karpathy"));
});
test("词长过滤：<2 或 >40 字符不成词", () => {
  const m = collectEntityTerms([{ source_type: "clawhub", title: "a", author: null, handle: null, metrics: null,
    extra: JSON.stringify({}) }]);
  assert.equal(m.size, 0);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现 terms.ts**

```ts
// worker/src/search/terms.ts
// 每小时全量重建 suggestion 词表：entity 词从 items 挖掘，hot_query 从 events 聚合。
// 语义：本轮 upsert 后删除 updated_at < 本轮时间戳 的旧行（全量刷新）。
```
- `collectEntityTerms`：遍历行按源提词 —— github: title 全名 + repo 段 + extra.ai_category；product_hunt/clawhub: title；hf_paper: extra.ai_keywords[]；blog: author（媒体名）；x_list/podcast: author 与 handle 计频（≥3 次成词，weight=次数）；全部 trim；term_norm = NFKC lowercase；长度 2-40；weight：github 用 `1+log10(max(1,stars))`，其余频次或 1。
- `rebuildSearchTerms(env)`：
  1. `SELECT source_type, title, author, handle, extra, metrics FROM items WHERE <五条件合规过滤> `（只取这 6 列）
  2. `collectEntityTerms` → 分批 `INSERT OR REPLACE INTO search_terms(term, term_norm, term_type, source_type, weight, updated_at) VALUES ...`（term_type='entity'，每批 ≤50 行）
  3. hot_query：`SELECT json_extract(event_payload,'$.q') AS q, COUNT(*) AS c FROM events WHERE event_type='search_submit' AND occurred_at >= datetime('now','-7 days') GROUP BY q HAVING c >= 3 ORDER BY c DESC LIMIT 100`（q 校验：1-50 字符、tokenize 后非空才入表；weight=c×10 保证热搜排前）
  4. `DELETE FROM search_terms WHERE updated_at < ?本轮ts`
  5. 全程 try/catch 不抛出。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: index.ts 整点档接线 + tsc**

Run: `cd worker && npx tsc --noEmit` → 零错误

- [ ] **Step 6: Commit**

```bash
git add worker/src/search/terms.ts worker/src/search/terms.test.ts worker/src/index.ts
git commit -m "feat(search): suggestion 词表每小时物化（entity + hot_query）"
```

---

### Task 6: 搜索 API（handlers.ts：/api/search + /suggest + 限流 + 缓存）+ 路由接线 + 埋点白名单

**Files:**
- Create: `worker/src/search/handlers.ts`
- Test: `worker/src/search/handlers.test.ts`（纯函数：参数校验/归一）
- Modify: `worker/src/index.ts`（public 路由段加 2 行 if）
- Modify: `worker/src/track.ts`（`EVENT_TYPE_WHITELIST` 加 7 个 search_* 事件）

**Interfaces:**
- Consumes: Task 2 `tokenizeForSearch/buildMatchQuery`、Task 3 全部导出、`getClientIp`（`src/client-ip.ts`）、`withCors`（index.ts 现有）
- Produces:
  - `handleSearch(request, env, ctx): Promise<Response>`
  - `handleSearchSuggest(request, env, ctx): Promise<Response>`
  - `validateSearchParams(url: URL): { ok: true; q: string; source: string | null; cursor: string | null; limit: number } | { ok: false; error: string }`（可测纯函数；q trim 后 1-100 字符、source 必须 ∈ 合法 source_type 集或 null、limit 默认 20 上限 50）
- API 契约（前端 Task 8 依赖，字段名不可改）：
  - 分组：`{ mode:"grouped", groups:[{ source_type, total, items: Item[] }], query_time_ms }`
  - 列表：`{ mode:"list", items: Item[], next_cursor: string|null, has_more: boolean, query_time_ms }`
  - suggest：`{ terms: [{ term, term_type }] }`
  - 错误：400 `{error:"empty_query"|"query_too_long"|"invalid_source"}`；429 `{error:"rate_limited"}`；500 `{error:"search_unavailable"}`
  - Item 与 `/api/items` 响应中的 item 结构完全一致（同一 row mapper；执行时先读 handleItems 的行映射代码并复用其函数，如为内联则抽出共享）

- [ ] **Step 1: 写 validateSearchParams 失败测试**

```ts
// worker/src/search/handlers.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { validateSearchParams } from "./handlers";

const u = (qs: string) => new URL(`https://api.example.com/api/search?${qs}`);

test("正常 q", () => {
  const r = validateSearchParams(u("q=大模型"));
  assert.deepEqual(r, { ok: true, q: "大模型", source: null, cursor: null, limit: 20 });
});
test("空/纯空白 q → empty_query", () => {
  assert.equal((validateSearchParams(u("q=")) as any).error, "empty_query");
  assert.equal((validateSearchParams(u("q=%20%20")) as any).error, "empty_query");
});
test("超 100 字符 → query_too_long", () => {
  assert.equal((validateSearchParams(u(`q=${"a".repeat(101)}`)) as any).error, "query_too_long");
});
test("非法 source → invalid_source；合法 source 通过", () => {
  assert.equal((validateSearchParams(u("q=x&source=evil")) as any).error, "invalid_source");
  assert.equal((validateSearchParams(u("q=x&source=github")) as any).source, "github");
});
test("limit 钳制 1-50", () => {
  assert.equal((validateSearchParams(u("q=x&limit=999")) as any).limit, 50);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现 handlers.ts**

处理顺序（两个 handler 一致）：**① Cache API 查缓存（命中直接返回，不计限流）→ ② KV 限流 → ③ 业务 → ④ 写缓存**。

```ts
// worker/src/search/handlers.ts 关键骨架
const LEGAL_SOURCES = new Set(["x_list","github","product_hunt","clawhub","hf_paper","blog","podcast","huodongxing","youtube","arxiv","weibo"]);

async function checkRateLimit(env: Env, request: Request, kind: "search" | "suggest"): Promise<boolean> {
  const id = request.headers.get("X-Device-Id") || getClientIp(request) || "anon";
  const bucket = Math.floor(Date.now() / 60000);
  const key = `search:rl:${kind}:${id}:${bucket}`;
  const cur = parseInt((await env.AUTH_KV.get(key)) || "0", 10) + 1;
  await env.AUTH_KV.put(key, String(cur), { expirationTtl: 120 });
  return cur <= (kind === "suggest" ? 40 : 12);
}

// handleSearch 业务：
// 1) validateSearchParams → 400
// 2) tokenizeForSearch(q) → buildMatchQuery → null 则 400 empty_query
// 3) 召回：SELECT item_id AS id, source_type, published_at, bm25(items_fts,5.0,1.0,3.0) AS b
//         FROM items_fts WHERE items_fts MATCH ?1 [AND source_type = ?2] ORDER BY b LIMIT 200
// 4) 回查 items（id 按 90 个一批 IN 查询，附加五条件合规过滤），行映射复用 /api/items 同款
// 5) rankHits → 无 source: groupHits 出 grouped 响应；有 source: offset cursor 切片出 list 响应
// 6) 响应 JSON 附 query_time_ms（Date.now 差值）；Cache-Control: public, max-age=60
// 全 handler try/catch → 500 {error:"search_unavailable"}

// handleSearchSuggest 业务：
// prefix = NFKC lowercase trim，>50 字符 400
// 空 prefix：SELECT term, term_type FROM search_terms
//            ORDER BY CASE term_type WHEN 'hot_query' THEN 0 ELSE 1 END, weight DESC LIMIT 10
// 非空：ub = prefix + "￿"
//       SELECT term, term_type FROM search_terms WHERE term_norm >= ?1 AND term_norm < ?2
//       ORDER BY weight DESC LIMIT 8
// 任何内部错误 → 200 { terms: [] }（suggestion 永不阻塞主流程）
// Cache-Control: public, max-age=300
```

Cache API 用法（两个 handler 共用小工具）：cache key = `new Request("https://search-cache.internal" + path + "?" + 归一化排序后的参数串)`；命中 `caches.default.match`；写入 `ctx.waitUntil(caches.default.put(key, resp.clone()))`。

- [ ] **Step 4: index.ts 路由接线（public 段，bot gate 不豁免——确认这两条路径不出现在 `isBotGateExempt`）**

```ts
if (path === "/api/search" && request.method === "GET")
  return withCors(await handleSearch(request, env, ctx), request, env);
if (path === "/api/search/suggest" && request.method === "GET")
  return withCors(await handleSearchSuggest(request, env, ctx), request, env);
```

- [ ] **Step 5: track.ts 白名单加事件**

`EVENT_TYPE_WHITELIST` 数组追加：`"search_open", "search_submit", "search_suggest_click", "search_result_click", "search_empty", "search_error", "search_perf"`。

- [ ] **Step 6: 单测 + tsc + wrangler dev 本地 curl 验证**

```bash
cd worker && npx tsx --test src/search/handlers.test.ts && npx tsc --noEmit
npx wrangler dev --env staging --remote &   # remote 模式连 staging D1（items_fts 已建但可能未 backfill——只验参数路径与 SQL 不报错）
sleep 8
curl -s "http://localhost:8787/api/search?q="            # 期望 400 empty_query
curl -s "http://localhost:8787/api/search?q=$(python3 -c 'print("a"*101)')"  # 400 query_too_long
curl -s "http://localhost:8787/api/search?q=test&source=evil"                # 400 invalid_source
curl -s "http://localhost:8787/api/search?q=claude"      # 200，mode=grouped（groups 可为空数组）
curl -s "http://localhost:8787/api/search/suggest?prefix="                    # 200 terms 数组
kill %1
```
Expected: 各状态码与 error 字段如注释。

- [ ] **Step 7: Commit**

```bash
git add worker/src/search/handlers.ts worker/src/search/handlers.test.ts worker/src/index.ts worker/src/track.ts
git commit -m "feat(search): /api/search 与 /suggest（分组/列表/限流/边缘缓存）+ search_* 埋点白名单"
```

---

### Task 7: staging 部署 + backfill + 集成断言脚本

**Files:**
- Create: `scripts/search-staging-check.sh`（curl 断言脚本，可重复执行）

**Interfaces:**
- Consumes: Task 1-6 全部；staging 环境
- Produces: 通过的集成断言（后续前端任务的后端基座）

- [ ] **Step 1: 部署前 rebase/工作区检查（CLAUDE.md 强制条款）**

```bash
git fetch origin && git log --oneline origin/main..HEAD | head -20   # 确认只有本分支 commit
git status --short worker/ | grep -v '^??' | grep -v 'src/search\|migrations/026\|src/index.ts\|src/track.ts' && echo "⚠️ 有计划外改动，停下检查" || echo OK
```
**若 `worker/src/digest/node-run.ts` 仍为 dirty**：用临时 worktree 部署，避免把他人未提交改动整包推上 staging：

```bash
git worktree add /tmp/search-deploy feat/c-search
cd /tmp/search-deploy/worker && npm ci
set -a; . /Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-staging.env; set +a
npx wrangler deploy --env staging
cd / && git -C /Users/roxor/brain/30-projects/aifeeds worktree remove /tmp/search-deploy
```
（干净则直接 `cd worker && npx wrangler deploy --env staging`。）

- [ ] **Step 2: 触发 backfill 直至追平**

```bash
set -a; . .secrets/aifeeds-staging.env; set +a
# 循环调用直到 backfillDone=true（admin 凭据在 staging env 文件内）
curl -s -X POST "https://staging-api.ai-feeds.com/api/admin/search/reindex" -u "$ADMIN_USER:$ADMIN_PASS"
npx wrangler d1 execute xlist-staging --env staging --remote --command "SELECT COUNT(*) FROM items_fts;"
```
Expected: items_fts 行数 > 0 且接近 items 合规行数（staging 数据量小于 prod）。

- [ ] **Step 3: 手动触发一次词表构建并验证**

staging cron 全关，用 wrangler dev --remote 的 scheduled 测试端点或临时 curl 触发（读 operations.md「手动触发」节的既有做法；如无现成通道，写一个临时 admin endpoint 并在验证后删除，或直接 `npx tsx` 脚本连 D1 不可行时通过 reindex 同款 admin 模式加 `/api/admin/search/rebuild-terms`——**采用后者并保留**，admin auth 保护）。验证：`SELECT COUNT(*) FROM search_terms;` > 0。

- [ ] **Step 4: 写并执行集成断言脚本**

```bash
#!/usr/bin/env bash
# scripts/search-staging-check.sh — 搜索 API staging 集成断言
set -euo pipefail
BASE="${1:-https://staging-api.ai-feeds.com}"
pass() { echo "✅ $1"; }; fail() { echo "❌ $1"; exit 1; }

j() { curl -s "$@"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

[ "$(code "$BASE/api/search?q=")" = 400 ] && pass "空 q → 400" || fail "空 q"
[ "$(code "$BASE/api/search?q=$(printf 'a%.0s' {1..101})")" = 400 ] && pass "超长 → 400" || fail "超长"
[ "$(code "$BASE/api/search?q=x&source=evil")" = 400 ] && pass "非法 source → 400" || fail "非法 source"
j "$BASE/api/search?q=claude" | grep -q '"mode":"grouped"' && pass "中文/英文分组模式" || fail "grouped"
j "$BASE/api/search?q=claude&source=github" | grep -q '"mode":"list"' && pass "单源 list 模式" || fail "list"
j "$BASE/api/search?q=模型" | grep -q '"mode"' && pass "中文 2 字词" || fail "中文 2 字"
j "$BASE/api/search/suggest?prefix=c" | grep -q '"terms"' && pass "suggest 前缀" || fail "suggest"
j "$BASE/api/search/suggest?prefix=" | grep -q '"terms"' && pass "suggest 热搜" || fail "热搜"
# 限流：连打 14 次（>12），至少一次 429（注意会消耗当分钟额度）
RL=0; for i in $(seq 1 14); do [ "$(code "$BASE/api/search?q=ratelimit$i&_no=$i" -H 'X-Device-Id: rl-test-device')" = 429 ] && RL=1; done
[ "$RL" = 1 ] && pass "限流 429" || fail "限流未触发"
echo "🎉 全部通过"
```

Run: `bash scripts/search-staging-check.sh`
Expected: 全绿。**合规过滤复检**（额外手工步骤）：向 staging items 插入一条 `cn_sensitive=1` 且标题含唯一串 `ZXSENSITIVETESTZX` 的测试行 → reindex → `/api/search?q=ZXSENSITIVETESTZX` 返回空 → 删除测试行。同法验证 `dedup_of` 与软删行。把三条验证的执行结果记录在 commit message 里。

- [ ] **Step 5: Commit**

```bash
git add scripts/search-staging-check.sh
git commit -m "test(search): staging 集成断言脚本（含限流/合规复检记录）"
```

---

### Task 8: 前端基建（IconSearch / AppBar 入口 / 路由 / api client / 历史 / 埋点常量）

**Files:**
- Modify: `dashboard/src/components/icons.tsx`（加 `IconSearch`）
- Modify: `dashboard/src/App.tsx`（顶栏入口 + `/search` lazy 路由）
- Modify: `dashboard/src/main.tsx`（深链 seed 列表加 `/search`）
- Modify: `dashboard/src/api.ts`（`searchItems` / `searchSuggest`）
- Modify: `dashboard/src/lib/telemetry/`（EVENTS 加 7 个 search_* 常量，文件名执行时确认）
- Create: `dashboard/src/lib/searchHistory.ts`
- Create: `dashboard/src/pages/SearchPage.tsx`（本任务只建骨架：读 `?q=`/`&source=`，渲染三态占位）

**Interfaces:**
- Consumes: Task 6 API 契约
- Produces（Task 10/11 依赖，签名不可改）:
  - `searchItems(q: string, opts?: { source?: string; cursor?: string }): Promise<SearchGroupedResponse | SearchListResponse>`（types.ts 里定义两响应类型，字段同 Task 6 契约）
  - `searchSuggest(prefix: string, signal?: AbortSignal): Promise<{ term: string; term_type: string }[]>`
  - `getSearchHistory(): string[]` / `addSearchHistory(q: string): void` / `removeSearchHistory(q: string): void` / `clearSearchHistory(): void`（localStorage key `aifeeds_search_history`，LRU 20，重复词提到最前）
  - `IconSearch`（props 同 icons.tsx 其他 lucide 风 icon）

- [ ] **Step 1: searchHistory.ts 实现（含完整代码）**

```ts
// dashboard/src/lib/searchHistory.ts
const KEY = "aifeeds_search_history";
const MAX = 20;

function read(): string[] {
  try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; }
  catch { return []; }
}
function write(list: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* 隐私模式等忽略 */ }
}
export const getSearchHistory = read;
export function addSearchHistory(q: string) {
  const t = q.trim(); if (!t) return;
  write([t, ...read().filter((x) => x !== t)]);
}
export function removeSearchHistory(q: string) { write(read().filter((x) => x !== q)); }
export function clearSearchHistory() { try { localStorage.removeItem(KEY); } catch { /* */ } }
```

- [ ] **Step 2: icons.tsx 加 IconSearch（lucide "search" 路径）**

```tsx
export function IconSearch(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" width="1em" height="1em" {...props}>
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  );
}
```
（对齐文件内既有 icon 的 props/尺寸写法，如现有惯例不同则跟随现有惯例。）

- [ ] **Step 3: App.tsx 顶栏入口 + 路由**

- 顶栏：`<UserMenu />`（App.tsx ~L1051）之前插入放大镜按钮，`shrink-0`、`aria-label="搜索"`、点击 `navigate("/search")` 并 `track(EVENTS.SEARCH_OPEN, { from: "appbar" })`；样式对齐 UserMenu 触发器（neutral 灰、hover 透明度、`transition-colors`）。
- 路由表：`const SearchPage = lazy(() => import("./pages/SearchPage"))`，`<Route path="/search" element={<SearchPage />} />`（不包 RequireAuth）。
- `main.tsx` seed：深链前缀列表加 `/search`（保证冷启动直达搜索页时返回键回 feed 不出站）。

- [ ] **Step 4: api.ts + types.ts + telemetry EVENTS**

api.ts（走 `apiFetch`，不入 `protectedPaths`）：

```ts
export async function searchItems(q: string, opts: { source?: string; cursor?: string } = {}) {
  const p = new URLSearchParams({ q });
  if (opts.source) p.set("source", opts.source);
  if (opts.cursor) p.set("cursor", opts.cursor);
  return apiFetch<SearchGroupedResponse | SearchListResponse>(`/api/search?${p}`);
}
export async function searchSuggest(prefix: string, signal?: AbortSignal) {
  const r = await apiFetch<{ terms: { term: string; term_type: string }[] }>(
    `/api/search/suggest?prefix=${encodeURIComponent(prefix)}`, { signal });
  return r.terms;
}
```
（`apiFetch` 若不支持 signal 透传，本步顺手加透传参数——只加不改既有行为。）
EVENTS 常量：`SEARCH_OPEN/SEARCH_SUBMIT/SEARCH_SUGGEST_CLICK/SEARCH_RESULT_CLICK/SEARCH_EMPTY/SEARCH_ERROR/SEARCH_PERF` 对应 worker 白名单字符串。

- [ ] **Step 5: SearchPage 骨架（三态占位）+ build 验证**

`useSearchParams` 读 `q`/`source`：无 q 渲染 `<div>起始页</div>` 占位；有 q 无 source 渲染分组占位；有 source 渲染列表占位。页面 head 加 noindex（执行时查现有页面是否有 Helmet 类机制；没有则在 index.html 静态 meta robots 之外为 /search 用 `document.title = "搜索 - AI-Feeds"` 即可，noindex 靠 worker 生成的 robots.txt 或后续 SEO 计划统一处理，本任务只留注释标记）。

Run: `cd dashboard && npm run build`
Expected: 构建零错误。dev server 手动点放大镜能进 `/search` 占位页、返回键回 feed。

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/icons.tsx dashboard/src/App.tsx dashboard/src/main.tsx \
  dashboard/src/api.ts dashboard/src/types.ts dashboard/src/lib/searchHistory.ts \
  dashboard/src/pages/SearchPage.tsx dashboard/src/lib/telemetry
git commit -m "feat(search): 前端基建 — 入口/路由/api client/历史/埋点常量"
```

---

### Task 9: 抽取公共 ItemCard（Feed 卡片分派复用）

**Files:**
- Create: `dashboard/src/components/ItemCard.tsx`
- Modify: `dashboard/src/components/Feed.tsx`（分派 switch 改调公共组件）

**Interfaces:**
- Produces: `<ItemCard item={Item} />` —— 内部按 `item.source_type` 分派到 TweetCard/ThreadCard/GithubCard/PhCard/ClawhubCard/HfPaperCard/BlogCard/PodcastCard/HuodongxingCard，**props 传递与 Feed.tsx 现状逐一对齐**（先读 Feed.tsx:954-981 现有 switch，把每个分支的 props 原样搬进 ItemCard；Feed 特有的注入 props——如曝光跟踪回调——设计成可选 props 由 Feed 传入，SearchPage 不传）。

- [ ] **Step 1: 抽取实现**（纯重构，不改任何行为/样式）
- [ ] **Step 2: 回归验证**

Run: `cd dashboard && npm run build && npm run lint`
dev server smoke：feed 各源卡片渲染正常、点击开抽屉正常、无限滚动正常（对照改动前行为）。
- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/ItemCard.tsx dashboard/src/components/Feed.tsx
git commit -m "refactor(search): 抽取 ItemCard 公共分派组件（Feed 行为不变）"
```

---

### Task 10: 搜索起始页 + 输入态（历史/热搜/源入口/suggestion）

**Files:**
- Modify: `dashboard/src/pages/SearchPage.tsx`
- Create: `dashboard/src/components/search/SearchInput.tsx`、`SearchStart.tsx`

**Interfaces:**
- Consumes: Task 8 全部导出
- Produces: 起始态与输入态完整交互；提交动作统一函数 `submitQuery(q: string, opts?: { source?: string; from: "typed"|"history"|"hot"|"suggest" })` → `addSearchHistory` + `track(EVENTS.SEARCH_SUBMIT, …)` + `navigate(/search?q=…[&source=…])`

**要求（全部落实，UI 遵循 frontend-ux-guidelines）：**
- SearchInput：受控输入，`maxLength={50}`、移动端 `text-base`、placeholder「请输入关键词」、左放大镜 icon、右清空 ✕（有值时）；自动聚焦（起始态）；回车提交；防抖 250ms 调 `searchSuggest`（AbortController 取消在途请求）；suggestion 下拉 `rounded-lg shadow-lg border border-neutral-200 bg-white`，每行 term + 类型弱标（hot_query 显示「热」小徽标，`bg-neutral-100 text-[11px]`），点击即提交（from:"suggest"）；suggest 失败静默（不渲染下拉）。
- SearchStart 三个区块（区块间 `mb-6`）：
  1. 「搜索历史」：chips 流式排布，每 chip 右侧小 ✕ 单删；标题行右侧「清空」文字按钮（`text-[13px] text-neutral-500`，点击 window.confirm「清空全部搜索历史？」）；无历史不渲染该区块。
  2. 「大家在搜」：`searchSuggest("")` 的 top10 chips，点击提交（from:"hot"）；接口空/失败不渲染。
  3. 「按来源浏览」：各源 icon+名 chips（源清单/图标复用 `SourceIcon`），点击 = 聚焦输入框并预选该源（提交后直进该源 list 模式）。
- 移动端全屏（顶部输入行含「取消」返回）；PC 居中 `max-w-2xl`。

- [ ] **Step 1: 实现**
- [ ] **Step 2: 验证**：`npm run build` 零错误；dev server 手测：历史增/删/清空（刷新持久）、热搜点击、防抖与请求取消（Network 面板确认旧请求 aborted）、50 字上限。
- [ ] **Step 3: Commit**

```bash
git add dashboard/src/pages/SearchPage.tsx dashboard/src/components/search/
git commit -m "feat(search): 起始页（历史/热搜/源入口）与输入态 suggestion"
```

---

### Task 11: 分组结果页 + 单源流 + 空态/错误态/429 + 埋点

**Files:**
- Modify: `dashboard/src/pages/SearchPage.tsx`
- Create: `dashboard/src/components/search/SearchGroups.tsx`、`SearchSourceList.tsx`

**Interfaces:**
- Consumes: `searchItems`（Task 8）、`<ItemCard />`（Task 9）、`SkeletonCard`（Feed.tsx 导出）、`drawer.openItem`（`lib/drawer.tsx`）
- Produces: 完整结果页交互链

**要求：**
- **分组页**（`?q=` 无 source）：请求期渲染 3 张 `SkeletonCard`；每组 = 组头（`SourceIcon` + 源中文名 + `共 N 条`，N≥200 显示 `200+` + 右侧「更多 →」`text-[13px] text-sky-600`）+ ≤3 张 `<ItemCard />`；「更多」→ `navigate(/search?q=…&source=…)`；卡片点击 `drawer.openItem(item)` + `track(EVENTS.SEARCH_RESULT_CLICK, { item_id, source_type, position, group_index })`。
- **单源流**（有 source）：页头显示「在 {源名} 中搜索『{q}』」+「搜全部」链接（去掉 source 参数）；IntersectionObserver 无限滚动（对照 Feed.tsx 模式：rootMargin 200px、连败 3 次冷却 + 手动重试按钮）；`has_more=false` 渲染「已到底」。
- **空态**：全空 → 居中「没有找到与『{q}』相关的内容」+ 换词提示 `text-neutral-500` + 热搜 chips；单源空 → 同文案 +「搜全部」按钮（`border border-neutral-300 rounded-md`）；同时 `track(EVENTS.SEARCH_EMPTY, { q, mode })`。
- **异常态**：`apiFetch` 抛错时判别 429（`rate_limited`）→ toast「搜索太频繁，请稍后再试」；其他 → 行内错误块「搜索暂时不可用」+「重试」按钮；`track(EVENTS.SEARCH_ERROR, { kind })`。
- **性能埋点**：每次搜索完成 `track(EVENTS.SEARCH_PERF, { server_ms: resp.query_time_ms, client_ms: 前端计时 })`。
- **返回链**：全程只用 `navigate` push（不 replace），确保 抽屉 → 单源流 → 分组页 → 起始页 → feed 逐级回退；列表滚动位置随 React 状态自然保留（SearchPage 不因 popstate 重挂载——q/source 变化用 useEffect 响应而非 key 重建）。

- [ ] **Step 1: 实现**
- [ ] **Step 2: 验证**：`npm run build && npm run lint` 零错误；dev server（连 staging API）手测全链：分组 → 更多 → 无限滚动 → 抽屉 → 返回逐级回退；空 query 结果空态；断网重试。
- [ ] **Step 3: Commit**

```bash
git add dashboard/src/pages/SearchPage.tsx dashboard/src/components/search/
git commit -m "feat(search): 分组结果页/单源流/空态/异常态与埋点"
```

---

### Task 12: admin dashboard 搜索监控区块

**Files:**
- Modify: `worker/src/admin-dashboard.ts`

**Interfaces:**
- Consumes: events 表 search_* 事件（Task 6 白名单）、`search_sync_state.last_reconcile`（Task 4）、既有 `pctl()` 与 bot 剔除 CTE 模式
- Produces: `/api/admin/analytics` 响应新增 `search` 字段 + dashboard HTML 新增「搜索」区块

**指标（每个一条 SQL，对照现有 metricX 函数写法）：**
1. `metricSearchOverview`：近 7 天 搜索 PV（search_submit 数）/ UV（去重 device）/ 人均次数 / 无结果率（search_empty÷search_submit）/ CTR（search_result_click÷search_submit）
2. `metricSearchTopQueries`：近 7 天 top 20 query（`json_extract(event_payload,'$.q')` 分组计数 + 各自无结果次数）
3. `metricSearchPerf`：search_perf 的 server_ms 与 client_ms p50/p90/p99（复用 `pctl()`）
4. `metricSearchErrors`：近 7 天按日 search_error 分 kind 计数 + 429 数
5. `metricSearchIndexLag`：读 `search_sync_state.last_reconcile`（itemsEligible − ftsRows 差值与时间）

- [ ] **Step 1: 实现 5 个 metric 函数 + 接入 `handleAdminAnalytics` 的 `Promise.all` + HTML 渲染区块**（对照既有区块的表格/卡片写法）
- [ ] **Step 2: 验证**：`npx tsc --noEmit` 零错误；staging 部署后 `curl -u admin "$STAGING/api/admin/analytics" | jq .search` 结构完整（数值可为 0）。
- [ ] **Step 3: Commit**

```bash
git add worker/src/admin-dashboard.ts
git commit -m "feat(search): admin dashboard 搜索监控区块（使用/性能/异常/索引滞后）"
```

---

### Task 13: staging 全量部署 + E2E 验收（orchestrator 亲自执行）

> 本任务由 orchestrator（Fable 5）执行 E2E 与验收断言，发现的缺陷开修复子任务给 subagent。

- [ ] Step 1: worker + dashboard 双部署 staging（沿 Task 7 Step 1 的 worktree 防污染流程；dashboard：`npm run build && npx wrangler pages deploy dist --project-name=xlist-dashboard-staging`，commit message 避免罕见 unicode）
- [ ] Step 2: 重跑 `scripts/search-staging-check.sh` 全绿
- [ ] Step 3: Playwright E2E（移动端 390×844 与 PC 1280×800 两视口，staging.ai-feeds.com）：
  设计文档 §11 验收清单逐条过：入口 → 起始页三块 → suggestion（含防抖）→ 提交 → 分组页 → 更多下钻 → 无限滚动 → 抽屉 → 返回键逐级回退 → 历史增删清空 → 空态（搜随机串）→ 429（脚本触发后 UI 提示）→ 微信 UA smoke（UA override）
- [ ] Step 4: 回归：feed 首屏/各源卡片/抽屉深链/分享不受影响；`search_*` 事件在 staging events 表可查到；admin 面板搜索区块有数
- [ ] Step 5: 时效验证：staging 手动 ingest 一条测试内容 → reindex → 搜索命中 → 删除测试行
- [ ] Step 6: 缺陷清零循环（每个缺陷：定位 → 派 subagent 修 → 重验）

---

### Task 14: 文档同步 + PR

**Files:**
- Modify: `docs/operations.md`（新增：/api/search 与 /suggest 端点、3 张新表、2 个 cron 档、admin reindex/rebuild-terms、监控区块）
- Modify: `TODO.md`（记录搜索功能状态与后续项：高亮/拼音/深度搜索等 V2 备忘）
- Modify: `docs/plans/2026-07-06-c-search-design.md`（状态改「已实施（staging 验收中）」+ 与实现的偏差备注）

- [ ] Step 1: 三份文档更新
- [ ] Step 2: Commit + push + 开 PR（`gh pr create`，base main，PR 描述含设计文档链接、测试结果汇总、验收清单勾选状态、部署影响；结尾带 🤖 Generated with [Claude Code](https://claude.com/claude-code)）
- [ ] Step 3: **停在这里交付用户验收**——prod migration/部署等用户确认后再做

---

## Self-Review 记录

- 设计 §3-§9 全部映射到 Task 1-12；§10 测试计划映射到各任务 Step + Task 7/13；§11 验收清单由 Task 13 执行、§12 协调条款落在 Global Constraints 与 Task 7 Step 1。
- cursor 实现从设计的 `final|rowid` 简化为召回集内 offset（单 query 单源上限 200 条），已在计划头部声明以本计划为准。
- 类型/签名一致性：`searchItems/searchSuggest`（Task 8 ↔ Task 10/11）、`ItemCard`（Task 9 ↔ Task 11）、API 契约（Task 6 ↔ Task 8）、`rebuildSearchTerms`（Task 5 ↔ Task 4 Step 5 已注明接线归属 Task 5）复核无冲突。
