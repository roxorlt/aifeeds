# AI源信 `.cc` 合规内容镜像 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 `ai-feeds.com` 已生成的 AI 内容静态页按明确来源政策和大陆发布审核结果生成 `.cc` 专用版本，由腾讯云 VPS 增量拉取并以纯静态页面发布，同时支持自动下架、人工复核、sitemap 和回流 `.com`。

**Architecture:** `.com` Worker 继续作为唯一数据与审核权威：按源策略和逐条内容审核生成 `.cc` HTML 变体，写入现有 R2，并在 D1 记录当前页状态和追加式变更事件。腾讯云 VPS 上新增零依赖 Node oneshot 同步器，通过独立 HMAC API 拉取 bootstrap/changes/page，校验 SHA-256 后原子落盘；VPS 不持有 D1、DeepSeek 或业务数据库凭据。

**Tech Stack:** Cloudflare Workers TypeScript、D1、R2、DeepSeek Flash（经现有 CF AI Gateway）、Vitest、Node.js 18+ 内置 `fetch/fs/crypto/node:test`、systemd timer、Nginx 静态站。

---

## 0. 已锁定的产品与合规边界

### 0.1 页面行为

- `.cc` 展示真实静态内容，不做空壳页，不自动跳转。
- 用户主动点击“打开 AI Feeds 完整版”才进入 `.com`，链接追加：
  `utm_source=cc&utm_medium=mirror&utm_campaign=cn_seo`。
- `.cc` self-canonical，内部内容链接保持 `.cc`；原文链接指向原始来源。
- `.cc` 不提供评论、UGC、登录态内容或动态筛选。
- blog/podcast 延续现有静态页口径：AI 摘要、结构化分析、最多约 800 字短摘录和原文链接，不输出全文翻译或完整逐字稿。

### 0.2 来源政策

`FeedDef.cc_policy` 必须显式填写，缺失时 fail closed：

| 来源类别 | 初始政策 | 说明 |
|---|---|---|
| 海外厂商官方博客 | `allow` | OpenAI、Google、Microsoft Research、NVIDIA、Hugging Face、Anthropic、Mistral、Stability、Together AI、Midjourney、AI21、Cohere、Databricks、MiniMax |
| 海外第三方 AI 媒体 | `allow` | TechCrunch AI、The Verge AI、MIT Technology Review AI；仍逐条审核 |
| 海外技术播客 | `allow` | Practical AI、Latent Space、No Priors、Eye on AI、The Cognitive Revolution、MLST、Gradient Dissent、官方 MSR/OpenAI Podcast |
| 广泛议题播客 | `manual` | Last Week in AI、Lex Fridman；模型可预审，但必须人工 allow 才发布 |
| 国内博客、媒体、播客、热度雷达 | `deny` | Qwen、美团技术、MiniCPM、量子位、机器之心、新智元、微博科技热搜及 4 个国内播客 |
| GitHub / Product Hunt / HF Paper | `allow` | 仍逐条走 `.cc` 内容审核 |
| X | `allow`，最后一批上线 | 逐条审核，先小样本验证，再分批回填 |
| 未知来源或 registry 缺项 | `deny` | 禁止默认放行 |

特别约定：

- Anthropic 的 GitHub RSS bridge 只是传输渠道，内容仍按官方来源处理。
- MiniMax 当前来源为海外英文站 `minimax.io`，本期显式 `allow`；不得从 `region='foreign'` 自动推导。
- `region`、RSS 所在域、企业国别、编辑来源不是同一概念；发布决策只认显式 `cc_policy`。

### 0.3 逐条内容审核

共同硬门：

```text
is_relevant = 1
AND deleted_at IS NULL
AND dedup_of IS NULL
AND source policy != deny
AND cc_review.status = pass
AND no manual deny override
```

模型输出固定为：

```ts
interface CcRiskFlags {
  china_negative: 0 | 1;
  politics_governance: 0 | 1;
  military_conflict: 0 | 1;
  sanctions_export_control: 0 | 1;
  other_cn_distribution_risk: 0 | 1;
  uncertain: 0 | 1;
  reasons: string[];
}
```

决策表：

```text
china_negative / politics_governance / military_conflict / other risk = 1 → deny
仅 sanctions_export_control=1 或 uncertain=1                         → review
所有 flag=0 且 source policy=allow                                  → pass
source policy=manual                                                 → review
模型失败、超时、JSON 非法、输入缺失                                  → pending
```

审核文本必须与 `.cc` 实际将发布的内容一致：标题、摘要、结构化分析、最终正文摘录或可见正文；不得只审 feed 摘要却发布更长正文。长内容使用“头部 5,000 字符＋中段 3,000＋尾部 3,000”的稳定采样，最多 11,000 字符。

---

## 1. 目标数据流

```text
各源 workflow 完成
  → 现有 .com /i/ 页面生成
  → .cc source policy
  → 复用审核结果或 DeepSeek cc review（fail closed）
  → pass: render cc variant → R2 cc-item-pages/* → cc_item_pages=live
  → deny/review/pending: cc_item_pages=gone 或不生成
  → 仅状态/hash 变化时 append cc_page_events

腾讯云 systemd timer（每 10 分钟）
  → HMAC GET bootstrap / changes
  → HMAC GET page
  → 校验 content_hash
  → 写临时文件并 rename
  → 删除 gone 文件
  → stateDir 构建完整 generation，单次原子切换 public/current
  → 成功后推进 last_seq
```

---

### Task 0: 建立隔离工作区并做只读基线

**Files:**
- No code changes.

**Step 1: 建 worktree**

```bash
git fetch origin
git worktree add .worktrees/feat-cc-content-mirror -b feat/cc-content-mirror origin/main
cd .worktrees/feat-cc-content-mirror
```

Expected: 新工作区分支为 `feat/cc-content-mirror`，不包含主工作区未提交文件。

**Step 2: 记录基线**

```bash
git status --short
git log -1 --oneline
cd worker && npm test
cd ../cc-site/server && npm run smoke
```

Expected: `git status` 为空；Worker 测试和 relay smoke 全绿。

**Step 3: 确认外部前置**

- `ai-feeds.cc` 当前 Nginx root 为 `/www/wwwroot/ai-feeds.cc`。
- Node ≥18。
- 服务器磁盘可用空间至少为预计镜像 HTML 总量的 3 倍。
- 备案号仍为 `京ICP备2025123594号-2`，公安备案为 `京公网安备11010802048455号`。

---

### Task 1: 先堵住现有 `.com` 静态页的 `cn_sensitive` 漏口

