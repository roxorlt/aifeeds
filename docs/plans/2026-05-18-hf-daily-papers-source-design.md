# HuggingFace Daily Papers 源接入设计

> 日期:2026-05-18
> 状态:Phase 0 设计稿,FE mockup 进行中(ETA 1.5-2 天)
> 对应 SOP:[docs/source-integration-sop.md](../source-integration-sop.md)
> Mockup:`docs/plans/_mockups/2026-05-18-hf-paper-*.html`(FE 出三件套)
> 真实数据 sample:[docs/plans/_research/2026-05-18-hf-daily-papers-sample/](_research/2026-05-18-hf-daily-papers-sample/)
> FE handoff:[docs/plans/2026-05-18-hf-daily-papers-frontend-handoff.md](2026-05-18-hf-daily-papers-frontend-handoff.md)

---

## 1. 决策矩阵(已 brainstorming 确认)

| 维度 | 决策 |
|------|------|
| 数据来源 | HF 官方 `GET /api/daily_papers`(返 50 条/天) + `GET /api/papers/{arxiv_id}` 详情 |
| 鉴权 | `Authorization: Bearer <HF_READ>`,token 已配 prod env,staging 待 OPS copy |
| 拉取频率 | 每天 1 次 cron(BJT 08:00 = UTC 00:00,HF Daily 出榜后)|
| Item 映射 | `id = hf:<arxiv_id>` / `source_id = <arxiv_id>` / `title = paper.title` / `content = paper.summary` / `author = paper.authors[0].name` |
| extra 字段 | submitter 信息 / project_page / github_repo / github_stars(HF 已抓)/ ai_keywords / **8 维度 deep_analysis JSON** |
| 指标 | metrics_snapshots_hf_paper(可选):`upvotes / num_comments / github_stars` |
| Workflow step | step 0 refresh detail / step 1 fan-out(media R2 + GH star + ar5iv)/ step 2 ar5iv 段落翻译 / step 3 translate+deep_analysis 合并调用 / step 4 完整性 gate |
| 关联字段 | 无嵌套关系(不像 X 的 quote/reply),github_repo HF 直接给好 |
| 媒体字段 | thumbnail(必有,1200×630)+ submitter avatar 全量迁 R2 |
| LLM judge | **不需要**(HF Daily 已策展,默认 is_relevant=1)|
| LLM 模型 | **deepseek-v4-pro**(唯一用 pro 的源,因 deep_analysis 需要推理);ar5iv 段落级翻译用 flash |
| 翻译 | title / summary / ai_summary 翻;ar5iv 全文段落级翻(必含 v1)|
| 完整性 gate | translate + deep_analysis 都成 → 写 `workflow_completed_at` |
| Card 布局 | thumbnail 顶置 + 标题中译 + 关键词 chips + metrics + ★ novelty |
| Drawer 内容 | TL;DR + 8 维度拆解 + 元信息 + 作者 + AI 关键词 + 全文翻译 + 原文 + 外跳 |
| 排序 | `paper.upvotes` desc(HF 自己的热度排序)|
| 通知 | Phase 8 标准模式,1 次/天 cron summary 推 PushDeer |

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
  "is_author_participating": false,

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

### 3.3 deep_analysis JSON schema(8 维度 + 1 评分)

> ⚠️ **9 个 key,但 `novelty_rating` 是 meta 评分**(横切其他 8 维度),UI 上**不算"维度"**。drawer 标题写"论文 8 维度拆解",`novelty_rating` 作为 ★ 5 星条单独显示(详见 §6.1)。

