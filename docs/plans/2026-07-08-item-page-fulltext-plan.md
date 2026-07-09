# /i/ 内容页升级为「分源混合全文」— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。步骤 `- [ ]` 勾选。
> **执行约定**：Fable 规划/审查/管理；编码测试由 Opus subagent 执行。锁契约+断言，实现体由执行者读「必读文件」编写。
> 前序：`/i/` SSR 页 feature 已上线（PR #171，item-page.ts 现渲染 title+summary_full+intro(clamp 800)）。本计划把它升级为分源混合全文。

**Goal:** 把 `/i/:source/:id` SSR 页从「标题+摘要」升级为「分源混合内容」——gh/hf/ph/x 放完整全文，blog/podcast 放我们的摘要+分析+短摘录（不整篇照译，避采集站/DMCA 风险）；并加 force 重渲染回填。

**Architecture:** worker 新增 markdown→HTML 转换 + 净化模块；item-page.ts 按源分支渲染正文；复用 render.ts 的媒体处理；backfill 加 force 覆盖旧薄页。

## 用户已定（2026-07-08）
| 决策 | 结论 |
|---|---|
| 内容深度 | **分源混合**：gh/hf/ph/x 全文；blog/podcast 摘要+分析+短摘录（非整篇照译）|

## 分源内容模型（本 feature 的核心规格）
| 源 | 正文内容 | 风险 | 全文? |
|---|---|---|---|
| **gh** | 我们的摘要/分析 + README 全文（`readme_translated` → md→html，图片 resolve 到 R2/raw，>40KB 截断 + 「GitHub 看完整 README」链）| 低（开源）| ✅ |
| **hf** | 我们的 `deep_analysis`（7 维原创）+ abstract/`summary_zh` | 低（原创为主）| ✅ |
| **ph** | `ai_summary` + `maker_post_text` + `top_comments`（结构化）| 低 | ✅ |
| **x** | `content_translated` + 完整推文串(thread) + `quote_of` | 低（公开短内容）| ✅ |
| **blog** | 我们的摘要 + 分析/要点 + **正文短摘录（首 ~600-800 字，非全文）** + 显著「阅读原文」链 | 中→管控 | ❌ 不整篇 |
| **podcast** | 我们的摘要 + chapters/timeline(时间戳) + shownotes 短摘录 | 中→管控 | ❌ 不逐字稿 |

全页统一：self-canonical `/i/...`；**显著「原文出处: <domain>」署名 + 原文链接**（blog/podcast 尤其）；「打开互动版」CTA → SPA 深链；零可执行 script；JSON-LD @graph（Article 的 articleBody 只放可索引的可放心部分）。

## Global Constraints
- 分支 feat/item-page-fulltext（从 origin/main）；部署前 rebase
- 绝对 URL 用 env.SITE_BASE；SSR 页零 `<script>`（JSON-LD 岛除外）；外部文本/HTML 一律**净化**（净化后仍零 script/on*/iframe/javascript:）
- markdown→HTML 的输入是译文/第三方内容，**必须净化输出**（allowlist 标签，剥危险）——这是安全底线
- 邮件/codex/daily-api/日报静态页 一律不回归（本 feature 只改 item-page.ts 正文 + 新增模块 + backfill force）
- 体积：gh README/大内容截断（~40KB 正文上限），页面目标 ≤300KB
- TDD；commit 中文 + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1：markdown→HTML 转换 + HTML 净化模块

**Files:**
- Modify: `worker/package.json`（加 markdown 库 dep；用 Workers 兼容的轻量库如 `marked`，实现者确认能进 worker bundle 且 wrangler dry-run 通过）
- Create: `worker/src/seo/markdown-html.ts`
- Create: `worker/src/seo/markdown-html.test.ts`

**必读**：worker/src/feeds/extract.ts（现有 htmlToMarkdown 反向，看 worker 里 HTML 处理惯例）、templates.ts escapeHtml

**Interfaces（Produces）:**
```ts
export function markdownToSafeHtml(md: string, opts?: { maxChars?: number }): { html: string; truncated: boolean };
//  md→HTML(marked)→净化(allowlist)。maxChars 截断(按段/字，不截坏标签)。
//  allowlist 标签: p h1-h6 ul ol li a img strong em b i code pre blockquote table thead tbody tr th td hr br
//  剥: script style iframe object embed on*= 属性; a[href] 仅 http(s)/相对; img[src] 仅 http(s)
```

**测试断言：**
- 正常 markdown（标题/列表/代码块/表格/图片/链接）→ 对应 HTML 标签
- **净化**：`<script>alert(1)</script>` / `<img onerror=x>` / `[x](javascript:alert(1))` / `<iframe>` → 输出无 script/onerror/javascript:/iframe
- maxChars 截断：超长按边界截断、`truncated=true`、不产生未闭合坏标签
- 空/非法输入 → 空 html 不崩
- Commit：`feat(seo): worker markdown→HTML + HTML 净化模块`

---

### Task 2：item-page.ts 分源混合正文渲染

**Files:**
- Modify: `worker/src/seo/item-page.ts`（正文段从「summary_full+intro」改为分源混合模型）
- Create/Modify: `worker/src/seo/item-body.ts`（分源正文渲染，若 item-page.ts 会变大则拆出）
- Modify/Create test: `worker/src/seo/item-page.test.ts` / `item-body.test.ts`