**Files:**
- Modify: `worker/src/seo/item-page-run.ts`
- Modify: `worker/src/seo/item-routes.ts`
- Modify: `worker/src/seo-routes.ts`
- Modify: `worker/src/seo/item-page-run.test.ts`
- Modify: `worker/src/seo/item-routes.test.ts`
- Modify: `worker/src/seo-routes.test.ts`

**Step 1: 写失败测试**

增加以下 fixture 与断言：

```ts
const sensitiveExtra = JSON.stringify({
  cn_sensitive: 1,
  workflow_completed_at: '2026-07-20T00:00:00Z',
});
```

- `generateItemPage()` 对 `is_relevant=1 + cn_sensitive=1` 返回
  `{ skipped:true, reason:'cn-sensitive' }`，R2 零写。
- `/i/...` 路由对同一 item 返回 `410 + noindex + no-store`，即使 `item_pages.status='live'`。
- `fetchRelated()` 不返回 `cn_sensitive=1` 的 news item。
- item sitemap 查询不包含 `cn_sensitive=1`。
- backfill 查询不选择 `cn_sensitive=1`。

**Step 2: 运行并确认失败**

```bash
cd worker
npm test -- src/seo/item-page-run.test.ts src/seo/item-routes.test.ts src/seo-routes.test.ts
```

Expected: 至少因缺 `cn_sensitive` gate 失败。

**Step 3: 最小实现**

新增一个共享纯函数，避免三个出口各自解析：

```ts
export function isCnSensitive(extra: string | null | undefined): boolean {
  if (!extra) return false;
  try {
    return (JSON.parse(extra) as { cn_sensitive?: unknown }).cn_sensitive === 1;
  } catch {
    return false;
  }
}
```

放在 `worker/src/seo/item-page-run.ts` 或拆到
`worker/src/seo/item-page-policy.ts`；若拆文件则同步新增测试。生成、伺服、related、backfill、sitemap 五个出口统一复用相同 SQL/函数口径。

新增管理员 reconciliation 函数：

```ts
export async function reconcileItemPageCompliance(
  env: Env,
  opts?: { limit?: number; dry?: boolean },
): Promise<{ scanned: number; markedGone: number; remaining: number }>;
```

选择当前 `item_pages.status='live'` 且 item 已 `cn_sensitive=1`、`is_relevant!=1`、
`deleted_at IS NOT NULL` 或 `dedup_of IS NOT NULL` 的行，批量改为 `gone`。

**Step 4: 跑测试**

```bash
npm test -- src/seo/item-page-run.test.ts src/seo/item-routes.test.ts src/seo-routes.test.ts
npx tsc --noEmit
```

Expected: PASS，TypeScript 零错误。

**Step 5: Commit**

```bash
git add worker/src/seo
git commit -m "fix(seo): 静态内容页统一拦截涉华敏感条目"
```

---

### Task 2: 把 `.cc` 来源政策写入 registry

**Files:**
- Modify: `worker/src/feeds/types.ts`
- Modify: `worker/src/feeds/registry.ts`
- Create: `worker/src/cc-mirror/source-policy.ts`
- Create: `worker/src/cc-mirror/source-policy.test.ts`

**Step 1: 写类型和失败测试**

```ts
export type CcSourcePolicy = 'allow' | 'manual' | 'deny';
export type EditorialType =
  | 'official'
  | 'third-party-media'
  | 'independent'
  | 'radar';

export interface FeedDef {
  // existing fields...
  cc_policy: CcSourcePolicy;
  editorial_type: EditorialType;
}
```

测试至少锁定：

- TechCrunch、The Verge、MITTR = `allow/third-party-media`。
- OpenAI = `allow/official`。
- Anthropic = `allow/official`，不因 RSS bridge 变成第三方编辑源。
- MiniMax = 显式 `allow/official`。
- Lex Fridman、Last Week in AI = `manual/independent`。
- 量子位、机器之心、新智元、微博和全部国内播客 = `deny`。
- 构造未知 feed key = deny。
- `github/product_hunt/hf_paper/x_list` = `allow` 候选，仍需逐条 review。

**Step 2: 运行并确认失败**

```bash
cd worker
npm test -- src/cc-mirror/source-policy.test.ts
npx tsc --noEmit
```

Expected: registry 因缺 required 字段产生类型错误，测试失败。

**Step 3: 给全部 FeedDef 显式标注**

不要设置 `cc_policy ?? 'allow'`。所有 registry 条目逐条填写，未知项必须由：

```ts
return { policy: 'deny', reason: 'unknown-source' };
```

关闭。

实现：

```ts
export interface CcSourceDecision {
  policy: CcSourcePolicy;
  editorialType: EditorialType | 'platform';
  reason: string;
  sourceKey?: string;
}

export function resolveCcSourcePolicy(row: {
  source_type: string;
  extra?: string | null;
}): CcSourceDecision;
```

blog 使用 `extra.feed_key`，podcast 使用 `extra.show_key` 回查 registry。不得只看
`region` 或域名后缀。

**Step 4: 跑测试**

```bash
npm test -- src/cc-mirror/source-policy.test.ts
npx tsc --noEmit
```

Expected: PASS。

**Step 5: Commit**

```bash
git add worker/src/feeds worker/src/cc-mirror
git commit -m "feat(cc): 为全部内容源声明大陆镜像政策"
```

---

### Task 3: D1 schema——审核、页面、事件和人工覆盖

**Files:**
- Create: `worker/migrations/029-cc-content-mirror.sql`
- Create: `worker/migrations/030-cc-content-mirror-decision-token.sql`
- Create: `worker/migrations/031-cc-content-mirror-bootstrap-index.sql`
- Modify: `worker/schema.sql`
- Create: `worker/src/cc-mirror/db-contract.test.ts`

**Step 1: 写顺序 migration**

`029` 只创建初始 4 张表和索引：

```sql
CREATE TABLE IF NOT EXISTS cc_item_reviews (
  item_id TEXT PRIMARY KEY,
  policy_version INTEGER NOT NULL,
  source_policy TEXT NOT NULL,
  review_status TEXT NOT NULL,
  flags_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  review_text_hash TEXT NOT NULL,
  model TEXT,
  reviewed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cc_reviews_status
  ON cc_item_reviews(review_status, reviewed_at);

CREATE TABLE IF NOT EXISTS cc_item_overrides (
  item_id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cc_item_pages (
  item_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  url_path TEXT NOT NULL UNIQUE,
  r2_key TEXT NOT NULL,
  content_hash TEXT,
  title TEXT NOT NULL,
  published_at TEXT,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cc_pages_status_source
  ON cc_item_pages(status, source, generated_at);

CREATE TABLE IF NOT EXISTS cc_page_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  op TEXT NOT NULL,
  content_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cc_page_events_item
  ON cc_page_events(item_id, seq);
```

`030` 是独立的前向 migration，不得把字段反向补写进已经发布的 `029`：