| key | 类型 | 长度限制 | 说明 |
|-----|------|---------|------|
| version | string | - | `"v1"` 固定,未来加 v2 时变 |
| tldr | string | 30 字内 | 一句话核心 |
| problem | string | 50 字 | 解决什么问题 + 现有方法局限 |
| key_insight | string[] | 1-3 条 | 核心创新点 bullet |
| method | string | 80 字 | 方法概述,避免数学公式 |
| experiments.datasets | string[] | ≤5 | 数据集名 |
| experiments.key_metrics | object[] | ≤5 | 每个 `{name, value, vs_baseline}` 都是 string |
| experiments.compute | string | 20 字 | 训练算力 |
| novelty_rating | integer | 1-5 | 5=突破性,1=渐进改进 |
| industry_impact | string | 50 字 | 对工业界影响 |
| code_status.github_url | string\|null | - | 复用 `extra.github_repo` 加前缀 |
| code_status.star_count | integer\|null | - | 复用 `extra.github_stars` |
| code_status.license | string\|null | - | `MIT` / `Apache-2.0` / `unknown` 等 |
| code_status.reproducibility | enum | - | `easy` / `medium` / `hard` |
| limitations | string[] | 1-3 条 | 论文承认或可推断的局限 |

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

```typescript
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const RETRY = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

type HfPaperParams = {
  itemId: string;          // 'hf:2605.13301'
  arxivId: string;         // '2605.13301'
  hasGhRepo: boolean;
  hasProjectPage: boolean;
  lang: 'zh' | 'en';       // 翻译目标语言,默认 'zh'
};

export class HfPaperPipelineWorkflow extends WorkflowEntrypoint<Env, HfPaperParams> {
  async run(event: WorkflowEvent<HfPaperParams>, step: WorkflowStep) {
    const { itemId, arxivId, hasGhRepo, lang } = event.payload;

    // Step 0:数据补全 — refresh paper detail(防 listing 抓的中途被删/改)
    await step.do('refresh-paper-detail', RETRY, () =>
      refreshPaperDetailForHf(this.env, itemId, arxivId),
    );

    // Step 1:fan-out 并行
    const [, , ar5ivResult] = await Promise.all([
      // 媒体迁移(thumbnail + submitter avatar 无条件迁 R2)
      step.do('backfill-media-r2', RETRY, () =>
        backfillMediaForHfPaper(this.env, itemId, arxivId),
      ),
      // GH star refresh(若 hasGhRepo)
      hasGhRepo
        ? step.do('refresh-gh-star', RETRY, () =>
            refreshGhStarForHfPaper(this.env, itemId),
          )
        : Promise.resolve(null),
      // ar5iv 全文抓取(必跑)
      step.do('fetch-ar5iv', RETRY, () =>
        fetchAr5ivForHfPaper(this.env, itemId, arxivId),
      ),
    ]);

    // Step 2:ar5iv 全文段落级翻译(若 step 1 抓到)
    if (ar5ivResult?.fetched) {
      await step.do('translate-ar5iv', RETRY, () =>
        translateAr5ivForHfPaper(this.env, itemId, { lang }),
      );
    }

    // Step 3:translate + deep_analysis 合并 1 次 DeepSeek pro JSON Mode 调用
    // 不需要 classify(HF Daily 已策展,is_relevant=1 在 INSERT 时定),
    // 但仍合并到 1 次调用产 _zh 字段 + deep_analysis
    const analysis = await step.do('translate-deep-analyze', RETRY, () =>
      translateAndDeepAnalyzeForHfPaper(this.env, itemId, {
        lang,
        target_audience: 'cn_practitioner',
      }),
    );

    // Step 4:完整性 gate
    if (!analysis.failed) {
      const nowIso = new Date().toISOString();
      await step.do('mark-completed', RETRY, async () => {
        await this.env.DB.prepare(
          `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.workflow_completed_at', ?)
            WHERE id = ?`,
        ).bind(nowIso, itemId).run();
      });
    }

    return { itemId, completed: !analysis.failed };
  }
}
```

### 4.1 hasXxxRef 信号

| signal | 检查 | 触发的 step |
|--------|------|------------|
| `hasGhRepo` | `!!extra.github_repo` | step 1 `refresh-gh-star` |
| `hasProjectPage` | `!!extra.project_page` | 暂无(留 future:抓 project page 截图迁 R2)|

### 4.2 instance ID(带 hour-bucket,SOP §1.5)

