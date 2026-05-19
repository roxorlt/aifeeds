# HuggingFace Daily Papers — Backend 给 FE 的对齐回复

设计稿:`docs/plans/2026-05-18-hf-daily-papers-source-design.md`(§6 是 UI 决策表)
SOP:`docs/source-integration-sop.md`(§3 Phase 8 新增 跑批通知)

---

## 真实数据 sample 在哪

全部落到 `docs/plans/_research/2026-05-18-hf-daily-papers-sample/`(checked-in,worktree pull 即可看):

| 文件 | 说明 | 大小 |
|------|------|------|
| `daily_papers.json` | 50 条今日 listing(`GET /api/daily_papers` 原 response) | 280 KB |
| `paper_detail_2605.13301.json` | 高 upvote(140)+ 有 GH(70 stars) | 4.5 KB |
| `paper_detail_2605.15141.json` | 高 upvote(84)+ projectPage 在 GH 但无 githubRepo 字段 | 3.6 KB |
| `paper_detail_2605.06554.json` | 中 upvote(21)+ 有 GH(25 stars) | 2.9 KB |
| `paper_detail_2605.14386.json` | 中 upvote(50)+ 仅 projectPage 无 GH | 3.2 KB |
| `paper_detail_2605.15320.json` | 低 upvote(1)+ 无 GH 无 projectPage(冷启动 case) | 3.1 KB |
| `ar5iv_2605.13301.html` | 1 篇全文样本(50 KB,FE 暂时不用,Phase 2 才显示) | 50 KB |

5 条 paper_detail 覆盖了 upvote 分布(high / mid / low)+ GH 关联存在性(有 / 无 / projectPage 在 GH 不在 githubRepo)— 应该够画 mockup。

---

## 关于你 5 个疑问的明确答案

### Q1:8 vs 9 维度?

**实际 9 个 key,但 `novelty_rating` 是 meta 评分**(横切其他 8 维度),UI 上**不算"维度"**。

- drawer 标题写 **"论文 8 维度拆解"**,依次显示:`tldr / problem / key_insight / method / experiments / industry_impact / code_status / limitations`
- `novelty_rating` 单独显示为 **★ 5 星条**(drawer header 右上角 + feed 卡片右下角),不出现在 8 维度列表里

PM 说"8 维度"是这个意思,你之前理解没错,只是因为 `novelty_rating` 不属于"维度"。

### Q2:novelty_rating 尺度?

**1-5 整数**(不是 1-10 也不是 三档)。

- `1` = 渐进改进 / 数据集 / 复现工作
- `3` = 稳健工作,某细分领域 SOTA
- `5` = 开创新方向(罕见,如首个 Transformer / DDPM 论文)

FE 用 `★★★★☆`(实心 4 + 空心 1)渲染 4 分。建议:

- 实心星用品牌色或 amber-500
- 空心星用 neutral-300

### Q3:experiments 数据结构?

**结构化 JSON,不是 markdown table 也不是 prose 段落**:

```typescript
{
  datasets: string[];                                                  // ≤5
  key_metrics: { name: string; value: string; vs_baseline: string }[]; // ≤5
  compute: string;                                                     // ≤20 字
}
```

LLM JSON Mode 输出,严格 schema。render 建议:

- `datasets` → 一行 chip(`bg-neutral-100 text-neutral-700 text-xs px-2 py-0.5 rounded-full`)
- `key_metrics` → 3 列简易 grid(`name` | `value` | `vs_baseline`)或 2 列 table
- `compute` → 单行 `text-xs text-neutral-500 font-mono`(monospace 显示算力数字)

可能为空数组(LLM 无把握时 prompt 允许返空),render 加空数组保护:

```tsx
{experiments.datasets.length > 0 && (
  <div className="flex gap-1.5 flex-wrap">{...}</div>
)}
```

### Q4:「拆解阅读」按钮目标?

**开 drawer,复用现有 DrawerProvider / itemUpdateBus**。不单开 `/papers/:id` 路由组件。

URL routing:`/h/:arxiv_id`(`h` 表 HF Paper,跟 `/g/:owner/:repo` / `/p/:id` 同 source-prefixed 模式)。

- 应用内点卡片 → `pushState('/h/:arxiv_id')` → drawer 开
- 关闭 → `back()` → 回 `/`
- 冷启动深链 → `replaceState('/')` + `pushState('/h/:arxiv_id')` seed 历史栈,后退键回首页不退出站

### Q5:HF avatar / thumbnail 域名 + 数字单位?

**5a. 域名**:

| 域名 | 用途 | 例 |
|------|------|----|
| `cdn-avatars.huggingface.co` | 用户头像(`submitter.avatarUrl`) | `https://cdn-avatars.huggingface.co/v1/.../...jpeg` |
| `cdn-thumbnails.huggingface.co` | paper thumbnail(`thumbnail`) | `https://cdn-thumbnails.huggingface.co/social-thumbnails/papers/2605.13301.png` |

**Backend 决定走 `/img` 反代,加 `PROXY_HOSTS` allowlist**(或更宽 `*.huggingface.co`)。FE 直接调:

```ts
const src = `/img?url=${encodeURIComponent(avatarUrl)}&w=128`;
```

获得自动 webp/avif + R2 缓存。比 og:image 的 `proxyImg(url, w, { force: true })` 模式统一,所有图片走同一管道。

> Backend 在 Phase 1 schema 阶段会把这两个域名加进 `worker/src/img.ts` `PROXY_HOSTS`,跟你的 mockup 上线节奏对齐。