```sql
ALTER TABLE cc_item_overrides
  ADD COLUMN decision_token TEXT NOT NULL DEFAULT '';
```

`031` 也是独立前向 migration，为 bootstrap 的 live + item cursor 查询补索引；
不得修改已经执行过的 `029`/`030`：

```sql
CREATE INDEX IF NOT EXISTS idx_cc_pages_status_item
  ON cc_item_pages(status, item_id);
```

合法枚举由应用层验证：

- review: `pending | pass | review | deny`
- page status: `live | gone`
- event op: `upsert | delete`
- override: `allow | deny`

**Step 2: 写 DB contract 测试**

测试 `029` 重复执行幂等，再按顺序执行 `030`、`031`；检查 4 张表、关键索引和
`decision_token TEXT NOT NULL DEFAULT ''`。另在只执行 `029` 后插入旧 override，
再执行 `030`，断言旧行 token 被安全补为 `''`；插入 event 后 `seq` 严格递增。
对已有 `029 + 030` 数据库执行 `031`，用真实 SQLite
`EXPLAIN QUERY PLAN` 断言 bootstrap 查询使用
`idx_cc_pages_status_item`，且不创建 `ORDER BY` 临时 B-tree。

**Step 3: 本地执行**

```bash
cd worker
npx wrangler d1 execute xlist --local --file=migrations/029-cc-content-mirror.sql
npx wrangler d1 execute xlist --local \
  --file=migrations/030-cc-content-mirror-decision-token.sql
npx wrangler d1 execute xlist --local \
  --file=migrations/031-cc-content-mirror-bootstrap-index.sql
npx wrangler d1 execute xlist --local \
  --command="PRAGMA table_info('cc_item_overrides');"
npx wrangler d1 execute xlist --local \
  --command="PRAGMA index_list('cc_item_pages');"
npm test -- src/cc-mirror/db-contract.test.ts
```

Expected: 三个 migration 按 `029 → 030 → 031` 成功；`PRAGMA` 中
`decision_token` 为 `TEXT`、`notnull=1`、默认值 `''`，且存在
`idx_cc_pages_status_item`；测试 PASS。

**Step 4: 同步 schema.sql**

把 `029 + 030 + 031` 的最终结构补进 `worker/schema.sql`，保证新环境从零初始化不缺表和索引。

**Step 5: Commit**

```bash
git add worker/migrations/029-cc-content-mirror.sql \
  worker/migrations/030-cc-content-mirror-decision-token.sql \
  worker/migrations/031-cc-content-mirror-bootstrap-index.sql \
  worker/schema.sql worker/src/cc-mirror/db-contract.test.ts
git commit -m "feat(cc): 增加镜像审核页面与变更事件表"
```

---

### Task 4: `.cc` 可见文本构建与结构化审核

**Files:**
- Create: `worker/src/cc-mirror/review-text.ts`
- Create: `worker/src/cc-mirror/review-text.test.ts`
- Create: `worker/src/cc-mirror/review.ts`
- Create: `worker/src/cc-mirror/review.test.ts`
- Modify: `worker/src/index.ts`（仅增加 `Env.CC_MIRROR_ENABLED?`）

**Step 1: 写可见文本测试**

接口：

```ts
export function buildCcReviewText(
  row: RenderRow,
  env: Env,
): { text: string; hashInput: string };
```

测试：

- blog 只包含将展示的摘要、要点和短摘录，不带 `body_markdown_zh` 后半全文。
- podcast 不带 transcript 全文。
- X 包含完整展示推文/串/引用。
- GH 长 README 采用 head/middle/tail，最终 ≤11,000 字符。
- HTML 标签、脚本和实体被还原为安全纯文本。
- 相同输入稳定得到相同 `hashInput`。

实现时复用 `renderItemBody()`，将其安全 HTML 转纯文本后采样，避免再写一套字段口径。

**Step 2: 写 classifier 失败测试**

接口：

```ts
export const CC_REVIEW_POLICY_VERSION = 1;

export interface CcReviewResult {
  status: 'pending' | 'pass' | 'review' | 'deny';
  flags: CcRiskFlags;
  reason: string;
  reused: boolean;
}

export async function reviewCcItem(
  env: Env,
  itemId: string,
  opts?: { force?: boolean; dry?: boolean },
): Promise<CcReviewResult>;
```

用 mock `fetch` 锁定：

- 全 flags 0 + source allow → pass。
- `china_negative=1` → deny。
- `military_conflict=1` → deny。
- `sanctions_export_control=1` → review。
- `uncertain=1` → review。
- source manual 即使模型全 0 → review。
- source deny 不调用 LLM → deny。
- LLM 失败/timeout/非法 JSON → pending，绝不 pass。
- 同 `review_text_hash + policy_version` 复用旧结果，零 LLM。
- override deny 最高优先级；override allow 可把 review/deny 变为 pass，但不能绕过
  `is_relevant=0`、deleted、dedup 或 source deny。

**Step 3: 实现 prompt**

调用现有：

```ts
callDeepSeekJson<CcRiskFlags>(
  env.DEEPSEEK_API_KEY!,
  DEEPSEEK_FLASH,
  prompt,
  { maxTokens: 700, timeoutMs: 60_000, retries: 1 },
);
```

Prompt 必须明确：

- 这是“是否适合在中国大陆公开静态发布”的分发判断，不是事实核查。
- 中性产品/技术/研究内容应为 0。
- 对华负面、政治治理、军事冲突分别独立标记。
- 中性出口管制事实标 `sanctions_export_control=1`，交人工处理。
- 不确定必须 `uncertain=1`。
- 只输出固定 JSON，`reasons` 最多 5 项，每项 ≤80 字。

验证所有字段严格为 `0|1`；缺任一字段按 `uncertain=1` 处理。

**Step 4: 跑测试**

```bash
cd worker
npm test -- src/cc-mirror/review-text.test.ts src/cc-mirror/review.test.ts
npx tsc --noEmit
```

Expected: PASS。

**Step 5: Commit**

```bash
git add worker/src/cc-mirror worker/src/index.ts
git commit -m "feat(cc): 增加逐条大陆发布审核与结果复用"
```

---

### Task 5: `.cc` 页面变体、R2 生命周期和删除事件

**Files:**
- Create: `worker/src/cc-mirror/profile.ts`
- Create: `worker/src/cc-mirror/page-run.ts`
- Create: `worker/src/cc-mirror/page-run.test.ts`
- Modify: `worker/src/seo/item-page.ts`
- Modify: `worker/src/seo/item-page.test.ts`
- Modify: `worker/src/seo/item-page-hook.ts`
- Modify: `worker/src/seo/item-page-hook.test.ts`
- Modify: `worker/src/index.ts`（Env 加 `CC_SITE_BASE?`）