```typescript
const hourBucket = new Date().toISOString().slice(0, 13).replace('T', '-'); // "2026-05-18-08"
const instanceId = `hf-paper-${arxivId.replace(/\./g, '-')}-${hourBucket}`;
// 例:hf-paper-2605-13301-2026-05-18-08
```

---

## 5. LLM Prompt 设计

### 5.1 合并调用 prompt(translate + deep_analysis)

模型:**deepseek-v4-pro** / JSON Mode(`response_format: {type: 'json_object'}`)

```
你是 AI 论文解读专家,服务中国 AI 从业者。

【输入】
- title: <paper.title>
- summary: <paper.summary>(英文 abstract)
- ai_summary_en: <paper.ai_summary>(HF 已生成的一句话英文摘要)
- ai_keywords: <paper.ai_keywords>(HF 已生成的关键词)
- github_url: <extra.github_repo 完整 URL 或 null>
- github_stars: <extra.github_stars 或 null>
- project_page: <extra.project_page 或 null>

【任务】严格按以下 JSON schema 输出,所有字段必填(无依据填 "unknown" / 空数组 / null):

{
  "title_zh": "<标题中译,保留专有名词英文>",
  "summary_zh": "<abstract 中译,80-200 字,口语化>",
  "ai_summary_zh": "<HF ai_summary 中译,30 字内>",
  "deep_analysis": {
    "version": "v1",
    "tldr": "<1 句核心,30 字内>",
    "problem": "<解决什么问题 + 现有方法局限,50 字>",
    "key_insight": ["<创新点 1>", "<创新点 2>"],         // 1-3 条
    "method": "<方法概述,80 字,避免数学公式>",
    "experiments": {
      "datasets": ["<数据集 1>"],
      "key_metrics": [{"name": "<指标>", "value": "<值>", "vs_baseline": "<相对基线>"}],
      "compute": "<训练算力,20 字内>"
    },
    "novelty_rating": <1-5 整数>,
    "industry_impact": "<对工业界影响,50 字>",
    "code_status": {
      "github_url": "<从输入复用或 null>",
      "star_count": <从输入复用或 null>,
      "license": "<MIT / Apache-2.0 / unknown 等>",
      "reproducibility": "<easy / medium / hard>"
    },
    "limitations": ["<局限 1>"]                          // 1-3 条
  }
}

【翻译规则】
- 专有名词(模型 / 数据集 / 方法名)保留英文,例:Transformer / NeRSemble / FLAME / LoRA
- 中英混合句中,英文术语前后留空格,例:"使用 LoRA 微调"
- 代码 / 公式原文保留
- 风格:正式但易懂,避免 "重磅" / "突破" / "震撼" / "最强" 等营销腔
- 中国从业者视角:industry_impact 必须点出能落地的工业场景

【novelty_rating 评分参考】
- 5: 开创新方向(如首个 Transformer / DDPM / RLHF 论文)
- 4: 重要改进,业内必看(如 LoRA / FlashAttention / Mistral)
- 3: 稳健工作,某细分领域 SOTA
- 2: 渐进改进,补充已有方法
- 1: 数据集 / 综述 / 复现工作

【限制】
- 所有字段必填(可推断时推断,无依据填占位)
- 不要捏造数字,key_metrics 没把握时返空数组
- novelty_rating 必须 1-5 整数,不能 4.5
- 只输出 JSON,不要 markdown 代码块包裹,不要解释

【target_lang】当 target_lang ≠ 'zh' 时,所有 *_zh 字段改为 *_<lang>,内容按 <lang> 翻译。v1 默认 'zh',i18n 留口子。
```

成本估算:50 paper × ~544 token × pro 单价 ≈ **¥0.001 / 条 × 50 / 天 × 30 天 = ¥1.5 / 月** 增量。

