# Blog 内容质量 + daily 页 SEO 加长摘要 — 修复批次计划

- 日期：2026-07-06
- 分支：`fix/blog-content-daily-seo`（基于 origin/main 8122824）
- 执行约定：Fable 规划/审查/管理，Opus 4.8 subagent 编码测试修复
- 调查报告（必读）：
  - `/Users/roxor/.claude/jobs/ecfa2b03/tmp/jiqizhixin-p-tag-investigation.md`（问题 2）
  - `/Users/roxor/.claude/jobs/ecfa2b03/tmp/cover-logo-and-daily-summary-investigation.md`（问题 1 + 3）

## 用户报告的三个问题 + 一个衍生

1. **机器之心/量子位封面是品牌 logo**，不是正文高信息量图
2. **机器之心抽屉正文出现裸 `<p>` 标签**
3. **daily 静态页要展示更多文字**（加长摘要，供 SEO 抓取）——用户决策：一句话 + 一段 300-500 字扩展摘要
4. **（衍生）PH description 是英文**——用户决策：翻译成中文再展示

## 已定用户决策（2026-07-06）

| # | 决策点 | 结论 |
|---|--------|------|
| Q1 | daily 摘要展示量 | 一句话总结 + 一段 `<p>` 扩展摘要（每源最优字段，clamp 300-500 字，非全文） |
| Q2 | PH 英文 description | 翻译成中文（复用 DeepSeek 翻译管线 + 回填 + 后续自动翻） |

## Global Constraints