**Step 1: 先写 renderer 失败测试**

将 renderer 扩展为：

```ts
export interface ItemPageProfile {
  siteBase: string;
  interactiveBase: string;
  apiBase: string;
  brandName: string;
  titleSuffix: string;
  ccVariant: boolean;
}

export function renderItemPageHtml(
  row: RenderRow,
  env: Env,
  related?: RenderedItem[],
  profile?: ItemPageProfile,
): string;
```

默认 profile 保持 `.com` 现状零回归。`.cc` profile：

```ts
{
  siteBase: env.CC_SITE_BASE || 'https://ai-feeds.cc',
  interactiveBase: env.SITE_BASE || 'https://ai-feeds.com',
  apiBase: env.API_BASE || 'https://api.ai-feeds.com',
  brandName: 'AI源信',
  titleSuffix: 'AI源信',
  ccVariant: true,
}
```

断言：

- canonical/og:url/JSON-LD/mainEntity/related 内链全部是 `.cc`。
- CTA 是 `.com` 用户点击链接并带 UTM，没有 meta refresh、location script 或自动跳转。
- 页面标题与品牌显示“AI源信”。
- footer 含两条备案号、`support@ai-feeds.cc`、隐私/条款/联系链接。
- 原文链接仍为来源 URL。
- blog/podcast 仍是短摘录而非全文。
- 默认 `.com` profile 的 snapshot 不变。

**Step 2: 写 page lifecycle 失败测试**

接口：

```ts
export function ccItemPageR2Key(
  itemId: string,
  contentHash: string,
): string | null;

export async function syncCcItemPage(
  env: Env,
  itemId: string,
  opts?: { forceReview?: boolean; dry?: boolean },
): Promise<{
  itemId: string;
  status: 'live' | 'gone' | 'skipped';
  reason: string;
  eventCreated: boolean;
}>;

export async function markCcItemPageGone(
  env: Env,
  itemId: string,
  reason: string,
): Promise<void>;
```

测试：

- review pass → R2 写含 64hex `content_hash` 的不可变
  `cc-item-pages/.../<hash>.html`、`cc_item_pages=live`、event=`upsert`。
- review pending/review/deny → 不写 HTML；已有 live 行变 gone 并产生 delete event。
- HTML SHA-256 等于 `content_hash`。
- 相同 hash 且已 live → 不新增 event。
- live 内容变化 → 新增一个 upsert event。
- 重复 gone → 不重复写 delete event。
- dry 模式 D1/R2 零写。

**Step 3: 实现新内容挂载**

`syncItemPageOnEnrichDone()` 保持非阻塞：

```ts
if (env.CC_MIRROR_ENABLED === '1') {
  await syncCcItemPage(env, id);
}
```

任何 `.cc` review/render/R2 错误只记录：

```text
[cc-mirror] <itemId>: sync failed (non-blocking)
```

不得让 `.cc` 故障影响 `.com` workflow。

当 `relevant=false` 时同时 `markCcItemPageGone()`。

**Step 4: 跑测试**

```bash
cd worker
npm test -- src/seo/item-page.test.ts src/seo/item-page-hook.test.ts src/cc-mirror/page-run.test.ts
npx tsc --noEmit
```

Expected: PASS。

**Step 5: Commit**

```bash
git add worker/src/seo worker/src/cc-mirror worker/src/index.ts
git commit -m "feat(cc): 生成自 canonical 的大陆静态页变体"
```

---

### Task 6: 管理员回填、复核、下架和统计 API

**Files:**
- Create: `worker/src/cc-mirror/admin.ts`
- Create: `worker/src/cc-mirror/admin.test.ts`
- Modify: `worker/src/index.ts`
- Modify: `worker/src/admin.ts`（运维工具页只加链接或最小表单，非完整 CMS）

**Step 1: 写失败测试**

路由全部先走现有 `checkAdminAuth()`：

```text
GET  /api/admin/cc-mirror/stats
GET  /api/admin/cc-mirror/reviews?status=review&limit=100&cursor=...
POST /api/admin/cc-mirror/decision
POST /api/admin/cc-mirror/backfill
POST /api/admin/cc-mirror/reconcile
```

`decision` body：

```json
{
  "item_id": "blog:the-verge:...",
  "action": "allow",
  "reason": "人工确认纯 AI 产品内容"
}
```

测试：

- 未鉴权 401。
- action 非 allow/deny、reason 空或 item 不存在 → 400。
- allow 后立即调用 `syncCcItemPage()`；deny 后立即 gone/delete event。
- reviews cursor 稳定、不重复。
- stats 返回 source policy、review status、page status、pending event 数量。
- backfill 支持 `source=x|gh|ph|hf-paper|news`、`feed_key`、`limit<=100`、
  `dry=1`、`force_review=1`。
- reconcile 会重新应用最新来源政策和 override，来源由 allow→deny 时产生 delete event。

**Step 2: 实现批处理契约**

```ts
export async function backfillCcMirror(
  env: Env,
  opts: {
    source?: 'x' | 'gh' | 'ph' | 'hf-paper' | 'news';
    feedKey?: string;
    limit?: number;
    cursor?: string;
    dry?: boolean;
    forceReview?: boolean;
  },
): Promise<{
  scanned: number;
  live: number;
  review: number;
  denied: number;
  pending: number;
  nextCursor: string | null;
}>;
```

游标用 item id，不用 OFFSET。单次默认 20、最大 100；LLM 并发最大 5。

**Step 3: 跑测试**

```bash
cd worker
npm test -- src/cc-mirror/admin.test.ts
npx tsc --noEmit
```

Expected: PASS。

**Step 4: Commit**

```bash
git add worker/src/cc-mirror worker/src/index.ts worker/src/admin.ts
git commit -m "feat(cc): 增加镜像回填复核与下架管理接口"
```

---

### Task 7: `.cc` VPS 专用 HMAC 同步 API

**Files:**
- Create: `worker/src/cc-mirror/auth.ts`
- Create: `worker/src/cc-mirror/auth.test.ts`
- Create: `worker/src/cc-mirror/sync-routes.ts`
- Create: `worker/src/cc-mirror/sync-routes.test.ts`
- Modify: `worker/src/index.ts`（Env 加 `CC_SYNC_SECRET?`，路由 wiring 与 bot gate exemption）
- Modify: `worker/src/seo-routes.ts`（robots disallow `/api/cc-sync/`）

**Step 1: 写 HMAC 失败测试**

请求头：

```text
X-CC-Timestamp
X-CC-Signature
```

签名原文：

```text
timestamp + "\n"
+ method.toUpperCase() + "\n"
+ pathname + "\n"
+ sortedCanonicalQuery + "\n"
+ sha256Hex(body)
```