> ⚠️ **OPS 2026-05-18 verify 校准**:deepseek-v4-pro 是 reasoning model,**每次调用有 reasoning_tokens 额外开销**(测试一次 reasoning 占 completion 的 93%)。¥1.5/月 是 happy path 估算,**实际可能 1.5-3 倍**(走 deep_analysis 长 prompt + 长 reasoning 时)。
>
> **跑批校准协议**:Phase 3 单条端到端验证完后,Phase 4 backfill 第一轮**先跑 10 条采样**,看实际 `total_tokens` 均值。如果月度成本估算 > ¥10 → 上 budget alert(`pushDeerAlert` 触发);< ¥10 维持现状,当前 ¥205 余额仍 ≥ 1 年安全。

### 5.2 ar5iv 全文段落级翻译 prompt

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
  ↓ for each paper in 50:
     ↓ extra.<hint>:hasGhRepo / hasProjectPage 信号位
     ↓ INSERT items stub(id=hf:<arxiv_id>,is_relevant=1 直接定,_zh / deep_analysis 字段空)
     ↓ trigger HF_PAPER_PIPELINE_WORKFLOW.create({arxiv_id, signals, lang: 'zh'})
                ↓
Phase 2 workflow(每 paper 1 instance,异步并行)
  Step 0: refresh paper detail(防中途删/改)
  Step 1 fan-out:
    - backfill media → R2(thumbnail + submitter avatar 全量)
    - refresh GH star(若 hasGhRepo)
    - fetch ar5iv 全文(必跑)
  Step 2: 翻译 ar5iv 段落(若 step 1 抓到)
  Step 3: translate + deep_analysis 合并 1 次 DeepSeek pro JSON Mode 调用
  Step 4: 完整性 gate(写 workflow_completed_at)
                ↓
[/api/items filter] 只展示 workflow_completed_at IS NOT NULL 的 item
[Dashboard] feed 渲染 HfPaperCard / drawer 渲染 HfPaperDrawerBody
                ↓
[Phase 8 通知] ctx.waitUntil(notifyCronSummary('HF Daily Papers fetch', stats))
              → PushDeer 推 fetch summary + workflow 24h 完成度