**5b. 数字单位**:**`formatCompact`**(`1.2k` / `142k`)— 跟 GitHub 卡片一致。

HF 是西方平台,用户预期英文数字单位。`formatNumber`(`1.2 万`)是国内平台习惯,不用。

- `upvotes`:`formatCompact(140)` → `140`,`formatCompact(15200)` → `15.2k`
- `github_stars`:同上
- `num_comments`:同上

---

## 你 mockup 阶段不需要担心的字段(BE 全包,FE 渲染时已有数据)

- `title_zh` / `summary_zh` / `ai_summary_zh`:DeepSeek pro 跑完直接进 `extra` JSON
- `deep_analysis.*` 全部 9 个 key:同上,JSON Mode 严格 schema 保证
- thumbnail / avatar 的 R2 路径:BE 迁完后 `media[].url` 和 `extra.submitted_by.avatar_url` 都是 `/r/hf/<sha>` 格式,FE 直接 src 用
- `github_stars`:HF API 已经给好,BE 不用再调 GH API

---

## 你 mockup 阶段需要假数据填的字段(BE 后续填真)

- `deep_analysis` 全部内容:可以参考设计稿 §3.2 的样例 JSON 或自己编几个合理的(8 个维度 + ★ 4 评分)
- `title_zh` / `summary_zh`:可以自己手翻 sample 里的 paper.title / paper.summary 充数

---

## 卡片字段(feed)— BE 建议的最小集合

```
┌────────────────────────────────────────────┐
│ [thumbnail 1200×630 → 卡片 640×360]        │  必有,全 50 条都有
│                                            │
│ 论文标题中译(2 行 line-clamp)             │  title_zh
│ 一句话中译(ai_summary_zh,1 行)           │
│                                            │
│ #关键词1  #关键词2  #关键词3              │  ai_keywords 前 3 个 chip
│                                            │
│ ▲ 140  💬 13  ⭐ 70                        │  metrics(lucide-react SVG,不是 emoji)
│ 👤 by @taesiri · 2 天前       ★★★★☆       │  submitter + relative time + novelty
│ [拆解阅读]                                 │  CTA
└────────────────────────────────────────────┘
```

> ⚠️ metrics 行那几个图标用 SVG,**不要用 emoji**(SOP §5.F 强制规则)。
> ▲ = `lucide-react ArrowBigUp`,💬 = `MessageSquare`,⭐ = `Star`(实心)

## Drawer 区段(按"用户决策"路径)

1. **Hero**:thumbnail + 标题中译 + 副标题(ai_summary_zh) + ★ novelty + submitter avatar
2. **TL;DR**:`deep_analysis.tldr`(大字号黑底白字,强调)
3. **8 维度拆解**:problem / key_insight / method / experiments / industry_impact / code_status / limitations
4. **HF 元信息**:upvotes / num_comments / project_page 链接 / submitter / submittedOnDailyAt
5. **作者列表**:折叠区(20+ 作者只显前 5,展开看全)
6. **AI Keywords**:`ai_keywords` chip 行(HF 自己生成的全部关键词)
7. **全文翻译**:`(v1 必含,但 mockup 阶段可以先留空白占位 "全文翻译加载中...")` — Phase 2 BE 实现 ar5iv 抓取 + 段落级翻译
8. **原文 Abstract**:HF 英文 abstract + 一键复制 / 跳 arxiv.org
9. **外跳行**:`在 HF 打开 ↗` / `在 arXiv 打开 ↗` / `在 GitHub 打开 ↗`(若 hasGhRepo)

## 分享海报(chipColor `#ffd9a8` 暖橙)

跟 X 白 / GH mint / PH peach(#ffd1c1) / CH lavender 区分。PH 已是 peach 系,HF 用稍偏黄的暖橙避免撞色。

content 区字段(参考 SOP §5.G 只写 content 区):

- thumbnail 顶部(`renderMediaBlock`)
- 标题中译(64px primary,2 行 cap)
- TL;DR 中译(36px subtitle,3 行 cap)
- 一行 metrics:★ novelty + upvotes + stars
- 一行身份:`by @<submitter> · HF Daily`

---

## Backend 这边的进度同步

- ✅ Phase 0 设计稿完成(`docs/plans/2026-05-18-hf-daily-papers-source-design.md`)
- ✅ SOP 加 Phase 8 跑批通知章节
- ✅ 真实数据 sample 已落 `docs/plans/_research/2026-05-18-hf-daily-papers-sample/`
- ✅ OPS 三项 verify 全通(staging HF_READ secret / DeepSeek pro 可调 / PushDeer 推送)
- ⏳ 等你 mockup 三件套(ETA 1.5-2 天)+ PM 确认
- ⏳ Phase 1-8 待 PM sign-off 后启动(7 天)

## 其他你可能关心的

- **`is_relevant` 不需要 LLM judge**:HF Daily 已策展,Backend INSERT 时直接定 `is_relevant=1`,FE 不需要做"是否 AI 相关"的视觉差异
- **deep_analysis 失败的 paper**:`extra.deep_analysis_failed_at IS NOT NULL` 的会被 `/api/items` filter 排除(workflow_completed_at 不写),FE 不会看到半成品
- **`novelty_rating` 偏差风险**:跑 1 周后 BE 会人工校准 prompt 评分参考。UI 建议在星条旁边标 `(AI 评分)` 小字提示,降低用户对绝对值的期待
- **discussion(评论)**:v1 不展示(HF discussion API 未公开,试探 4 个路径全 404),Phase 2 / v2 通过 puppeteer 或 cookie scraping 实现。mockup 不画 comment 区段