要求：

- 时间窗 60 秒。
- query 先按 key/value 排序并 RFC3986 编码。
- 常数时间比较。
- method/path/query/body 任一被改动都验签失败。
- 所有 method 的实际 body 都参与 SHA-256；body 上限 64 KiB。先拒绝明确超限的
  `Content-Length`，无长度或伪小长度也必须逐块计数，越限立即 cancel 并返回
  `413`，不得先无界 `arrayBuffer()`。
- missing secret = 503；缺头/过期/错误签名 = 401。
- 不复用微信 `BRIDGE_SECRET`。

**Step 2: 写路由失败测试**

```text
GET /api/cc-sync/bootstrap?after_item_id=&limit=200&watermark=
GET /api/cc-sync/changes?after_seq=123&limit=200
GET /api/cc-sync/page?item_id=...&content_hash=<64hex>
GET /api/cc-sync/health
```

契约：

```ts
interface BootstrapResponse {
  watermark: number;
  items: Array<{
    item_id: string;
    source: string;
    url_path: string;
    content_hash: string;
    title: string;
    published_at: string | null;
  }>;
  next_after_item_id: string | null;
}

interface ChangesResponse {
  items: Array<{
    seq: number;
    item_id: string;
    op: 'upsert' | 'delete';
    source: string;
    url_path: string;
    content_hash: string | null;
    title: string;
    published_at: string | null;
  }>;
  next_after_seq: number;
}
```

- bootstrap 首次固定 `watermark=MAX(cc_page_events.seq)`；后续页必须回传同 watermark。
- bootstrap 只列当前 live 页，按 `item_id` 游标分页。
- changes 按 seq 升序，重复 item event 不丢；客户端负责幂等。
- page 必须同时接收 `item_id` 与预期 `content_hash`，先确认存在对应
  `op='upsert'` 的 `cc_page_events`，再按
  `ccItemPageR2Key(item_id, content_hash)` 读取不可变私有版本；不得只按当前
  `cc_item_pages` 指针取“最新版”。
- page 命中事件且不可变 R2 版本存在时 200，ETag=`content_hash`；hash 非法、
  无对应 upsert event 或对象缺失时 404。这样客户端重放 H1→H2 时，即使当前页已是
  H2 或 gone，也仍可安全拉到 H1 对应 bytes。
- 所有响应 `Cache-Control:no-store`。
- limit 默认 200，最大 500。

**Step 3: 路由 wiring**

`/api/cc-sync/*` 可绕过通用 bot UA gate，但必须在 handler 内先验 HMAC；不得成为匿名公开接口。

**Step 4: 跑测试**

```bash
cd worker
npm test -- src/cc-mirror/auth.test.ts src/cc-mirror/sync-routes.test.ts
npx tsc --noEmit
npx wrangler deploy --dry-run
```

Expected: PASS，Worker bundle 成功。

**Step 5: Commit**

```bash
git add worker/src/cc-mirror worker/src/index.ts worker/src/seo-routes.ts
git commit -m "feat(cc): 提供 HMAC 保护的静态页增量同步接口"
```

---

### Task 8: 腾讯云零依赖同步客户端

**Files:**
- Create: `cc-site/sync/package.json`
- Create: `cc-site/sync/config.mjs`
- Create: `cc-site/sync/auth.mjs`
- Create: `cc-site/sync/state.mjs`
- Create: `cc-site/sync/fs-safe.mjs`
- Create: `cc-site/sync/client.mjs`
- Create: `cc-site/sync/sync.mjs`
- Create: `cc-site/sync/.env.example`
- Create: `cc-site/sync/test/auth.test.mjs`
- Create: `cc-site/sync/test/fs-safe.test.mjs`
- Create: `cc-site/sync/test/sync.test.mjs`

**Step 1: 定义配置**

```text
CC_SYNC_BASE_URL=https://api.ai-feeds.com
CC_SYNC_SECRET=<secret>
CC_SITE_ROOT=/www/wwwroot/ai-feeds.cc
CC_SYNC_STATE_DIR=/var/lib/aifeeds-cc-sync
CC_SYNC_CONCURRENCY=8
CC_SYNC_PAGE_LIMIT=200
```

真 secret 只放 `/etc/aifeeds/cc-sync.env`，权限 `600 root:root`。

**Step 2: 写 auth 互操作测试**

Node 端签名必须与 Worker fixture 完全一致。固定 timestamp/method/path/query/body，断言 hex signature 等于 Worker 测试中的常量。

**Step 3: 写路径安全测试**

`url_path` 只允许：

```text
^/i/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$
```

并必须通过 `decodeURIComponent` 后拒绝：

- `..`
- 空 segment
- NUL
- 反斜杠
- 双编码 traversal
- 解析后逃出 `${CC_SITE_ROOT}/i`
- symlink parent

映射：

```text
/i/x/123 → /www/wwwroot/ai-feeds.cc/i/x/123/index.html
```

**Step 4: 写同步行为测试**

用本地 mock HTTP server：

- 首次无 state → bootstrap 全量 → 拉页面 → hash 校验 → 原子写 → 保存 watermark。
- 首个 bootstrap 响应取得 watermark `W` 后，必须立即把 `W` 冻结在本次
  bootstrap state；所有续页精确回传同一个 `W`，不得用后续响应时的新
  `MAX(seq)` 覆盖。完整 bootstrap 成功后，第一次 changes 必须从精确的 `W`
  开始。
- 并发夹具：取得 `W` 并消费一页后写入 `W+1` 新页面，且该页面
  `item_id` 排在已消费 cursor 之前；续页不会看到它，但从 `W` 开始的 changes
  必须收敛该 upsert。
- 第二次 → changes 增量。
- upsert 相同 hash 不重写。
- 每条 upsert 必须把事件里的 hash 作为
  `/api/cc-sync/page?item_id=...&content_hash=...` 的 `content_hash` 参数拉取，
  不得省略 hash 后读取当前最新版；否则 H1→H2 事件重放会拿错 bytes 并让游标永久卡住。
- delete 删除 `index.html` 并从 state 移除。
- page hash 不符、HMAC 401、网络超时 → 退出码非 0，不推进 cursor。
- 批次中一个失败 → 整批 cursor 不推进，下一次安全重试。
- state 写临时文件后 rename，进程中断不会损坏旧 state。
- `--dry-run` 零文件写。
- `--full` 重新 bootstrap，并在完整成功后删除本地 state 中远端已不存在的陈旧页面。

state 格式：

```json
{
  "schema": 1,
  "last_seq": 0,
  "bootstrap": null,
  "pages": {
    "/i/news/example": {
      "hash": "sha256...",
      "source": "news",
      "title": "标题",
      "published_at": "2026-07-20T00:00:00Z"
    }
  }
}
```