```

---

## 8. 与已有源的差异点

| 维度 | HF Paper 与其他源差异 |
|------|---------------------|
| LLM judge | **不需要**(HF Daily 已策展,默认 `is_relevant=1`)|
| 翻译合并调用 | 省 classify,但加 deep_analysis 8 维度,合并到 1 次 pro 调用 |
| LLM 模型 | **唯一用 pro 的源**(其他源全 flash)— 因 deep_analysis 需要推理 |
| 媒体迁移 | thumbnail + avatar 全量迁(类似 PH),都过 `/img` + R2 |
| 关联字段 | 简单(github_repo / project_page),无嵌套关系(不像 X 的 quote/reply)|
| 长内容拉取 | ar5iv HTML **v1 必含**(不像 GH 长 README 是 lazy)|
| 完整性 gate | translate + deep_analysis 都成才算完整 |
| 跑批节奏 | daily(1 次/天),最慢的源 |
| 排序 | `paper.upvotes` desc(HF 自己的热度排序)|
| 通知 | Phase 8 标准模式,1 次/天 cron summary 推 PushDeer |
| 数据 metric | 比其他源轻量:upvotes / num_comments / github_stars 三个 |

---

## 9. Phase 拆分(实施计划)

### Phase 0:设计 + Mockup(进行中,~2 天)

- [x] BE 决策矩阵 + 数据源 API verify(本文档)
- [x] BE 字段初稿(items.extra schema + deep_analysis JSON,§3)
- [x] BE 真实数据 sample(`docs/plans/_research/2026-05-18-hf-daily-papers-sample/`)
- [x] BE FE handoff 文档(`docs/plans/2026-05-18-hf-daily-papers-frontend-handoff.md`)
- [x] SOP 加 Phase 8(`docs/source-integration-sop.md`)
- [ ] FE mockup 三件套(卡片 + drawer + 海报,FE ETA 1.5-2 天)
- [ ] PM 确认 mockup → 启动 Phase 1

### Phase 1:Schema + 配置(0.5 天)

- [ ] OPS 加 staging HF_READ secret(从 prod copy)
- [ ] OPS verify DeepSeek v4-pro 月度配额(估 ¥1.5/月 增量)
- [ ] `worker/src/schema.sql` 加 `metrics_snapshots_hf_paper`
- [ ] `dashboard/src/types.ts` 加 `SourceType 'hf_paper'`
- [ ] `App.tsx` 加 `SOURCE_COLUMNS` + `FILTER_CHIPS`
- [ ] `wrangler.toml` 加 `HF_PAPER_PIPELINE_WORKFLOW` binding(top-level + env.staging)
- [ ] `worker/src/img.ts` `PROXY_HOSTS` 加 `cdn-avatars.huggingface.co` / `cdn-thumbnails.huggingface.co`(或更宽 `*.huggingface.co`)
- [ ] D1 migrate(prod + staging)

### Phase 2:fetch handler(1 天)

- [ ] `worker/src/hf-paper.ts` `runHfDailyFetch`
- [ ] scheduled handler 加 daily slot(`hour=0` UTC = BJT 08:00)
- [ ] INSERT stub + `triggerHfPaperWorkflowForItem`(带 hour-bucket suffix)
- [ ] dry-run / `--limit 5` 验证

### Phase 3:Workflow 实现(2 天)

- [ ] `worker/src/workflows/hf-paper-pipeline.ts`
- [ ] `worker/src/hf-paper/refresh-paper-detail.ts`(step 0)
- [ ] `worker/src/hf-paper/backfill-media-r2.ts`(step 1)
- [ ] `worker/src/hf-paper/refresh-gh-star.ts`(step 1)
- [ ] `worker/src/hf-paper/fetch-ar5iv.ts`(step 1)— ar5iv HTML 抓 + 段落解析存 R2
- [ ] `worker/src/hf-paper/translate-ar5iv.ts`(step 2)— 段落级 flash 批量翻译
- [ ] `worker/src/hf-paper/translate-deep-analyze.ts`(step 3)— pro JSON Mode
- [ ] 单条端到端 `wrangler dev` 跑通

### Phase 4:跑批入口(0.5 天)

- [ ] `/api/enrich/run?mode=backfill-hf-paper-workflow` Bearer endpoint(SOP §1.6 模板)
- [ ] scheduled handler 加兜底 cron slot(可选,`minute=20/50` 每 30min,limit=20 / throttle=3s)

### Phase 5:Dashboard UI(2 天)

- [ ] `HfPaperCard.tsx`
- [ ] `HfPaperDrawerBody.tsx`(9 段)
- [ ] `IconHfPaper`(HF 🤗 logo 简化 SVG,严禁直接用 emoji)
- [ ] `Feed.tsx` 路由 `source_type === 'hf_paper'`
- [ ] `TweetDrawer.tsx` 路由 `isHfPaper`
- [ ] `/h/:arxiv_id` URL routing
- [ ] 分享海报 SVG 模板加 `renderHfPaperContent`(`worker/src/share/svg-template.ts`)

### Phase 6:R2 资源迁移(含在 Phase 3,不单独)

- thumbnail + avatar 走现有 R2 bucket `xlist-readme-assets/hf/<sha>.<ext>`
- 复用 GH 的 `r2-migrate` helper(白名单 mime + 5MB cap + 跳 `/r/` 已迁路径)
- ar5iv 段落 JSON 存 `xlist-readme-assets/hf-paper-ar5iv/<arxiv_id>.json`(独立 prefix)

### Phase 7:真机验收 + operations.md(0.5 天)

- iOS Safari + 微信 WebView 验收
- 安卓走 `ai-feeds.com` main 自定义域
- mobile golden path 同 SOP §3 Phase 7
- `docs/operations.md` 加:
  - cron schedule(`hour=0 UTC`)
  - D1 表 `metrics_snapshots_hf_paper`
  - R2 key 前缀 `hf/` + `hf-paper-ar5iv/`
  - workflow binding `HF_PAPER_PIPELINE_WORKFLOW`
  - LLM 成本估算(`deepseek-v4-pro` ¥1.5/月 增量)
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
- 验证 prod 第一轮 cron 跑完 PushDeer 收到通知

**总估时:~9 天**(BE 7 + FE 3 并行,FE 提前出 mockup 不卡 BE)

---

## 10. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| DeepSeek pro 配额不够 | 低 | 中 | OPS 已 verify(2026-05-18,余额 ¥205 ≥ 1 年安全) |
| pro reasoning_tokens 实际成本 1.5-3 倍 | 中 | 低 | Phase 4 第一轮跑 10 条采样校准实际 `total_tokens` 均值;月度估算 > ¥10 上 `pushDeerAlert` budget alert |
| HF API rate limit | 低 | 低 | 1 次/天 × 50 detail,远低于 limit |
| ar5iv 抓不到(新论文未 mirror) | 中 | 低 | step 1 fail-safe,返 null 不阻断 workflow,后续 cron 重试 |
| HF Daily 内容偶发非 AI(误策展) | 极低 | 低 | 默认 `is_relevant=1`,管理员看到误判 UI 加 hide 按钮(v2) |
| deep_analysis JSON 校验失败 | 中 | 中 | JSON Mode + retry 1 次 + 标 `deep_analysis_failed_at`,`/api/items` filter 排除 |
| novelty_rating 偏差大 | 中 | 低 | 跑 1 周后人工校准 prompt 评分参考;UI 标"AI 评分,仅供参考" |
| HF avatar / thumbnail 域名变 | 低 | 中 | `PROXY_HOSTS` 加 wildcard `*.huggingface.co` |
| ar5iv 全文超长(>1MB)爆 D1 行 | 中 | 中 | 选项 B:存 R2 `hf-paper-ar5iv/<arxiv_id>.json`,extra 只记 `ar5iv_paragraphs_count` |
| HF Daily 改版导致 listing schema 变 | 低 | 高 | fetch handler 加 fail-safe(缺字段 log + 保留可用部分);`pushDeerAlert` 告警 |

---

## 11. OPS 接触点(✅ 2026-05-18 全部 verify)

- [x] **staging HF_READ secret**:`.secrets/aifeeds-staging.env` 追加 HF_READ(从 prod copy,len=37),`wrangler secret put HF_READ --env staging` 推送成功到 `xlist-api-staging` worker。`wrangler secret list --env staging` 确认在列。
- [x] **DeepSeek v4-pro 配额**:可调,model `deepseek-v4-pro` 返 chat.completion 正常。**⚠️ 注意**:pro 是 reasoning model,reasoning_tokens 开销显著(测试 reasoning 占 completion 93%)。¥1.5/月 happy path 估算实际可能 1.5-3 倍。Phase 4 第一轮跑 10 条采样校准。当前余额 ¥205 ≥ 1 年安全。
- [x] **PUSHDEER_ADMIN_KEYS**:已用于 cron summary 通知,2 个 admin token 各推一条 preflight 测试,返 `{"code":0,"counts":1,"success":"ok"}`,送达确认。

---

## 12. FE 接触点(已发,confirmed ETA 1.5-2 天)

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
- **三件套要求**:feed 卡片 + drawer + 1080×1350 海报
- **chipColor**:`#ffd9a8`(暖橙色)

---

## 13. 参考

- SOP:[docs/source-integration-sop.md](../source-integration-sop.md)
- 前端规范:[docs/frontend-ux-guidelines.md](../frontend-ux-guidelines.md)
- 历史源设计:[2026-05-01-github-trending-source-design.md](2026-05-01-github-trending-source-design.md) / [2026-05-11-ph-graphql-cf-cron-design.md](2026-05-11-ph-graphql-cf-cron-design.md)
- 海报模板:`worker/src/share/svg-template.ts`
- notifier:`worker/src/notifier.ts`
- X workflow 参考实现:`worker/src/workflows/x-tweet-pipeline.ts`
