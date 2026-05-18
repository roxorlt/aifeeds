# HuggingFace Daily Papers 源接入设计

> 日期:2026-05-18
> 状态:Phase 0 设计稿,FE mockup 进行中(ETA 1.5-2 天)
> 对应 SOP:[docs/source-integration-sop.md](../source-integration-sop.md)
> Mockup:`docs/plans/_mockups/2026-05-18-hf-paper-*.html`(FE 出三件套)
> 真实数据 sample:[docs/plans/_research/2026-05-18-hf-daily-papers-sample/](_research/2026-05-18-hf-daily-papers-sample/)
> FE handoff:[docs/plans/2026-05-18-hf-daily-papers-frontend-handoff.md](2026-05-18-hf-daily-papers-frontend-handoff.md)

---

## 1. 决策矩阵(已 brainstorming 确认 + 2026-05-18 PM 4 项变更整合)

| 维度 | 决策 |
|------|------|
| 数据来源 | HF 官方 `GET /api/daily_papers`(返 50 条/天) + `GET /api/papers/{arxiv_id}` 详情 + `arxiv.org Atom API`(补 categories) + `ar5iv.labs.arxiv.org`(全文 + 论文首图) + HF web page 抓评论(puppeteer / internal API)|
| 鉴权 | `Authorization: Bearer <HF_READ>`,token 已配 prod env + staging(OPS 2026-05-18 verify) |
| 拉取频率 | 每天 1 次 cron(BJT 08:00 = UTC 00:00,HF Daily 出榜后)|
| Item 映射 | `id = hf:<arxiv_id>` / `source_id = <arxiv_id>` / `title = paper.title` / `content = paper.summary` / `author = paper.authors[0].name` |
| extra 字段 | submitter 信息 / project_page / github_repo / github_stars(HF 已抓)/ ai_keywords / **arxiv_categories(NEW #2)** / **discussion_comments(NEW #3)** / **8 维度 deep_analysis JSON(每段 200-500 字 NEW #4)** |
| 指标 | metrics_snapshots_hf_paper(可选):`upvotes / num_comments / github_stars` |
| Workflow step | step 0 refresh detail / step 1 fan-out(media R2 + GH star + ar5iv + **figure 提取 NEW #1** + **discussion 抓取 NEW #3**)/ step 2 ar5iv 段落翻译 + 评论翻译 / step 3 **C 方案 7 次独立 pro reasoning 调用(NEW #4)** + 1 次 flash translate / step 4 完整性 gate |
| 关联字段 | 无嵌套关系(不像 X 的 quote/reply),github_repo HF 直接给好 |
| 媒体字段 | **#1 论文首图(ar5iv 解析 + 质量 gate)→ media[0],HF thumbnail 降级到 media[1]** + submitter avatar 全量迁 R2 |
| LLM judge | **不需要**(HF Daily 已策展,默认 is_relevant=1)|
| LLM 模型 | **deepseek-v4-pro reasoning × 8 次/paper**(C 方案:7 次 deep_analysis + reserved 1 次,质量最佳);ar5iv 段落级翻译 + 评论翻译 + title/summary 翻译 走 flash |
| 翻译 | title / summary / ai_summary 翻;ar5iv 全文段落级翻;**评论翻译(NEW #3)**:flash 跟 abstract 同批 |
| 完整性 gate | translate + 7 段 deep_analysis 都成 → 写 `workflow_completed_at` |
| Card 布局 | 论文首图(`media[0]`)顶置 + 标题中译 + 关键词 chips + metrics + ★ novelty |
| Drawer 内容 | TL;DR + 8 维度拆解(每段 200-500 字)+ 元信息 + 作者 + AI 关键词 + **评论(原文 + 译文)** + 全文翻译 + 原文 + 外跳 |
| 排序 | `paper.upvotes` desc(HF 自己的热度排序)|
| 筛选 | **#2 列头 dropdown 按 `extra.arxiv_categories[0]` (primary) 服务端 filter**(`GET /api/items?source_type=hf_paper&category=cs.LG`) |
| 通知 | Phase 8 标准模式,1 次/天 cron summary 推 PushDeer |
| 月度 LLM 成本 | C 方案 ¥15-50/月(deep_analysis 7 次 pro reasoning + 评论/翻译 flash)。OPS budget alert 阈值建议 **从 ¥10 → ¥60**,Phase 4 第一轮 10 条采样精准校准 |

---

## 2. 数据源 API

### 2.1 Daily Papers Listing

```
GET https://huggingface.co/api/daily_papers
Headers: Authorization: Bearer ${HF_READ}
```

返 50 条数组,每条结构(verify @ 2026-05-18):

```jsonc
{
  "paper": {
    "id": "2605.13301",                                // arxiv ID
    "authors": [{ "_id": "...", "name": "Yafu Li", "hidden": false }, ...],
    "publishedAt": "2026-05-14T00:00:00.000Z",
    "submittedOnDailyAt": "2026-05-18T00:00:00.000Z",
    "title": "...",
    "submittedOnDailyBy": {                            // 提交到 HF Daily 的人(非论文作者)
      "_id": "...",
      "avatarUrl": "https://cdn-avatars.huggingface.co/v1/.../...jpeg",
      "isPro": true,
      "user": "taesiri",
      "fullname": "taesiri",
      "type": "user",
      "name": "taesiri"
    },
    "summary": "...",                                  // 英文 abstract
    "upvotes": 140,
    "discussionId": "6a05351fb1a8cbabc9f0874b",        // HF 内部 ID(API 暂不可读,Phase 2)
    "projectPage": "https://simplified-reasoning.github.io/SU-01",  // 可 null
    "ai_summary": "...",                               // HF 自己生成的一句话英文摘要
    "ai_keywords": ["...", "..."]                      // HF 自己生成的关键词数组
  },
  "publishedAt": "2026-05-14T00:00:00.000Z",
  "title": "...",
  "summary": "...",
  "thumbnail": "https://cdn-thumbnails.huggingface.co/social-thumbnails/papers/2605.13301.png",
  "numComments": 13,
  "submittedBy": { /* 同 paper.submittedOnDailyBy */ },
  "isAuthorParticipating": false
}
```

**填充率验证**(50 条 sample):

- `thumbnail`: 50/50 ✅(全有)
- `discussionId`: 50/50 ✅
- `ai_summary` + `ai_keywords`: 50/50 ✅(HF 已策展全有)
- `projectPage`: 26/50(约一半)
- `upvotes` 分布:max=140 / median=6 / min=0

### 2.2 Paper Detail

```
GET https://huggingface.co/api/papers/{arxiv_id}
Headers: Authorization: Bearer ${HF_READ}
```

比 listing 多了:

- `githubRepo`(如 `"thu-ml/Causal-Forcing"`)
- `githubRepoAddedBy`(谁加的 GH 链接)
- `githubStars`(HF 自己抓的 star 数)

**重大利好**:HF 已经把 paper → GH repo 对应关系 + star 数都抓好了,我们不需要自己去 GH API 抓。

### 2.3 ar5iv 全文(v1 必含)

```
GET https://ar5iv.labs.arxiv.org/html/{arxiv_id}
```

HTTP 200 + HTML(50KB 量级,verify with 2605.13301)。新论文 HF Daily 上榜当天通常 ar5iv 已 mirror,失败率低。

Workflow step 解析:`<div class="ltx_abstract">` / `<section class="ltx_section">` / `<table class="ltx_tabular">` 等。段落级翻译用 flash 批量。

### 2.4 Discussion(留 Phase 2 / v2)

试探过的路径全 404:

```
/api/papers/{id}/discussions          → 404
/api/papers/{id}/discussion           → 404
/api/papers/{id}/discussions/{discId} → 404
/api/discussions/{discId}             → 404
```

HF discussion API 未公开。Web URL `/papers/{id}/discussions/1` 返 401(需要登录)。

**v1 决定不展示 discussion**,Phase 2 再考虑 puppeteer 或 cookie scraping。

---

## 3. Schema 增量

### 3.1 `items` 表(共通字段映射)

| 列 | HF 值 |
|----|------|
| `id` | `hf:<arxiv_id>` 复合(如 `hf:2605.13301`) |
| `source_type` | `'hf_paper'` |
| `source_id` | `<arxiv_id>`(如 `2605.13301`) |
| `title` | `paper.title` |
| `content` | `paper.summary`(英文 abstract) |
| `author` | `paper.authors[0].name`(第一作者) |
| `handle` | `paper.submittedOnDailyBy.user`(HF 提交人,不是论文作者) |
| `created_at` | `paper.publishedAt`(arXiv 发表日,毫秒 unix) |
| `metrics` | JSON: `{upvotes, num_comments, github_stars}` |
| `media` | JSON: `[{type: 'image', url: '/r/hf/<sha>'}]`(R2 迁移后) |
| `lang` | `'en'`(论文默认英文) |
| `is_relevant` | `1`(HF Daily 已策展,默认全相关,无 LLM judge) |
| `translated` | 0/1 |
| `extra` | JSON 详见 §3.2 |

### 3.2 `items.extra`(HF 专用字段)

```jsonc
{
  // 来自 HF API 的原始字段(Phase 1 INSERT 时填)
  "submitted_on_daily_at": "2026-05-18T00:00:00.000Z",
  "submitted_by": {
    "user": "taesiri",
    "fullname": "taesiri",
    "avatar_url": "/r/hf/<sha>",       // R2 迁移后路径,原 URL 见 raw_avatar_url
    "raw_avatar_url": "https://cdn-avatars.huggingface.co/v1/.../...jpeg",
    "is_pro": true
  },
  "discussion_id": "6a05351fb1a8cbabc9f0874b",
  "project_page": "https://simplified-reasoning.github.io/SU-01",  // 可 null
  "github_repo": "thu-ml/Causal-Forcing",                          // HF 抓的,可 null
  "github_stars": 70,                                               // HF 抓的,可 null
  "github_repo_added_by": "...",                                    // 可 null
  "ai_summary_en": "...",            // HF 生成的一句话英文摘要(从 paper.ai_summary)
  "ai_keywords": ["..."],            // HF 自己生成的关键词
  "arxiv_categories": ["cs.LG", "cs.CL"],   // NEW #2:arxiv.org Atom API 抓,primary 在 [0]
  "is_author_participating": false,

  // NEW #3:HF 评论(Phase 2/3 puppeteer 或 internal API 抓)
  "discussion_comments": [
    {
      "id": "...",                            // HF 内部 comment ID
      "author_name": "Jane Doe",
      "author_handle": "janedoe",
      "author_avatar_url": "/r/hf/<sha>",     // R2 迁移
      "content": "Great work, but...",        // 英文原文
      "content_zh": "好工作,但是...",          // flash 翻译
      "posted_at": "2026-05-18T03:20:00.000Z",
      "likes": 5,
      "is_author_reply": false                // paper 作者回复 flag
    }
    // 最多前 10 条 top-rated 评论(参考 PH top_comments 模式)
  ],
  "discussion_fetched_at": "2026-05-18T05:25:00.000Z",
  "discussion_fetch_method": "internal_api",  // internal_api | puppeteer (Phase 0.5 reconnaissance 决定)

  // BE workflow 跑完后填的字段
  "title_zh": "...",                 // title 中译
  "summary_zh": "...",               // abstract 中译,80-200 字
  "ai_summary_zh": "...",            // HF ai_summary 中译,30 字内

  // 8 维度拆解(deep_analysis_v1 schema)
  "deep_analysis": {
    "version": "v1",
    "tldr": "1 句核心,30 字内",
    "problem": "解决什么问题 + 现有方法局限,50 字",
    "key_insight": ["创新点 1", "创新点 2"],           // 1-3 条
    "method": "方法概述,80 字,避免数学公式",
    "experiments": {
      "datasets": ["NeRSemble"],
      "key_metrics": [{ "name": "PSNR", "value": "+5.5", "vs_baseline": "↑ vs LAM" }],
      "compute": "单 A100, 2 秒推理"
    },
    "novelty_rating": 4,                              // 1-5 整数
    "industry_impact": "对工业界影响,50 字内",
    "code_status": {
      "github_url": "https://github.com/thu-ml/Causal-Forcing",
      "star_count": 70,
      "license": "MIT",
      "reproducibility": "medium"                     // easy | medium | hard
    },
    "limitations": ["局限 1", "局限 2"]                // 1-3 条
  },
  "deep_analysis_at": "2026-05-18T05:30:00.000Z",
  "deep_analysis_model": "deepseek-v4-pro",
  "deep_analysis_failed_at": null,                    // 失败时填,/api/items filter 排除

  // 全文翻译(v1 必含)
  "ar5iv_fetched_at": "2026-05-18T05:25:00.000Z",
  "ar5iv_translated_at": "2026-05-18T05:32:00.000Z",
  "ar5iv_paragraphs_count": 42,                       // 段落数(不存 paragraph 全文在 extra,太大;另存表 hf_paper_ar5iv 或 R2 JSON)

  // NEW #1:论文首图(ar5iv 解析,fallback HF thumbnail)
  // 实际 media[0] 已直接指向论文首图(R2 迁移后),这里记元信息
  "figure_image": {
    "source": "ar5iv",                   // ar5iv | hf_thumbnail | none
    "raw_url": "https://ar5iv.labs.arxiv.org/html/2605.13301/x1.png",
    "r2_url": "/r/hf/<sha>",
    "width": 800,
    "height": 600,
    "extracted_at": "2026-05-18T05:25:00.000Z"
  },

  // workflow gate(跟其他源一致)
  "workflow_triggered_at": 1747526400,
  "workflow_completed_at": "2026-05-18T05:35:00.000Z",
  "r2_migrated_at": "2026-05-18T05:30:00.000Z"
}
```

**注意**:ar5iv 全文段落(可能上千段)**不放 `extra` JSON**(D1 行有大小上限),另开存储:

- 选项 A:新表 `hf_paper_ar5iv(item_id, segment_id, en, zh)` 1 万级段落 OK
- 选项 B:R2 存 `hf-paper-ar5iv/<arxiv_id>.json`,/r/ 反代读

倾向 **选项 B**(只读 + 大体积 + 不需要查询),实现最轻。Phase 3 实施时再敲定。

### 3.3 deep_analysis JSON schema(8 维度 + 1 评分 / v2 改 200-500 字深度长文)

> ⚠️ **9 个 key,但 `novelty_rating` 是 meta 评分**(横切其他 8 维度),UI 上**不算"维度"**。drawer 标题写"论文 8 维度拆解",`novelty_rating` 作为 ★ 5 星条单独显示(详见 §6.1)。
>
> **2026-05-18 PM #4 变更**:每段从 50-150 字 → **200-500 字深度长文**,采用 C 方案 7 次独立 pro reasoning 调用(详见 §5.1)。

| key | 类型 | 长度限制 | 说明 |
|-----|------|---------|------|
| version | string | - | `"v1"` 固定,未来加 v2 时变 |
| tldr | string | **30-80 字**(突破"1 句"限制,允许 2 句) | 核心一句/两句话,作为 drawer 顶部 callout |
| problem | string | **200-500 字** | 问题背景 + 现有方法局限 + 为什么这个问题难 |
| key_insight | string[] | 1-3 条,**每条 80-200 字** | 核心创新点 bullet,每条独立段落 |
| method | string | **200-500 字** | 方法详解,可含技术术语 + 流程描述,避免数学公式 |
| experiments.datasets | string[] | ≤5 | 数据集名 |
| experiments.key_metrics | object[] | ≤5 | 每个 `{name, value, vs_baseline}` 都是 string |
| experiments.compute | string | 20 字 | 训练算力 |
| experiments.narrative | string | **200-500 字** | 实验设计叙述 + 关键发现 + 跟基线对比的深度解读 |
| novelty_rating | integer | 1-5 | 5=突破性,1=渐进改进 |
| industry_impact | string | **200-500 字** | 工业界落地场景 + 商业价值 + 跟现有产品/工作流的接口 |
| code_status.github_url | string\|null | - | 复用 `extra.github_repo` 加前缀 |
| code_status.star_count | integer\|null | - | 复用 `extra.github_stars` |
| code_status.license | string\|null | - | `MIT` / `Apache-2.0` / `unknown` 等 |
| code_status.reproducibility | enum | - | `easy` / `medium` / `hard` |
| code_status.narrative | string | **100-300 字** | 复现难度评估理由 + 数据/算力门槛 + 训练 vs 推理代价 |
| limitations | string[] | 1-3 条,**每条 100-200 字** | 论文承认或可推断的局限,每条独立段落 |

**FE 端准备**(已在 PR #83):

- 已预留 `leading-[1.7]` + `whitespace-pre-wrap`,200-500 字直接装得下
- drawer 8 段每段独立 card,长内容不会破布局
- 砍掉"AI 生成"解释文案(FE 视觉反馈已应用)

### 3.4 `metrics_snapshots_hf_paper`(可选,v1 建议加)

```sql
CREATE TABLE IF NOT EXISTS metrics_snapshots_hf_paper (
  item_id      TEXT NOT NULL,
  captured_at  INTEGER NOT NULL,     -- ms since epoch
  upvotes      INTEGER,
  num_comments INTEGER,
  github_stars INTEGER,
  PRIMARY KEY (item_id, captured_at),
  FOREIGN KEY (item_id) REFERENCES items(id)
);
CREATE INDEX IF NOT EXISTS idx_ms_hf_item_time ON metrics_snapshots_hf_paper(item_id, captured_at);
```

每天 fetch 时 append 一行,30 天 retention。drawer 里"7 天 upvote 变化"未来可视化(默认隐藏,数据点 ≥ 7 + variance > 5% 才出)。

### 3.5 telemetry event(无新增)

复用现有:`item_open_drawer / item_close_drawer / external_link_click / share_click / feed_load_error / api_error / item_impression`。

---

## 4. Workflow 设计

`worker/src/workflows/hf-paper-pipeline.ts`(参考 SOP §1.4 模板)

> **2026-05-18 PM 4 项变更整合**:
> - step 0 加 `fetch-arxiv-categories`(#2,arxiv.org Atom API 补 categories)
> - step 1 fan-out 加 `fetch-discussion`(#3,puppeteer 或 internal API)
> - `fetch-ar5iv` 完成后内嵌 `extract-first-figure`(#1,论文首图解析 + R2 迁移)
> - step 2 加 `translate-discussion-comments`(#3,flash 跟 ar5iv 同批)
> - step 3 重构为 **C 方案 7 次独立 pro reasoning 调用 fan-out + 1 次 flash translate**(#4)

```typescript
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const RETRY = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

const RETRY_PRO_LONG = {
  retries: { limit: 2, delay: '15 seconds', backoff: 'exponential' },
  timeout: '10 minutes',                    // pro reasoning 长输出可能 > 5min
} as const;

type HfPaperParams = {
  itemId: string;          // 'hf:2605.13301'
  arxivId: string;         // '2605.13301'
  hasGhRepo: boolean;
  hasProjectPage: boolean;
  hasDiscussionId: boolean;                 // NEW #3
  lang: 'zh' | 'en';       // 翻译目标语言,默认 'zh'
};

export class HfPaperPipelineWorkflow extends WorkflowEntrypoint<Env, HfPaperParams> {
  async run(event: WorkflowEvent<HfPaperParams>, step: WorkflowStep) {
    const { itemId, arxivId, hasGhRepo, hasDiscussionId, lang } = event.payload;

    // Step 0:数据补全 + arxiv categories(NEW #2)
    await step.do('refresh-paper-detail', RETRY, () =>
      refreshPaperDetailForHf(this.env, itemId, arxivId),
    );
    await step.do('fetch-arxiv-categories', RETRY, () =>
      fetchArxivCategoriesForHf(this.env, itemId, arxivId),  // NEW #2
    );

    // Step 1:fan-out 并行(4 项,新增 figure 提取 + discussion 抓取)
    const [, , ar5ivResult, discussionResult] = await Promise.all([
      // 媒体迁移(HF social-thumbnail + submitter avatar 无条件迁 R2 当兜底)
      step.do('backfill-media-r2', RETRY, () =>
        backfillMediaForHfPaper(this.env, itemId, arxivId),
      ),
      // GH star refresh(若 hasGhRepo)
      hasGhRepo
        ? step.do('refresh-gh-star', RETRY, () =>
            refreshGhStarForHfPaper(this.env, itemId),
          )
        : Promise.resolve(null),
      // ar5iv 全文抓取 + 内嵌 figure 提取(NEW #1)
      // 一个 step 内做两件事(fetch ar5iv → parse img → 质量 gate → 迁 R2 → 写 media[0])
      // 单步原因:figure 提取依赖 ar5iv HTML,合并 step 避免传 50KB HTML 跨 step
      step.do('fetch-ar5iv-with-figure', RETRY, () =>
        fetchAr5ivAndExtractFigureForHf(this.env, itemId, arxivId),  // NEW #1
      ),
      // 评论抓取(NEW #3,Phase 0.5 reconnaissance 决定走 internal API 还是 puppeteer)
      hasDiscussionId
        ? step.do('fetch-discussion', RETRY, () =>
            fetchDiscussionForHfPaper(this.env, itemId, arxivId),  // NEW #3
          )
        : Promise.resolve(null),
    ]);

    // Step 2:ar5iv 全文 + 评论翻译(flash,跟 abstract 同批)
    const translatePromises: Promise<unknown>[] = [];
    if (ar5ivResult?.fetched) {
      translatePromises.push(
        step.do('translate-ar5iv', RETRY, () =>
          translateAr5ivForHfPaper(this.env, itemId, { lang }),
        ),
      );
    }
    if (discussionResult?.fetched && discussionResult.comments_count > 0) {
      translatePromises.push(
        step.do('translate-discussion-comments', RETRY, () =>
          translateDiscussionCommentsForHfPaper(this.env, itemId, { lang }),  // NEW #3
        ),
      );
    }
    if (translatePromises.length > 0) await Promise.all(translatePromises);

    // Step 3:C 方案 — 7 次独立 pro reasoning fan-out + 1 次 flash translate
    // 每段独立 reasoning chain 保最佳质量,fan-out 并行 wall-clock = max(每段耗时)
    // 1 次 flash 出 title_zh / summary_zh / ai_summary_zh,跟 7 次 pro 并行
    const [
      tldrResult,
      problemResult,
      keyInsightResult,
      methodResult,
      experimentsResult,
      industryImpactResult,
      codeStatusResult,
      limitationsAndNoveltyResult,
      titleSummaryResult,
    ] = await Promise.all([
      step.do('analyze-tldr', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, 'tldr', { lang }),
      ),
      step.do('analyze-problem', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, 'problem', { lang }),
      ),
      step.do('analyze-key-insight', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, 'key_insight', { lang }),
      ),
      step.do('analyze-method', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, 'method', { lang }),
      ),
      step.do('analyze-experiments', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, 'experiments', { lang }),
      ),
      step.do('analyze-industry-impact', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, 'industry_impact', { lang }),
      ),
      step.do('analyze-code-status', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, 'code_status', { lang }),
      ),
      // 第 7 段合并 limitations + novelty_rating(两者都需要全局判断论文价值,合一次)
      step.do('analyze-limitations-novelty', RETRY_PRO_LONG, () =>
        analyzeDimensionForHfPaper(this.env, itemId, 'limitations_and_novelty', { lang }),
      ),
      // 独立 1 次 flash 出 title / summary / ai_summary 译文(并行,不阻塞 pro)
      step.do('translate-title-summary', RETRY, () =>
        translateTitleSummaryForHfPaper(this.env, itemId, { lang }),
      ),
    ]);

    // 合并 8 段 deep_analysis 写入 extra.deep_analysis
    const allDimensions = [tldrResult, problemResult, keyInsightResult, methodResult,
      experimentsResult, industryImpactResult, codeStatusResult, limitationsAndNoveltyResult];
    const anyFailed = allDimensions.some((r) => r?.failed) || titleSummaryResult?.failed;
    await step.do('merge-deep-analysis', RETRY, () =>
      mergeDeepAnalysisForHfPaper(this.env, itemId, allDimensions),
    );

    // Step 4:完整性 gate(所有 8 段 + title/summary 翻译都成才算完整)
    if (!anyFailed) {
      const nowIso = new Date().toISOString();
      await step.do('mark-completed', RETRY, async () => {
        await this.env.DB.prepare(
          `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.workflow_completed_at', ?)
            WHERE id = ?`,
        ).bind(nowIso, itemId).run();
      });
    }

    return { itemId, completed: !anyFailed };
  }
}
```

### 4.1 hasXxxRef 信号

| signal | 检查 | 触发的 step |
|--------|------|------------|
| `hasGhRepo` | `!!extra.github_repo` | step 1 `refresh-gh-star` |
| `hasProjectPage` | `!!extra.project_page` | 暂无(留 future:抓 project page 截图迁 R2)|
| `hasDiscussionId` | `!!extra.discussion_id` | step 1 `fetch-discussion`(NEW #3,HF API 返了 100% 有 discussionId,实际是恒 true,留信号位防 edge case) |

### 4.2 instance ID(带 hour-bucket,SOP §1.5)

```typescript
const hourBucket = new Date().toISOString().slice(0, 13).replace('T', '-'); // "2026-05-18-08"
const instanceId = `hf-paper-${arxivId.replace(/\./g, '-')}-${hourBucket}`;
// 例:hf-paper-2605-13301-2026-05-18-08
```

### 4.3 step 失败处理 & 完整性 gate

- 每段 dimension 失败(JSON 校验失败 / pro timeout / reasoning crash)→ retry 2 次 + 标 `extra.deep_analysis.<dim>_failed_at`,该段在 drawer 显示 "本段解读暂未生成"
- 任一段 failed → `workflow_completed_at` 不写,`/api/items` filter 排除整 paper
- backfill cron 30min 内重 trigger 再跑(新 hour-bucket instance ID)
- 超过 3 轮 backfill 仍失败 → `pushDeerAlert` 告警(走 alert channel 不走 summary channel)

---

## 5. LLM Prompt 设计

> **2026-05-18 PM #4 变更**:从 A 方案"合并 1 次 pro 调用"升级到 **C 方案 — 7 次独立 pro reasoning 调用**(每段独立 reasoning chain,质量最佳)。8 段输出 = 7 次独立调用(`limitations + novelty_rating` 合一次,共需全局判断)。

### 5.1 C 方案:7 次独立 pro reasoning 调用

模型:**deepseek-v4-pro reasoning**(`response_format: {type: 'json_object'}`)
调用模式:workflow step 3 fan-out 并行(参考 §4 代码),wall-clock = max(单段耗时)≈ 30-60s
失败处理:retry 2 次,仍失败该段标 `extra.deep_analysis.<dim>_failed_at`,UI 显示 "本段解读暂未生成"

#### 5.1.A 共享 base prompt(每次调用都带)

```
你是 AI 论文解读专家,服务中国 AI 从业者。

【输入】
- title: <paper.title>
- summary: <paper.summary>(英文 abstract)
- ai_summary_en: <paper.ai_summary>(HF 已生成的一句话英文摘要)
- ai_keywords: <paper.ai_keywords>(HF 已生成的关键词,术语词典)
- arxiv_categories: <extra.arxiv_categories>(NEW #2,如 ["cs.LG", "cs.CL"])
- github_url: <extra.github_repo 完整 URL 或 null>
- github_stars: <extra.github_stars 或 null>
- project_page: <extra.project_page 或 null>
- ar5iv_excerpt: <ar5iv 前 3000 字段落,提供方法+实验细节,非 null 时附上>

【翻译规则】
- 专有名词(模型 / 数据集 / 方法名)保留英文,例:Transformer / NeRSemble / FLAME / LoRA
- 中英混合句中,英文术语前后留空格,例:"使用 LoRA 微调"
- 代码 / 公式原文保留
- 风格:正式但易懂,避免 "重磅" / "突破" / "震撼" / "最强" 等营销腔
- 中国从业者视角:每段必须有"对实际工程的启示"或"跟同类工作的差异"
- 严禁堆砌动词形容词凑字数;200-500 字必须有信息密度

【target_lang】当 target_lang ≠ 'zh' 时,输出按 <lang> 写。v1 默认 'zh',i18n 留口子。
```

#### 5.1.B 7 段独立调用(每段在 base prompt 后加 dimension-specific 指令)

| Step | dimension | 输出字段 | 长度 | dimension-specific 指令 |
|------|-----------|---------|------|----------------------|
| 1 | `tldr` | `{tldr: string}` | 30-80 字 | 一句/两句话核心,作为 drawer 顶部 callout,要"读完这一句就懂这论文做什么 + 为什么牛";避免抽象套话 |
| 2 | `problem` | `{problem: string}` | 200-500 字 | 问题背景(50 字)+ 现有方法局限(150 字)+ 为什么这个问题难/重要(150 字)+ 给中国从业者 1 句行业类比(50 字) |
| 3 | `key_insight` | `{key_insight: string[]}` | 1-3 条,每条 80-200 字 | 核心创新点 bullet,每条独立段落:**先一句话定义这个 insight,再用一段话解释为什么这个角度独特** |
| 4 | `method` | `{method: string}` | 200-500 字 | 方法详解:**ar5iv_excerpt 一定要读**;按"输入 → 关键模块 → 输出"线索叙述;允许技术术语但避免数学公式(用文字描述);末尾 1 句"跟同类方法的差异点" |
| 5 | `experiments` | `{experiments: {datasets, key_metrics, compute, narrative}}` | structured + narrative 200-500 字 | 结构化部分按 schema 填(datasets/key_metrics/compute);**narrative**:实验设计叙述(150 字)+ 关键发现(200 字)+ 跟基线对比的深度解读(150 字)。**严禁捏造数字**,没把握的 metric 返空数组 |
| 6 | `industry_impact` | `{industry_impact: string}` | 200-500 字 | 工业界落地场景(150 字)+ 商业价值(150 字)+ 跟现有产品/工作流的接口(150 字)。**给中国从业者**:1-2 个具体国内行业 use case |
| 7 | `code_status` | `{code_status: {github_url, star_count, license, reproducibility, narrative}}` | structured + narrative 100-300 字 | 结构化部分从输入复用;**narrative**:复现难度理由(100 字)+ 数据/算力门槛(100 字)+ 训练 vs 推理代价(100 字)。`reproducibility` 按"easy(单 GPU + 公开数据)/ medium(多 GPU + 部分私有数据)/ hard(大集群 + 私有数据)" |
| 8 | `limitations_and_novelty` | `{limitations: string[], novelty_rating: integer}` | limitations 1-3 条每条 100-200 字,novelty 1-5 整数 | **合并一次因为两者都需要全局判断**:先输出 limitations(论文承认 + 可推断 + 跟同类工作对比的弱点),再用 limitations 的视角给 novelty_rating。**严格 1-5 整数**(不能 4.5),参考下表 |

#### 5.1.C novelty_rating 评分参考

- **5**:开创新方向(罕见,如首个 Transformer / DDPM / RLHF 论文)
- **4**:重要改进,业内必看(如 LoRA / FlashAttention / Mistral)
- **3**:稳健工作,某细分领域 SOTA
- **2**:渐进改进,补充已有方法
- **1**:数据集 / 综述 / 复现工作

#### 5.1.D 单段 JSON schema 例(以 `method` 为例)

每段调用都用 `response_format: {type: 'json_object'}`,严格 schema:

```jsonc
// step 'analyze-method' 返回
{
  "version": "v1",
  "method": "<200-500 字 method 详解>"
}
```

8 段返回结果在 `merge-deep-analysis` step 合并写入 `extra.deep_analysis`,schema 见 §3.3。

### 5.2 ar5iv 全文段落级翻译 prompt(不变)

模型:**deepseek-v4-flash**(批量段落 translate,要时效)

```
你是论文全文翻译助手。

【输入】
- segment_id: <段落 ID>
- segment_text: <英文段落>
- paper_title: <论文标题>
- paper_keywords: <ai_keywords>(术语词典)

【任务】翻译为简体中文,保留:
- 专有名词英文(模型 / 数据集 / 方法名,对照 paper_keywords)
- 行内公式 $...$ 原文不译
- 代码块 ``` ``` 原文不译
- 表格 / 图表 caption 翻译,但保留 "Figure N:" / "Table N:" 前缀
- 引用标号 [1] [2] 保留

【风格】正式学术中文,不口语化。

只输出译文,不要解释。
```

按段并发(throttle ~5 req/sec),失败 retry 1 次,仍失败该段标 `{en: '...', zh: null, failed_at: '...'}`。

### 5.3 title / summary 翻译 prompt(flash,跟 8 段 pro 并行)

模型:**deepseek-v4-flash** / JSON Mode

```
你是论文标题翻译助手。

【输入】
- title: <paper.title>
- summary: <paper.summary>
- ai_summary_en: <paper.ai_summary>
- paper_keywords: <ai_keywords>

【任务】输出 JSON:
{
  "title_zh": "<标题中译,保留专有名词英文>",
  "summary_zh": "<abstract 中译,80-200 字,口语化但保持学术准确>",
  "ai_summary_zh": "<HF ai_summary 中译,30 字内>"
}

【规则】专有名词保留英文(参考 paper_keywords),中英混合留空格。
只输出 JSON,不要 markdown 包裹。
```

### 5.4 评论翻译 prompt(NEW #3,flash 批量)

模型:**deepseek-v4-flash** / JSON Mode

跟 abstract 同批走 flash,成本可忽略。批量入参(单次最多 10 条评论):

```
你是论文评论区翻译助手。

【输入】
- paper_title: <论文标题>
- comments: [
    { id: <id>, author: <name>, content: <英文/混合语言原文> }, ...
  ]

【任务】每条评论翻译为简体中文,输出 JSON:
{
  "translations": [
    { "id": <id>, "content_zh": "<译文>" }, ...
  ]
}

【规则】
- 保留 @username / #hashtag / URL 原文
- 专有名词英文(参考 paper_title)
- 口语化(学术评论也常用 colloquial 语言)
- 代码 / 公式原文保留
- emoji 保留
```

按 paper 批量调一次(10 条评论 / paper),失败 retry 1 次,仍失败该评论 `content_zh: null`,UI 只显原文。

### 5.5 月度 LLM 成本估算(C 方案 + 评论 + 全文翻译)

| 调用 | 模型 | 次数 / paper | token / 次 估算 | 月度成本估算(50 paper × 30 天)|
|------|------|--------------|----------------|------------------------------|
| 7 段 deep_analysis | pro reasoning | 7 | ~2000 token(含 reasoning) | **¥15-40/月** |
| title/summary 翻译 | flash | 1 | ~600 token | ~¥0.5/月 |
| ar5iv 段落翻译 | flash | ~40 段/paper | ~300 token/段 | ~¥1.5/月 |
| 评论翻译 | flash | 1 批 ≤10 条 | ~800 token | ~¥0.3/月 |
| **合计** | | | | **¥17-42/月** |

> **OPS budget alert 阈值建议从 ¥10 → ¥60**(留 50% buffer for 长尾 paper / reasoning chain 异常长)
>
> **校准协议**:Phase 4 backfill 第一轮跑 **10 条采样**,精准看实际 `total_tokens` × 7 段累计。如果月度估算 > ¥60 → `pushDeerAlert` 警告 OPS 调阈值或考虑降级到 B 2-group 方案。当前 ¥205 余额按 ¥40/月 走可撑 5 月,Phase 7 上线后跑 1 月看实际成本决定续费节奏。

---

## 6. UI 决策(对齐 FE 5 问)

### 6.1 维度可视化(FE 5 问 #1 + #2)

- **9 个字段实际,但 `novelty_rating` 是 meta 评分**(横切 8 维度),UI 上**不算"维度"**
- drawer 标题:**"论文 8 维度拆解"**,依次显示 `tldr / problem / key_insight / method / experiments / industry_impact / code_status / limitations`
- `novelty_rating` 作为 **★ 5 星条** 显示在 drawer header 右上角(或 title 旁),不进 8 维度列表
- 1-5 整数,FE 用 `★★★★☆`(实心 4 + 空心 1) 渲染 4 分

### 6.2 experiments 数据结构(FE 5 问 #3)

**结构化 JSON,不是 markdown table**:

```typescript
{
  datasets: string[];                                  // chip 行
  key_metrics: { name: string; value: string; vs_baseline: string }[]; // 2-3 列 table
  compute: string;                                     // 单行 monospace 文字
}
```

FE render 建议:

- `datasets` → 一行 chip(`bg-neutral-100 text-neutral-700`)
- `key_metrics` → 2 列 grid 或简易 `<table>`(name 列 + value 列 + vs_baseline 列)
- `compute` → 单行 `text-xs text-neutral-500 font-mono`

### 6.3 「拆解阅读」按钮(FE 5 问 #4)

**开 drawer,复用现有 DrawerProvider / itemUpdateBus**,不单开新路由组件。

URL routing:`/h/:arxiv_id`(`h` 表 HF Paper,跟 `/g/:owner/:repo` 同 source-prefixed 模式)。

- 应用内点卡片 → `pushState('/h/:arxiv_id')` → drawer 开
- 关闭 → `back()` → 回 `/`
- 冷启动深链 → `replaceState('/')` + `pushState('/h/:arxiv_id')` seed 历史栈

### 6.4 HF avatar 域名 + 数字单位(FE 5 问 #5)

**avatar / thumbnail 域名**:

| 域名 | 用途 |
|------|------|
| `cdn-avatars.huggingface.co` | 用户头像 |
| `cdn-thumbnails.huggingface.co` | paper thumbnail |

**BE 加 worker `/img` 的 `PROXY_HOSTS` allowlist**,FE 直接走 `/img?url=<encoded>&w=128` 反代(自动 webp/avif + R2 缓存)。统一图片处理路径,不走 og:image `proxyImg(url, w, { force: true })` 模式。

**数字单位**:`formatCompact`(1.2k / 142k)— 跟 GH 卡片一致,HF 是西方平台,用户预期英文数字单位。

- `upvotes`:`formatCompact(140)` → `140`
- `github_stars`:`formatCompact(70)` → `70`,`formatCompact(15200)` → `15.2k`
- `num_comments`:`formatCompact(numComments)`

### 6.5 卡片字段(feed)

```
┌────────────────────────────────────────────┐
│ [thumbnail 1200×630 → 卡片 640×360]        │  media 区(必有,HF 全有)
│ ┌──────────────────────────────────────┐  │
│ │ 论文标题中译(2 行 line-clamp)       │  │
│ │ 一句话中译(ai_summary_zh,1 行)     │  │
│ └──────────────────────────────────────┘  │
│ #关键词1  #关键词2  #关键词3              │  ai_keywords 前 3 个 chip
│ ▲ 140  💬 13  ⭐ 70                        │  metrics(SVG icon,emoji 仅示意)
│ 👤 by @taesiri · 2 天前       ★★★★☆       │  submitter handle + relative + novelty
│ [拆解阅读]                                 │  CTA 按钮
└────────────────────────────────────────────┘
```

> ⚠️ 严禁 emoji 当 icon(SOP §5.F),metrics 行的 ▲ / 💬 / ⭐ 必须用 lucide-react SVG。

### 6.6 Drawer 区段顺序(按"用户决策"路径)

1. **Hero**:thumbnail + 标题中译 + 副标题(ai_summary_zh) + ★ novelty + submitter avatar
2. **TL;DR**:`deep_analysis.tldr`(大字号黑底白字,强调)
3. **8 维度拆解**:
   - 问题 `problem`
   - 核心创新 `key_insight`(bullet list)
   - 方法 `method`
   - 实验 `experiments`(datasets chips + metrics table + compute)
   - 工业影响 `industry_impact`
   - 代码状态 `code_status`(github + license + reproducibility)
   - 局限 `limitations`(bullet)
4. **HF 元信息**:upvotes / num_comments / project_page 链接 / submitter / submitted_on_daily_at
5. **作者列表**:折叠区(20+ 作者时只显前 5,展开看全)
6. **AI Keywords**:HF 自己生成的 keyword chip 行
7. **全文翻译**(若已 fetch ar5iv):英 / 中双语 tab 切换,段落级对齐
8. **原文 Abstract**:HF 英文 abstract + 一键复制 / 跳 arxiv.org
9. **外跳行**:`在 HF 打开 ↗` / `在 arXiv 打开 ↗` / `在 GitHub 打开 ↗`(若 hasGhRepo)

### 6.7 分享海报(chipColor `#ffd9a8`)

参考 SOP §5.G:**只写 content 区**,hero / footer 复用。

content 区字段:

- thumbnail 顶部(`renderMediaBlock`)
- 标题中译(64px primary,2 行 cap)
- TL;DR 中译(36px subtitle,3 行 cap)
- 一行 metrics:★ novelty + upvotes + stars
- 一行身份:`by @<submitter> · HF Daily`

**chipColor `#ffd9a8`**(暖橙色)— 跟 X 白 / GH mint / PH peach(#ffd1c1) / CH lavender 区分。PH 已是 peach 系,HF 用稍偏黄的暖橙避免撞色。

---

## 7. 数据流程

```
[HF /api/daily_papers]
  ↓ Phase 1 cron 1 次/天(BJT 08:00,UTC 00:00 出榜后)
  ↓ arxiv.org Atom API 补 arxiv_categories(NEW #2,batch 50 个 1 次拿)
  ↓ for each paper in 50:
     ↓ extra.<hint>:hasGhRepo / hasProjectPage / hasDiscussionId 信号位
     ↓ INSERT items stub(id=hf:<arxiv_id>,is_relevant=1 直接定,
                          arxiv_categories 已填,_zh / deep_analysis 字段空)
     ↓ trigger HF_PAPER_PIPELINE_WORKFLOW.create({arxiv_id, signals, lang: 'zh'})
                ↓
Phase 2 workflow(每 paper 1 instance,异步并行)
  Step 0: refresh paper detail + fetch arxiv_categories(NEW #2)
  Step 1 fan-out:
    - backfill media → R2(HF thumbnail + submitter avatar 全量,兜底)
    - refresh GH star(若 hasGhRepo)
    - fetch ar5iv 全文 + 内嵌 extract-first-figure(NEW #1)→ figure 迁 R2 + 写 media[0]
    - fetch discussion(NEW #3,internal API 或 puppeteer)+ 评论者 avatar 迁 R2
  Step 2 fan-out:
    - 翻译 ar5iv 段落(若 step 1 抓到,flash 批量)
    - 翻译 discussion comments(NEW #3,flash 批量)
  Step 3 fan-out(9 个并行,wall-clock = max(单段耗时)):
    - 7 次 pro reasoning 独立调用(NEW #4 C 方案):tldr / problem / key_insight /
      method / experiments / industry_impact / code_status / limitations_and_novelty
    - 1 次 flash translate(title / summary / ai_summary 合并)
    - merge-deep-analysis(写 extra.deep_analysis)
  Step 4: 完整性 gate(8 段 + translate 全成 → 写 workflow_completed_at)
                ↓
[/api/items filter] 只展示 workflow_completed_at IS NOT NULL 的 item
[/api/items?category=cs.LG filter](NEW #2)
[Dashboard] feed 渲染 HfPaperCard / drawer 渲染 HfPaperDrawerBody
            + 列头 dropdown 切 arxiv category(NEW #2)
            + drawer 评论 section 显原文 + 译文 toggle(NEW #3)
                ↓
[Phase 8 通知] ctx.waitUntil(notifyCronSummary('HF Daily Papers fetch', stats))
              → PushDeer 推 fetch summary + workflow 24h 完成度 +
                avg_deep_analysis_tokens(校准用)
```

---

## 8. 与已有源的差异点

| 维度 | HF Paper 与其他源差异 |
|------|---------------------|
| LLM judge | **不需要**(HF Daily 已策展,默认 `is_relevant=1`)|
| LLM 调用结构 | **7 次独立 pro reasoning fan-out + 1 次 flash translate**(C 方案,#4)— 其他源全是 1 次合并调用 |
| LLM 模型 | **唯一用 pro reasoning 的源**(其他源全 flash)— 因 deep_analysis 需要每段独立思考 |
| 媒体迁移 | thumbnail + avatar + **论文 figure(#1)** + 评论者 avatar 全量迁(类似 PH 但范围更广),都过 `/img` + R2 |
| 关联字段 | 简单(github_repo / project_page),无嵌套关系(不像 X 的 quote/reply)|
| 长内容拉取 | ar5iv HTML **v1 必含**(不像 GH 长 README 是 lazy)|
| **评论(#3)** | v1 必含(原 v2),走 puppeteer / internal API 抓 + flash 翻译,跟 PH top_comments 模式类似 |
| **分类筛选(#2)** | `extra.arxiv_categories`,列头 dropdown 服务端 filter(走 arxiv.org Atom API 抓)|
| 完整性 gate | translate + 8 段 deep_analysis(允许 ≤2 段失败)都成才算完整 |
| 跑批节奏 | daily(1 次/天),最慢的源 |
| 排序 | `paper.upvotes` desc(HF 自己的热度排序)|
| 通知 | Phase 8 标准模式,1 次/天 cron summary 推 PushDeer |
| 数据 metric | 比其他源轻量:upvotes / num_comments / github_stars 三个 |
| 月度 LLM 成本 | **¥17-42/月**(最贵的源,C 方案 7 次 pro reasoning)— 其他源 < ¥5/月 |

---

## 9. Phase 拆分(实施计划)

> **2026-05-18 PM 4 项变更整合后总工时:12.75 天**(原 7 天,user PM 已 sign-off "延期不 care,最宽泛可接受")
> - 新增 Phase 0.5 reconnaissance(0.5 天)— 探 HF discussion internal API
> - Phase 1-8 各项工时调整,具体见下

### Phase 0:设计 + Mockup(进行中,~2 天)

- [x] BE 决策矩阵 + 数据源 API verify(本文档)
- [x] BE 字段初稿(items.extra schema + deep_analysis JSON,§3)
- [x] BE 真实数据 sample(`docs/plans/_research/2026-05-18-hf-daily-papers-sample/`)
- [x] BE FE handoff 文档(`docs/plans/2026-05-18-hf-daily-papers-frontend-handoff.md`)
- [x] SOP 加 Phase 8(`docs/source-integration-sop.md`)
- [x] OPS 三项 verify(staging HF_READ / DeepSeek pro / PushDeer)
- [x] FE mockup 三件套(PR #83 branch `worktree-feat+hf-paper-mockup` draft)
- [x] PM 4 项变更整合到设计文档(本节)
- [x] PM sign-off 延期到 12.75 天 + #3 评论原文+译文 + #4 C 方案最佳质量

### Phase 0.5:Reconnaissance(NEW #3,0.5 天)

> 启动 Phase 1 前必跑。决定 #3 评论抓取走哪条路径,影响 Phase 3 工时上限。

- [ ] 深挖 HF paper page HTML(199KB),找 SSR 嵌入的 discussion / community 数据
- [ ] 试探 internal API:`/api/papers/{id}.json` / `?community=true` / `/api/papers/{id}/comments` / `/api/repos/papers/{id}/discussions` / paper page 的 `__APP_DATA__` 等
- [ ] 试 web URL `/papers/{id}/discussions/{num}` cookie-only fallback(用 HF_READ token 当 cookie?)
- [ ] 报告:**找到 internal API** → Phase 3 节省 1 天 → 总工时 11.75 天;**只能 puppeteer** → Phase 3 +2 天 → 总工时 12.75 天

### Phase 1:Schema + 配置(1 天,原 0.5 天 +0.5 天 NEW #2)

- [x] OPS 加 staging HF_READ secret(2026-05-18 done)
- [x] OPS verify DeepSeek v4-pro 月度配额 + reasoning token 警告
- [ ] `worker/src/schema.sql` 加 `metrics_snapshots_hf_paper`
- [ ] `dashboard/src/types.ts` 加 `SourceType 'hf_paper'`
- [ ] `App.tsx` 加 `SOURCE_COLUMNS` + `FILTER_CHIPS`
- [ ] `wrangler.toml` 加 `HF_PAPER_PIPELINE_WORKFLOW` binding(top-level + env.staging)
- [ ] `worker/src/img.ts` `PROXY_HOSTS` 加 `cdn-avatars.huggingface.co` / `cdn-thumbnails.huggingface.co` / `ar5iv.labs.arxiv.org`(论文 figure 走 /img 反代)
- [ ] **NEW #2**:`worker/src/api/items.ts` 加 `category` query param filter(`WHERE json_extract(extra, '$.arxiv_categories') LIKE '%"<cat>"%'`)
- [ ] D1 migrate(prod + staging)

### Phase 2:fetch handler(1.5 天,原 1 天 +0.5 天 NEW #2)

- [ ] `worker/src/hf-paper.ts` `runHfDailyFetch`
- [ ] **NEW #2**:`worker/src/hf-paper/fetch-arxiv-categories.ts`,arxiv.org Atom API 批量抓 categories(`?id_list=<id1>,<id2>,...` comma-separated 单次拿 50 个,3 sec throttle,XML parse `<arxiv:primary_category>` + `<category>`)
- [ ] scheduled handler 加 daily slot(`hour=0` UTC = BJT 08:00)
- [ ] INSERT stub + `triggerHfPaperWorkflowForItem`(带 hour-bucket suffix,signals 含 `hasDiscussionId`)
- [ ] dry-run / `--limit 5` 验证(含 categories 入库)

### Phase 3:Workflow 实现(4-5 天,原 2 天 +1.25 天 #1+#3+#4 / +2.75 天悲观)

- [ ] `worker/src/workflows/hf-paper-pipeline.ts`(参考 §4 新版,含 8 段 fan-out)
- [ ] `worker/src/hf-paper/refresh-paper-detail.ts`(step 0)
- [ ] `worker/src/hf-paper/backfill-media-r2.ts`(step 1,HF thumbnail + avatar 兜底)
- [ ] **NEW #1**:`worker/src/hf-paper/fetch-ar5iv-and-extract-figure.ts`(step 1)— ar5iv HTML 抓 + img 解析 + 质量 gate(arxiv chrome 排除 / dimensions ≥ 300×200 / aspect ratio 1:4~4:1)+ R2 迁移 + 写 `media[0]`
- [ ] `worker/src/hf-paper/refresh-gh-star.ts`(step 1)
- [ ] **NEW #3**:`worker/src/hf-paper/fetch-discussion.ts`(step 1)— 按 Phase 0.5 结果走 internal API 或 puppeteer。puppeteer 路径需 `wrangler.toml` 加 `[browser] binding = "BROWSER"`,参考 PH POC 模板
- [ ] `worker/src/hf-paper/translate-ar5iv.ts`(step 2)
- [ ] **NEW #3**:`worker/src/hf-paper/translate-discussion-comments.ts`(step 2,flash 批量)
- [ ] `worker/src/hf-paper/translate-title-summary.ts`(step 3,flash JSON Mode)
- [ ] **NEW #4**:`worker/src/hf-paper/analyze-dimension.ts`(step 3)— C 方案核心,接收 `dimension` 参数(`tldr / problem / key_insight / method / experiments / industry_impact / code_status / limitations_and_novelty`)dispatch 到对应 prompt
- [ ] **NEW #4**:`worker/src/hf-paper/merge-deep-analysis.ts`(step 3)— 合并 8 段返回写 `extra.deep_analysis`
- [ ] 单条端到端 `wrangler dev` 跑通(8 段并行 + 校验 JSON schema + merge)

### Phase 4:跑批入口 + LLM 成本校准(1 天,原 0.5 天 +0.5 天 NEW #4 校准)

- [ ] `/api/enrich/run?mode=backfill-hf-paper-workflow` Bearer endpoint(SOP §1.6 模板)
- [ ] scheduled handler 加兜底 cron slot(`minute=20/50` 每 30min,limit=20 / throttle=3s)
- [ ] **NEW #4 校准**:第一轮 backfill 跑 **10 条采样**,精准看 8 段 deep_analysis 实际 `total_tokens`(含 reasoning)累计 → 估算月度成本 → 写 OPS 报告 → 决定 budget alert 阈值是否调整 / 是否降级到 B 2-group

### Phase 5:Dashboard UI(2.5 天,原 2 天 +0.5 天 NEW #2 dropdown)

- [ ] `HfPaperCard.tsx`(已 PR #83,字段已对齐)
- [ ] `HfPaperDrawerBody.tsx`(已 PR #83,字段已对齐,含评论 section placeholder)
- [ ] `IconHfPaper`(HF logo 简化 SVG,严禁 emoji)
- [ ] `Feed.tsx` 路由 `source_type === 'hf_paper'`
- [ ] `TweetDrawer.tsx` 路由 `isHfPaper`
- [ ] `/h/:arxiv_id` URL routing
- [ ] **NEW #2**:`Feed.tsx` 加列头 dropdown(聚合当前可见 paper 的 `arxiv_categories[0]`,onChange 触发 `?category=<cat>` query)
- [ ] 分享海报 SVG 模板加 `renderHfPaperContent`(`worker/src/share/svg-template.ts`)

### Phase 6:R2 资源迁移(含在 Phase 3,不单独)

- thumbnail + avatar + 论文 figure 走现有 R2 bucket `xlist-readme-assets/hf/<sha>.<ext>`
- 评论者 avatar 也迁(NEW #3)
- 复用 GH 的 `r2-migrate` helper(白名单 mime + 5MB cap + 跳 `/r/` 已迁路径)
- ar5iv 段落 JSON 存 `xlist-readme-assets/hf-paper-ar5iv/<arxiv_id>.json`(独立 prefix)

### Phase 7:真机验收 + operations.md(0.5 天)

- iOS Safari + 微信 WebView 验收
- 安卓走 `ai-feeds.com` main 自定义域
- mobile golden path 同 SOP §3 Phase 7
- **新增验收点**:
  - [ ] 列头 dropdown 切 arxiv category 后 feed 刷新正确(NEW #2)
  - [ ] drawer 评论 section 显原文 + 译文 toggle(NEW #3)
  - [ ] 卡片首图是论文 figure 不是 HF social-thumbnail(NEW #1)— ~70% 命中率,部分论文找不到合格 figure 时回到 HF thumbnail
  - [ ] drawer 8 段 deep_analysis 每段 200-500 字深度长文显示(NEW #4)
- `docs/operations.md` 加:
  - cron schedule(`hour=0 UTC`)
  - D1 表 `metrics_snapshots_hf_paper`
  - R2 key 前缀 `hf/` + `hf-paper-ar5iv/`
  - workflow binding `HF_PAPER_PIPELINE_WORKFLOW`
  - puppeteer 配置(若 #3 走 puppeteer 路径)
  - **LLM 成本估算**:C 方案 ¥17-42/月(deep_analysis 7 次 pro reasoning + translations / 评论 flash)
  - **OPS budget alert 阈值**:¥60/月(留 50% buffer)
  - secrets `HF_READ`(prod + staging)
  - backfill endpoint 跑批方法 + 兜底 cron 节奏

### Phase 8:跑批通知(0.5 天)

- `worker/src/hf-paper.ts` fetch handler 末尾 `ctx.waitUntil(notifyCronSummary(env, 'HF Daily Papers fetch', stats))`
- `notifier.ts` `FIELD_LABELS` 加 HF 字段:
  - `list_size` → 榜单大小(已有)
  - `inserted` → 新增(已有)
  - `triggered` → 触发 workflow 数
  - `workflow_completed_24h` → 24小时内完成数
  - `workflow_pending_24h` → 24小时内待完成数
  - **NEW #4**:`avg_deep_analysis_tokens` → 平均 deep_analysis token 消耗(校准用)
- 验证 prod 第一轮 cron 跑完 PushDeer 收到通知

**总估时:12.75 天**(BE 11 + FE 1.75 重叠,FE PR #83 mockup 已 done)
- 乐观(Phase 0.5 找到 internal API):**11.75 天**
- 悲观(Phase 0.5 必须 puppeteer + 校准发现要降级方案):**13.75 天**

---

## 10. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| DeepSeek pro 配额不够 | 低 | 中 | OPS 已 verify(2026-05-18,余额 ¥205);C 方案估算 ¥17-42/月,余额可撑 5-12 月 |
| **pro reasoning_tokens 实际成本超估算**(C 方案 7 次/paper 累加) | 中 | 中 | Phase 4 跑 10 条采样精准校准 → 写 OPS 报告;月度 > ¥60 → `pushDeerAlert` budget alert + 考虑降级 B 2-group |
| HF API rate limit | 低 | 低 | 1 次/天 × 50 detail,远低于 limit |
| **NEW #1**:论文首图找不到(reasoning 类 / 短论文 / theory 类论文 ar5iv 无 figure) | 高 | 低 | sample 验证 `2605.13301` 全 HTML 7 个 img 全是 arXiv chrome 0 figure;**默认行为**:找不到合格图 → fallback HF social-thumbnail。**告知 PM ~30% 论文无法显示论文 figure** |
| ar5iv 抓不到(新论文未 mirror) | 中 | 中 | step 1 fail-safe 返 null 不阻断 workflow;影响:**method/experiments 维度质量下滑**(prompt 依赖 ar5iv_excerpt);后续 cron 重试 |
| **NEW #2**:arxiv.org Atom API rate limit / 偶发 timeout | 低 | 低 | 3 sec throttle + retry 2 次;失败 paper 标 `extra.arxiv_categories: []`,列表 dropdown 不会聚合该 paper |
| **NEW #3**:HF discussion API 全 404 → 必须 puppeteer | 中 | 中 | Phase 0.5 reconnaissance 先探;puppeteer 路径 +1.5 天 + CF Browser Rendering 月度 10h 配额够用(50 paper × 5sec = ~2h/月);抓失败 fail-safe → drawer 评论 section 显"暂无评论" |
| **NEW #4**:C 方案某段失焦或 JSON 校验失败 | 中 | 中 | 每段独立 retry 2 次,失败标 `extra.deep_analysis.<dim>_failed_at`,UI 显"本段解读暂未生成";整 paper 至少 6/8 段成才算完整(`workflow_completed_at` 写入条件可放宽,Phase 3 时定) |
| HF Daily 内容偶发非 AI(误策展) | 极低 | 低 | 默认 `is_relevant=1`,管理员看到误判 UI 加 hide 按钮(v2) |
| deep_analysis JSON 校验失败 | 中 | 中 | JSON Mode + 每段独立 retry 2 次 + 标 `<dim>_failed_at`,`/api/items` filter 严格度可调 |
| novelty_rating 偏差大 | 中 | 低 | 跑 1 周后人工校准 prompt 评分参考;UI 已经决定加 "AI 评分,仅供参考" 小字 |
| HF avatar / thumbnail 域名变 | 低 | 中 | `PROXY_HOSTS` 加 wildcard `*.huggingface.co` |
| ar5iv 全文超长(>1MB)爆 D1 行 | 中 | 中 | 选项 B:存 R2 `hf-paper-ar5iv/<arxiv_id>.json`,extra 只记 `ar5iv_paragraphs_count` |
| HF Daily 改版导致 listing schema 变 | 低 | 高 | fetch handler 加 fail-safe(缺字段 log + 保留可用部分);`pushDeerAlert` 告警 |
| **NEW**:CF Workflow step 上限 / fan-out 8 段触发限制 | 低 | 中 | CF Workflows 实测 fan-out 多 step OK;若 timeout 频发(单段 pro reasoning > 10min),Phase 3 把 8 段串行(代价:wall-clock 8x,但不影响成功率) |

---

## 11. OPS 接触点

### 2026-05-18 已 verify ✅

- [x] **staging HF_READ secret**:`.secrets/aifeeds-staging.env` 追加 HF_READ(从 prod copy,len=37),`wrangler secret put HF_READ --env staging` 推送成功到 `xlist-api-staging` worker。`wrangler secret list --env staging` 确认在列。
- [x] **DeepSeek v4-pro 配额**:可调,model `deepseek-v4-pro` 返 chat.completion 正常。**⚠️ 注意**:pro 是 reasoning model,reasoning_tokens 开销显著(测试 reasoning 占 completion 93%)。当前余额 ¥205。
- [x] **PUSHDEER_ADMIN_KEYS**:已用于 cron summary 通知,2 个 admin token 各推一条 preflight 测试,返 `{"code":0,"counts":1,"success":"ok"}`,送达确认。

### Phase 1+ 待处理(随实施推进)

- [ ] **Budget alert 阈值调整**:从 ¥10/月 → **¥60/月**(C 方案 7 次 pro reasoning + 评论翻译累加,估 ¥17-42/月,留 50% buffer)。Phase 4 第一轮 10 条采样后精准校准,实际 > ¥60 → 触发 `pushDeerAlert` + OPS 决定是否充值 / 降级方案
- [ ] **CF Browser Rendering 绑定**(若 Phase 0.5 reconnaissance 失败,#3 必须 puppeteer):`wrangler.toml` 加 `[browser] binding = "BROWSER"` + Workers Paid plan 自带 10h/月配额。HF discussion 抓取月度估算 ~2h(50 paper × 5 sec × 30 天),容量充足
- [ ] **R2 bucket cap 监控**:论文 figure 全量迁(NEW #1),50 paper × 30 天 × ~200KB/figure = ~300MB/月。`xlist-readme-assets` bucket 当前总量(待 OPS 报)+ 此项增量是否需要扩容
- [ ] **DeepSeek 月度成本监控**:Phase 7 上线后 1 个月观察实际成本,超 ¥60 → OPS 决定续费节奏 / 调阈值 / 降级方案

---

## 12. FE 接触点(✅ PR #83 mockup done + 4 项变更 PM 已 sign-off)

- **FE mockup PR**:`#83`,branch `worktree-feat+hf-paper-mockup`(draft)
- **真实数据 sample**:`docs/plans/_research/2026-05-18-hf-daily-papers-sample/`
  - `daily_papers.json` — 50 条今日 listing(原 API response)
  - `paper_detail_2605.13301.json` — 高 upvote(140)+ 有 GH(70 stars)
  - `paper_detail_2605.15141.json` — 高 upvote(84)+ projectPage 在 GH
  - `paper_detail_2605.06554.json` — 中 upvote(21)+ GH(25 stars)
  - `paper_detail_2605.14386.json` — 中 upvote(50)+ 无 GH 仅 projectPage
  - `paper_detail_2605.15320.json` — 低 upvote(1)+ 无 GH 无 projectPage(冷启动 case)
  - `ar5iv_2605.13301.html` — 1 篇全文样本(50KB,可解析参考)
- **BE 字段 schema**:本文档 §3
- **FE 5 问答**:本文档 §6
- **FE handoff 详文档**:`docs/plans/2026-05-18-hf-daily-papers-frontend-handoff.md`
- **三件套**:feed 卡片(列宽 ~380px / 简介 4 行 / metrics + by 同行)+ drawer(常驻区上移 / TL;DR 默认 callout / 评论 section placeholder)+ 1080×1350 海报
- **chipColor**:`#ffd9a8`(暖橙色)
- **PM 4 项变更已整合**(2026-05-18):
  - #1 论文首图:BE Phase 2 抓 ar5iv 时解析 figure + R2 迁,FE 字段不变(media[0]),~70% 命中率(部分 reasoning 类论文无 figure 时 fallback HF thumbnail)
  - #2 arxiv_categories:BE Phase 1 抓 arxiv.org Atom API 入库,FE Phase 5 加列头 dropdown
  - #3 评论 v1 必含:BE Phase 0.5 reconnaissance 决定 internal API / puppeteer,FE 字段已预留(`extra.discussion_comments`)
  - #4 deep_analysis 200-500 字:BE 走 C 方案 7 次独立 pro reasoning,FE 视觉已预留 leading-[1.7] + whitespace-pre-wrap

---

## 13. 参考

- SOP:[docs/source-integration-sop.md](../source-integration-sop.md)
- 前端规范:[docs/frontend-ux-guidelines.md](../frontend-ux-guidelines.md)
- 历史源设计:[2026-05-01-github-trending-source-design.md](2026-05-01-github-trending-source-design.md) / [2026-05-11-ph-graphql-cf-cron-design.md](2026-05-11-ph-graphql-cf-cron-design.md)
- 海报模板:`worker/src/share/svg-template.ts`
- notifier:`worker/src/notifier.ts`
- X workflow 参考实现:`worker/src/workflows/x-tweet-pipeline.ts`