**Step 5: 实现并跑测试**

```bash
node --test cc-site/sync/test/*.test.mjs
node --check cc-site/sync/sync.mjs
```

Expected: PASS。

**Step 6: Commit**

```bash
git add cc-site/sync
git commit -m "feat(cc): 增加腾讯云静态内容增量同步器"
```

---

### Task 9: `.cc` 归档页、sitemap 和手工静态页共存

**Files:**
- Create: `cc-site/sync/publish-indexes.mjs`
- Create: `cc-site/sync/static-urls.json`
- Create: `cc-site/sync/test/publish-indexes.test.mjs`
- Create: `cc-site/sitemap-static.xml`
- Modify: `cc-site/index.html`
- Modify: `cc-site/robots.txt`
- Modify: `cc-site/deploy.sh`
- Modify: `cc-site/README.md`

**Step 1: 写失败测试**

同步完成后从 state 生成：

```text
/var/lib/aifeeds-cc-sync/public/current/ai-news/index.html
/var/lib/aifeeds-cc-sync/public/current/ai-news/page/2/index.html ...
/var/lib/aifeeds-cc-sync/public/current/sitemap.xml
/sitemap-static.xml
/var/lib/aifeeds-cc-sync/public/generations/<uuid>/sitemaps/news-1.xml
/var/lib/aifeeds-cc-sync/public/generations/<uuid>/sitemaps/x-1.xml
/var/lib/aifeeds-cc-sync/public/generations/<uuid>/sitemaps/gh-1.xml
/var/lib/aifeeds-cc-sync/public/generations/<uuid>/sitemaps/ph-1.xml
/var/lib/aifeeds-cc-sync/public/generations/<uuid>/sitemaps/hf-paper-1.xml
/var/lib/aifeeds-cc-sync/public/generations/<uuid>/sitemaps/archive.xml
```

规则：

- 归档按 `published_at DESC, url_path ASC`，每页 50。
- 所有 item 链接为 `.cc`。
- archive canonical 为 `.cc`。
- 每个 sitemap shard 最多 45,000 URL。
- sitemap index 只引用实际存在 shard。
- sitemap index 的生成分片只引用
  `/sitemaps/<generation-v4-uuid>/<allowlisted-file>.xml`；不引用跨代稳定
  `/sitemaps/<file>.xml`。
- XML 全部转义。
- archive、shards 与 sitemap index 同代写入 staging 并全部 fsync，最后只原子
  替换一次 `public/current` 相对 symlink。
- GC 保留按有效 manifest 时间排序的最新 24 个完整 generation，并额外无条件保留
  journal current/previous；正常最多 24 个，异常时最多 26 个完整 generation。
  10 分钟 timer + 30 秒 jitter 下提供约 4 小时分片寿命，覆盖 600 秒 HTTP 缓存并
  留出 3 小时以上 crawler grace。
- delete 后对应 URL 不再出现在 archive/sitemap。
- 30,001 fixture 在合理内存内完成。

**Step 2: 修改静态部署所有权**

`cc-site/deploy.sh` 不再部署旧的根目录 `sitemap.xml`。线上
`https://ai-feeds.cc/sitemap.xml` 由 Nginx alias 指向同步器的
`/var/lib/aifeeds-cc-sync/public/current/sitemap.xml`。同步器拥有：

```text
/var/lib/aifeeds-cc-sync/public/generations/
/var/lib/aifeeds-cc-sync/public/current
/var/lib/aifeeds-cc-sync/public/publication-journal.json
/i/
```

手工部署只维护：

```text
index/privacy/terms/contact/style/assets/cc-prompts/robots/sitemap-static
```

防止日后跑 `deploy.sh` 把 3 万页 sitemap 覆盖回旧单文件。

**Step 3: 首页和 robots**

- 首页导航增加“AI 资讯”→ `/ai-news/`。
- robots 指向 `https://ai-feeds.cc/sitemap.xml`。
- robots disallow `/auth/`，其他公开静态内容 allow。

**Step 4: 跑测试**

```bash
node --test cc-site/sync/test/publish-indexes.test.mjs
bash -n cc-site/deploy.sh
```

Expected: PASS。

**Step 5: Commit**

```bash
git add cc-site
git commit -m "feat(cc): 生成内容归档与分片 sitemap"
```

---

### Task 10: systemd timer、部署脚本和 Nginx 静态规则

**Files:**
- Create: `cc-site/sync/aifeeds-cc-sync.service`
- Create: `cc-site/sync/aifeeds-cc-sync.timer`
- Create: `cc-site/sync/nginx-content-mirror.conf`
- Create: `cc-site/sync/deploy-to-cc.sh`
- Modify: `cc-site/sync/README.md`（若 Task 8 未创建则本 Task 创建）

**Step 1: systemd unit**

oneshot service：

```ini
[Service]
Type=oneshot
User=aifeeds-sync
Group=www
UMask=0027
EnvironmentFile=/etc/aifeeds/cc-sync.env
ExecStart=/usr/bin/node /opt/aifeeds-cc-sync/sync.mjs
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/aifeeds-cc-sync
ReadWritePaths=/www/wwwroot/ai-feeds.cc/i
```

timer：

```ini
[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
RandomizedDelaySec=30
Persistent=true
```

部署时 `aifeeds-sync` 只能写 `/i` 和 `/var/lib/aifeeds-cc-sync`；站点根及
`/ai-news` 对同步用户只读，不能写 `index.html`、隐私条款、relay 源码或
`/etc/aifeeds`。`CC_SYNC_STATE_DIR` 必须预建为
`aifeeds-sync:www 0750`，不能依赖 service 首次运行临时创建：

```bash
sudo install -d -o aifeeds-sync -g www -m 0750 /var/lib/aifeeds-cc-sync
```

**Step 2: Nginx**

加入：

```nginx
location ^~ /i/ {
    try_files $uri $uri/ $uri/index.html =404;
    add_header Cache-Control "public, max-age=600" always;
}

location ^~ /ai-news/ {
    alias /var/lib/aifeeds-cc-sync/public/current/ai-news/;
    try_files $uri $uri/ $uri/index.html =404;
    add_header Cache-Control "public, max-age=600" always;
}

location = /sitemap.xml {
    alias /var/lib/aifeeds-cc-sync/public/current/sitemap.xml;
    default_type application/xml;
    add_header Cache-Control "public, max-age=600" always;
}

location ~ "\A/sitemaps/(?<generation>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/(?<sitemap>(?:archive|(?:news|x|gh|ph|hf-paper)-[1-9][0-9]*)\.xml)\z" {
    alias /var/lib/aifeeds-cc-sync/public/generations/$generation/sitemaps/$sitemap;
    default_type application/xml;
    add_header Cache-Control "public, max-age=600" always;
}

# 不得写成 ^~，否则上面的严格 regex 不会参与匹配。
location /sitemaps/ {
    return 404;
}
```