**必读**：item-page.ts 现结构、render.ts（renderItem/RenderedItem/buildMedia/resolveReadmeImages/各源字段读法）、调查报告 `/Users/roxor/.claude/jobs/ecfa2b03/tmp/item-fulltext-investigation.md`（各源全文字段名 + 前端渲染分支）、Task 1 markdownToSafeHtml

**Interfaces（Produces）:**
```ts
export function renderItemBody(source: DigestSource, row: RenderRow, env: Env): string;
//  按上「分源内容模型」表渲染正文 HTML(净化后)。各源读对应字段:
//   gh: ex.readme_translated(md→safeHtml,截断40KB,末尾原文链) 前置我们的摘要
//   hf: ex.deep_analysis + abstract/summary_zh
//   ph: ai_summary + maker_post_text + top_comments
//   x: content_translated + thread + quote_of
//   blog: 摘要+分析 + body 首600-800字摘录(clampSentences,非全文) + 阅读原文链
//   podcast: 摘要 + chapters/timeline + shownotes 摘录
```
item-page.ts 的 `renderItemPageHtml` 正文区改调 `renderItemBody(source,row,env)`；保留 h1/封面/元信息/CTA/相关内链/JSON-LD 框架。

**行为规格：**
- 全文源（gh/hf/ph/x）：完整渲染对应字段；gh README 用 markdownToSafeHtml 截断 40KB + 「在 GitHub 查看完整 README」链
- 半文源（blog/podcast）：**不放** body_markdown_zh / transcript 全文；只放我们的摘要+分析+短摘录（首 600-800 字按句 clamp）+ **显著原文出处链**
- 媒体：复用 render.ts buildMedia/resolveReadmeImages，图 `/r/` 反代或外链，`loading=lazy`
- JSON-LD Article 的 `articleBody`/description 用**可安全索引**的文本（半文源用我们的摘要+分析，不用照译全文）
- 所有源 body 净化后零 script；缺字段的源优雅降级（回退现有 summary_full）

**测试断言（fixture RenderRow 逐源）：**
- gh：body 含 README 渲染的 HTML（h2/code/img）+ 超 40KB 截断 + GitHub 原文链
- hf：body 含 deep_analysis
- x：含 thread + quote
- blog：body **不含** body_markdown_zh 全文（构造长 body fixture → 断言只出摘录长度 + 有「原文」链）；podcast 同理不含 transcript 全文
- 净化：任一源正文含 `<script>`/`onerror` fixture → 输出无
- 零可执行 script（剥 JSON-LD 岛后）；h1 唯一；canonical /i/ self；CTA 指 SPA 深链
- 隔离：不碰 daily-page/deliver/codex/daily-api（render.ts 若加字段读取需确认不改 renderItem 现有输出）
- Commit：`feat(seo): item 页分源混合全文正文`

---

### Task 3：backfill force 重渲染 + 存量薄页覆盖

**Files:**
- Modify: `worker/src/seo/item-page-run.ts`（generateItemPage/backfillItemPages 加 force）
- Modify: `worker/src/index.ts`（mode=item-page-backfill 加 `&force=1`）
- Test: item-page-run.test.ts

**必读**：item-page-run.ts（现游标=item_pages 存在性）、Task 2 renderItemBody

**行为规格：** `generateItemPage(env,id,{force})`：force=true 时即使 item_pages 已有行也重渲染覆盖 R2 + 更新 generated_at（用于内容升级/刷新）。`backfillItemPages(env,source,{force})`：force=true 时谓词去掉 `NOT EXISTS item_pages`（改为选全部 relevant 非 dedup，重渲染覆盖），remaining 相应计算。dedup 门(C1)、is_relevant 门保留。用途：把已生成的 gh 222 + ph 500 薄页升级成全文页。

**测试断言：**
- force=true：已有 item_pages 行的 item 仍重渲染（R2 覆盖、generated_at 更新）；force=false（默认）保持现状跳过
- backfill force 谓词选全部 relevant 非 dedup（含已生成的）；非 force 仍只选未生成
- Commit：`feat(seo): item 页回填 force 重渲染(升级存量薄页)`

---

### Task 4：staging + PR

- rebase 检查；migration 无（表已在）；deploy staging
- 分源回填全文页：gh/hf/ph/x 各跑一小批（含 force 覆盖 gh 已有），blog/podcast 跑一批 → curl staging-api `/i/<source>/<id>` 抽验：
  - gh：README 全文 HTML 渲染 + 截断链
  - blog：只摘录非全文 + 原文出处链
  - 各源零 script、净化生效（找一条正文曾含 HTML 的验净化）、h1/canonical/@graph
- `npm test` 全绿
- PR --base main，body 含分源内容模型表、markdown→HTML+净化说明、staging 证据、**merge 后 runbook**（部署 → **force 重灌全部五源覆盖薄页**：gh/ph 已有薄页用 force 升级，hf/x/news 全量；直连 workers.dev 绕香港 60s；news 前确认 C1）、结尾 🤖 Generated with [Claude Code](https://claude.com/claude-code)
- 暂停等用户 review/merge

## Self-Review
- 覆盖：markdown→HTML(T1)、分源正文(T2)、force 重灌(T3)、上线(T4)；分源内容模型表逐源→T2 断言
- 安全底线：净化在 T1 锁 + T2 逐源验，零 script 不变量贯穿
- 存量薄页(gh222/ph500)升级：T3 force + T4 runbook force 重灌