- 绝对 URL 走 env base；日报页零 `<script>`（JSON-LD 数据岛除外）；不写 secret
- 邮件/codex/daily-api 现有输出行为不得回归（render.ts 共享函数改动需隔离）
- DeepSeek 模型：翻译走 `deepseek-v4-flash`（CLAUDE.md 选型表）
- TDD；commit 中文 + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`；每任务完成即 commit
- 数据回填只经 admin endpoint（不直接写 SQL）；prod 操作单独授权，本计划只到 staging + PR

---

## Task 1：机器之心/微博 RSSHub 源 `<p>` 泄漏修复（问题 2）

**根因**：jiqizhixin/weibo-hot-tech 走 RSSHub，正文在 RSS description 里是**双重实体编码** HTML（`&amp;lt;p&amp;gt;`）。`parse.ts:132` 只剥 CDATA 不解码 → 喂给 `htmlToMarkdown()`（`extract.ts:508`）的 tag 正则按字面 `<...>` 匹配全空转 → 最后 `decodeEntities()`（`extract.ts:574`）把它们还原成字面 `<p>` 文本泄漏。铁证：145 条 body 含 raw `&lt;img`、0 条含 markdown `![`。

**Files**：`worker/src/feeds/parse.ts`（或 extract.ts 入口，实现者读代码定夺最干净的单点）+ 对应 test

**修法**：在 RSS 正文进入 `htmlToMarkdown` 之前检测「实体编码的 HTML」（body 不含裸 `<tag>` 但含 `&lt;tag&gt;` / `&amp;lt;`）→ 先解码一次再走转换管线。检测要稳（避免把正常含 `&lt;` 字面的文本误解码——用「含 `&lt;p&gt;`/`&lt;div`/`&lt;img` 等结构标签实体」作信号，而非任意 `&lt;`）。其他源（CDATA 包真 HTML）走原路径不变。

**测试**：
- 双重编码输入 `&amp;lt;p&amp;gt;正文&amp;lt;/p&amp;gt;&amp;lt;img src="x"&amp;gt;` → markdown 输出含正常段落 + `![](x)`，**不含**字面 `<p>` / `&lt;p&gt;`
- 正常 CDATA 真 HTML 源 → 输出与改动前逐字节一致（回归锁）
- 含字面 `&lt;` 但非 HTML 的正常文本 → 不被误解码

**数据回填**：新增（或扩展现有）admin mode `mode=blog-body-redecode&limit=N[&dry=1]`：扫 body_markdown 含结构标签实体的 blog item（预期 jiqizhixin 142 + weibo-hot-tech 110），重跑解码+转换写回 body_markdown/body_markdown_zh，游标单调，dry 零写。

**验收**：单测绿；staging 抽一条 jiqizhixin 重跑后 body 无 `<p>` 泄漏。

---

## Task 2：品牌 logo 封面护栏 + 存量清理（问题 1）

**根因**：jiqizhixin/qbitai 每篇 og:image 都是站点固定品牌 logo（qbitai 300×300、jiqizhixin 828×828）。PR #162/#163 的 og:image 采用把 logo 灌进 cover_image——154 篇 jiqizhixin 共用 hash `29014a03`、108 篇 qbitai 共用 `74b581f9`。判簇清洗本能抓到但它是一次性手动、且跑在 og 回填之前，logo 后灌进去漏了。**qbitai 正文有 hero（92/108 body.assets 非空），jiqizhixin 图荒（154/154 body.assets=0）**。

**Files**：`worker/src/workflows/blog-pipeline.ts`（og 采用点）、`worker/src/media-r2.ts`（generic-sweep + backfill）、`worker/src/feeds/extract.ts`（若 og 采用逻辑在此）+ test

**修法（两层）**：
1. **采用护栏（防未来）**：og:image 写入 cover_image 前，查「同 source 已有 ≥3 条 item 的 cover_image = 这张图（内容 hash 或原始 URL 归一后相等）」→ 判为源级品牌 logo，**不采用 og**，转而尝试正文 hero（走既有 body-hero 选择 + 质量门），无合格 hero → 留空（monogram）。COUNT 查询按 source 限定、走索引，blog 入库频次低成本可接受。实现者判断把这个查询放采用点还是抽成 helper。
2. **存量清理 + 差异回填**：扩展 `blog-cover-generic-sweep` 或新 admin mode，把已成簇的 logo（jiqizhixin `29014a03` ×154、qbitai `74b581f9` ×108）清空 cover_image 并记 `cover_generic_cleared_hash`（沿用 PR #163 Fix C 字段，防 og-backfill 再灌回）；随后对清空的 item：**qbitai 走正文 hero 回填**（body.assets 过质量门 + 黑名单，迁 R2），**jiqizhixin 图荒直接留 monogram**。可复用现有 og-backfill 框架但取图源从 og 改为 body hero（当 og == cleared_hash 时）。

**测试**：
- 采用护栏：同 source 4 条已用同一 hash 作 cover → 第 5 条 og == 该 hash 时不采用、转正文 hero；同 source 仅 2 条 → 仍采用（不误判）；不同 source 同图不合簇
- Verge 回归：og 是真 hero（非簇）→ 仍正常采用（不被误伤，锁 PR #163 行为）
- 差异回填：cover 被清 + og==cleared_hash + 有合格 body hero → 采用 body hero；无 body hero → 保持空

**数据面**：staging 先 `dry=1` 看 jiqizhixin/qbitai 簇明细，真跑清理 + 回填，抽查 qbitai 封面变正文 hero、jiqizhixin 变 monogram。

---

## Task 3：PH description 中文翻译（问题 4，Task 4 的前置）

**Files**：`worker/src/enrich.ts` 或 ph enrich 相关（读代码定位现有 PH enrich + 翻译管线）+ test

**修法**：PH item 的 `description`（英文，均值 317 字）新增翻译任务 → `description_zh`（DeepSeek flash，复用现有 `fill-translations` 或 ph-enrich 管线的翻译调用）。存量回填 admin mode（或并入现有翻译 mode）；后续新入库 PH 自动翻（挂现有 cron enrich）。翻译失败保留空，daily 页回退 ai_summary。

**测试**：mock 翻译调用，断言 PH description → description_zh 写入；已有 description_zh 不覆盖；空 description 跳过。

**验收**：staging 回填几条 PH，D1 SELECT 确认 description_zh 落中文。

---

## Task 4：daily 页加长摘要渲染（问题 3）

**Files**：`worker/src/digest/render.ts`（RenderedItem 暴露 intro 长字段）、`worker/src/digest/daily-page.ts`（渲染扩展摘要段）、`worker/src/digest/config.ts`（clamp 常量）+ test

**修法**：
1. `render.ts` renderItem 已产出 `intro`（现有字段，clamp 800），但 daily 页没渲染。确认每源 intro 取值最优字段（blog→`excerpt_zh`；podcast→`shownotes_zh`；hf_paper→`summary_zh`；gh→`ai_summary`；ph→`description_zh`(Task 3 产出，回退 ai_summary)；x→`content_translated`）。如现有 intro 映射不含某源或字段不对，调整（保持邮件/codex 不回归——intro 已在 codex payload 用，改动需隔离或确认兼容）。
2. `daily-page.ts` 每条 item 在一句话 summary 下追加一段 `<p class="summary-full">{intro，clamp 300-500}</p>`；intro 为空则不渲染该段（不出空 `<p>`）；HTML 转义外部文本。clamp 长度设为新常量 `DAILY_PAGE_INTRO_MAX = 500`（config.ts），按句截断（复用 clampSentences 风格）。
3. JSON-LD 的 description 也可用这段更长文本（SEO 增强，实现者判断）。

**测试**：
- 每源 intro 正确映射到扩展摘要段；PH 用 description_zh（有则用、无则 ai_summary）
- intro 空 → 无空 `<p>`；超长 → clamp 到 500 且按句截断
- 扩展摘要文本 HTML 转义；页面仍零可执行 script
- 邮件/codex/daily-api 隔离回归（render.ts intro 改动不改其输出）

**验收**：staging 重生成一页含 blog+podcast+ph 的日报，curl 断言每条有扩展摘要段、PH 段为中文、无空 `<p>`、字数在预期区间。

---

## 执行顺序与依赖

- Task 1、Task 2 独立（都在 feeds/blog 管线，但不同缺陷）；Task 3 是 Task 4 的 PH 字段前置
- 建议顺序：1 → 2 → 3 → 4（3 先于 4 使 daily 页 PH 有中文可用）
- 每任务：Opus implementer（TDD）→ review-package → Opus reviewer（规格+质量）→ 修 Critical/Important → 台账记录
- 全部完成 → 全分支终审 → staging 全链路（4 个数据回填先 dry 后真跑）→ 一个 PR → 用户 merge → prod 依序回填 + 复验四个原始 case

## 验收（PR 前 staging 必过）

1. jiqizhixin 抽屉正文无 `<p>` 泄漏（Task 1）
2. qbitai 封面 = 正文 hero、jiqizhixin 封面 = monogram（Task 2）
3. PH 若干条 description_zh 落中文（Task 3）
4. daily 页每条含 300-500 字中文扩展摘要、PH 段中文、无空 `<p>`、零 script（Task 4）
5. 全量单测绿；邮件/codex/daily-api 零回归