严格 regex 的两个 capture 都不接受 `/`、`..`、百分号或任意文件名；旧 root index
缓存命中时会继续读取其 generation 下未改变的 XML。不得退回
`public/current/sitemaps/` alias，也不得影响现有 `/auth/wechat/` 反代。

**Step 3: 部署脚本**

脚本完成：

1. 从 `.secrets/aifeeds-{target}.env` 读取 `CC_SYNC_SECRET`。
2. scp 到 `/tmp`，再 sudo 安装 `/opt/aifeeds-cc-sync`。
3. 写 `/etc/aifeeds/cc-sync.env`，不输出 secret。
4. 创建专用用户，并用 `aifeeds-sync:www 0750` 预建
   `/var/lib/aifeeds-cc-sync`。
5. 安装/enable timer。
6. 先跑 `node --test`，再 `systemctl start aifeeds-cc-sync.service`。
7. service 首次成功后，以 Nginx worker 用户验证可遍历并读取 current：

   ```bash
   sudo -u www test -x /var/lib/aifeeds-cc-sync
   sudo -u www test -x /var/lib/aifeeds-cc-sync/public/current
   sudo -u www test -r /var/lib/aifeeds-cc-sync/public/current/sitemap.xml
   sudo -u www test -r /var/lib/aifeeds-cc-sync/public/current/sitemaps/archive.xml
   ```

8. 上述检查与 `nginx -t` 都成功后才 reload。

**Step 4: 静态检查**

```bash
bash -n cc-site/sync/deploy-to-cc.sh
node --test cc-site/sync/test/*.test.mjs
```

Expected: PASS。

**Step 5: Commit**

```bash
git add cc-site/sync
git commit -m "feat(cc): 用 systemd 定时发布大陆静态镜像"
```

---

### Task 11: Worker 全量回归与 staging 闭环

**Files:**
- Modify: `docs/operations.md`（先记录 staging 命令和证据位置）

**Step 1: 全量验证**

```bash
cd worker
npm test
npx tsc --noEmit
npx wrangler deploy --dry-run
cd ..
node --test cc-site/sync/test/*.test.mjs
cd cc-site/server && npm run smoke
```

Expected: 全绿；微信 relay 零回归。

**Step 2: staging migration**

```bash
cd worker
npx wrangler d1 execute xlist-staging --env staging --remote \
  --file=migrations/029-cc-content-mirror.sql
npx wrangler d1 execute xlist-staging --env staging --remote \
  --file=migrations/030-cc-content-mirror-decision-token.sql
npx wrangler d1 execute xlist-staging --env staging --remote \
  --file=migrations/031-cc-content-mirror-bootstrap-index.sql
npx wrangler d1 execute xlist-staging --env staging --remote \
  --command="PRAGMA table_info('cc_item_overrides');"
npx wrangler d1 execute xlist-staging --env staging --remote \
  --command="PRAGMA index_list('cc_item_pages');"
```

Expected: `029 → 030 → 031` 严格按顺序成功，4 张表和索引存在；部署前确认
`decision_token` 为 `TEXT`、`notnull=1`、默认值 `''`，并确认
`idx_cc_pages_status_item` 存在。

**Step 3: staging secrets/vars**

- `CC_SYNC_SECRET`：staging 独立随机值。
- `CC_SITE_BASE=https://ai-feeds.cc`：仅用于检查最终 canonical；不直接发布线上。
- `CC_MIRROR_ENABLED` 暂不设，先手工 backfill。

```bash
openssl rand -hex 32
npx wrangler secret put CC_SYNC_SECRET --env staging
npx wrangler deploy --env staging
```

**Step 4: 三个海外媒体小样本**

对 `techcrunch`、`the-verge`、`mit-tech-review` 各 dry-run 10 条，再真实各 10 条。

验收每个来源至少人工看 5 条：

- 页面只包含 AI 内容。
- `.cc` canonical、内部链接、品牌、备案正确。
- `.com` CTA 是用户点击且有 UTM。
- 原文链接正确。
- 无自动跳转。
- blog 不出现全文搬运。
- `cn_sensitive=1` fixture 不生成。

**Step 5: 用 staging API 同步到临时目录**

在本机或服务器：

```bash
CC_SITE_ROOT=/tmp/aifeeds-cc-staging-root \
CC_SYNC_BASE_URL=https://staging-api.ai-feeds.com \
node cc-site/sync/sync.mjs --full
```

Expected:

- `/tmp/.../i/` 页面存在且 hash 对账。
- archive/sitemap 生成。
- 删除一个测试 item 后下一轮文件消失，sitemap 无该 URL。
- 错误 HMAC 返回 401。

**Step 6: 记录证据并 commit**

在 `docs/operations.md` 记录：

- migration 时间
- deployed version
- 3 个 source 的 pass/review/deny 数量
- 抽查 URL
- delete SLA 实测

```bash
git add docs/operations.md
git commit -m "docs(cc): 记录大陆镜像 staging 验证"
```

---

### Task 12: Production 分阶段上线

**Files:**
- No new code unless staging reveals defects.

**Step 1: PR 前复核**

```bash
git fetch origin
git rebase origin/main
cd worker && npm test && npx tsc --noEmit
cd .. && node --test cc-site/sync/test/*.test.mjs
git diff --check
git grep -nE 'CC_SYNC_SECRET=.{8}|DEEPSEEK_API_KEY=.{8}' -- . ':!*.example'
```

Expected: 无 secret、无 whitespace error、全绿。

**Step 2: 创建 PR**

PR 必须包含：

- 数据流图。
- source policy 表。
- 审核 fail-closed 说明。
- staging 三媒体样本与删除闭环证据。
- migration 029 和前向 migration 030、031。
- prod rollout 和 rollback 命令。

暂停等待 review/merge。

**Step 3: prod migration 和 secret**

合并后：

```bash
cd worker
npx wrangler d1 execute xlist --remote \
  --file=migrations/029-cc-content-mirror.sql
npx wrangler d1 execute xlist --remote \
  --file=migrations/030-cc-content-mirror-decision-token.sql
npx wrangler d1 execute xlist --remote \
  --file=migrations/031-cc-content-mirror-bootstrap-index.sql
npx wrangler d1 execute xlist --remote \
  --command="PRAGMA table_info('cc_item_overrides');"
npx wrangler d1 execute xlist --remote \
  --command="PRAGMA index_list('cc_item_pages');"
npx wrangler secret put CC_SYNC_SECRET
npx wrangler deploy
```

只有 `029 → 030 → 031` 依次成功，且 `PRAGMA` 确认 `decision_token` 为
`TEXT`、`notnull=1`、默认值 `''` 以及 `idx_cc_pages_status_item` 存在后
才允许部署；先保持 `CC_MIRROR_ENABLED` 关闭。

**Step 4: 部署 VPS 同步器**

```bash
./cc-site/sync/deploy-to-cc.sh prod
systemctl status aifeeds-cc-sync.timer
journalctl -u aifeeds-cc-sync.service -n 100
```

首次使用空目录或 `--dry-run`，确认不会触碰现有首页、提示词库、微信 relay。

**Step 5: 按批回填**

按下面顺序，每批结束都查看 stats 和人工样本：

1. TechCrunch / The Verge / MITTR，各 100。
2. 其他海外官方博客与 allow 播客。
3. GitHub。
4. Product Hunt。
5. HF Paper。
6. X：先 500，再 2,000/批，最后补齐。

Last Week in AI 和 Lex Fridman 保持 `manual`，不计入自动发布量。

每个阶段的 go/no-go：

- 随机抽查 pass 50 条，发现任何应拦未拦即停止下一批、提高
  `CC_REVIEW_POLICY_VERSION` 并重审。
- 国内来源命中数必须为 0。
- pending/review 不得出现在 R2 live、bootstrap、VPS 或 sitemap。
- deny 到 `.cc` 文件消失的实测时间 ≤15 分钟。
- sitemap URL 数必须等于 VPS state live pages 数。

**Step 6: 打开增量**

全量抽查通过后设置：

```bash
npx wrangler secret put CC_MIRROR_ENABLED
# value: 1
npx wrangler deploy
```

观察至少 24 小时新内容自然产生、VPS 自动同步、删除事件和 timer 健康。

**Step 7: 搜索引擎提交**

- 提交 `https://ai-feeds.cc/sitemap.xml` 到百度、搜狗、360、神马和 Bing。
- 首周只观察抓取与收录，不做批量主动推送。
- Google/Bing 若已收录 `.com` 同主题页，保留两域 self-canonical，不相互 canonical。

---

### Task 13: 运维、takedown 和回滚文档

**Files:**
- Modify: `docs/operations.md`
- Modify: `cc-site/README.md`
- Create: `docs/cc-content-policy.md`

**Step 1: 内容政策文档**

记录：

- 来源 allow/manual/deny 表。
- 五类 risk flag 的定义和例子。
- 模型不是法律结论，人工 override 只允许管理员。
- policy version 升级流程。
- 投诉入口 `support@ai-feeds.cc`。

**Step 2: takedown runbook**

```text
收到投诉
→ 查 item_id / cc review / source / 原 URL
→ POST admin decision deny（写原因）
→ 确认 delete event
→ 手动触发 aifeeds-cc-sync.service
→ curl .cc URL = 404
→ grep sitemap 确认已移除
→ 回复投诉人
```

目标 SLA：工作时间 2 小时内，其他时间 24 小时内。

**Step 3: 监控**

每日检查：

- Worker `cc_item_reviews` pending/review/deny 趋势。
- `cc_page_events` backlog。
- VPS `systemctl --failed`。
- `state.last_seq` 是否持续推进。
- disk usage/inode。
- sitemap 与 state 数量对账。

**Step 4: 回滚**

紧急停止新生成：

```bash
npx wrangler secret put CC_MIRROR_ENABLED
# value: 0
npx wrangler deploy
```

停止国内同步但保留现有页：

```bash
sudo systemctl disable --now aifeeds-cc-sync.timer
```

全部内容下线但保留手工站：

```bash
sudo systemctl disable --now aifeeds-cc-sync.timer
sudo mv /www/wwwroot/ai-feeds.cc/i /www/wwwroot/ai-feeds.cc/i.disabled
sudo mv /var/lib/aifeeds-cc-sync/public/current \
  /var/lib/aifeeds-cc-sync/public/current.disabled
```

然后部署只含静态页的 emergency sitemap；不得删除 `/auth/wechat/` relay 或备案页。

**Step 5: Commit**

```bash
git add docs/operations.md docs/cc-content-policy.md cc-site/README.md
git commit -m "docs(cc): 补齐镜像内容政策与下架回滚手册"
```

---

## 最终验收清单

### 内容门禁

- [ ] `is_relevant=0` 不生成。
- [ ] `cn_sensitive=1` 的 blog/podcast 在 `.com` 和 `.cc` 静态出口均不可访问。
- [ ] 国内 feed 全部 deny。
- [ ] 三个海外第三方 AI 媒体可通过逐条审核发布。
- [ ] politics/military/china-negative 自动 deny。
- [ ] sanctions/uncertain 进入 review。
- [ ] pending/review/deny fail closed。
- [ ] manual 来源无人工 allow 不发布。

### 页面

- [ ] `.cc` self-canonical。
- [ ] `.cc` 内容内链不跳 `.com`。
- [ ] CTA 是用户点击 `.com`，无自动跳转。
- [ ] CTA 带 UTM。
- [ ] blog/podcast 非全文。
- [ ] 原文链接与来源署名存在。
- [ ] ICP、公安备案和联系邮箱存在。
- [ ] 页面无可执行 script，只有 JSON-LD 数据岛。

### 同步

- [ ] HMAC method/path/query/body 全覆盖，60 秒 replay window。
- [ ] 独立 `CC_SYNC_SECRET`，不复用微信 bridge。
- [ ] hash 不符拒绝发布。
- [ ] 原子文件/state 写。
- [ ] 批次失败不推进 cursor。
- [ ] delete 可重复执行。
- [ ] traversal/symlink 防护通过。
- [ ] 手工静态站和微信 relay 不受影响。

### SEO 与运维

- [ ] archive 只有 live 页。
- [ ] sitemap 与 VPS state live count 一致。
- [ ] 单 shard <50,000。
- [ ] robots 指向 sitemap index。
- [ ] takedown ≤15 分钟移除文件和 sitemap。
- [ ] 一键停增量、停同步、全量下线 runbook 验证可用。

---

## 明确不在本期

- `.cc` 登录、评论、收藏、搜索和动态筛选。
- 在 `.cc` 复制 `.com` D1。
- 自动翻译或重新抓取源站；只消费 `.com` 已完成内容。
- 把第三方 blog/podcast 全文或播客逐字稿发布到 `.cc`。
- 自动调用搜索引擎 URL removal API。
- 为每个来源做独立频道页；首期一个 `/ai-news/` 分页归档足够。
- 境内 CDN/OSS 迁移；当前腾讯云 VPS/Nginx 足以验证收录和流量。
