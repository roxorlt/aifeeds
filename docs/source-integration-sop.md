# 信息源接入 SOP

> 验证于 X List + GitHub + Product Hunt + ClawHub + 活动行 五个源接入。**2026-05-17 大改:全部源迁 CF Workflow,SOP 同步重写**(此前老版 cron 抢占模式见 git 历史)。
>
> 接下来 YouTube / Podcast / arXiv 走这套路径,目标 80% 复用 + 20% 源特异性。

## 0. TL;DR Checklist(每个新源照做)

```
□ Phase 0  设计文档 + HTML mockup(feed 卡片 + drawer + 分享海报三件套,用户确认后再写代码)
□ Phase 1  Schema 增量(items.source_type 枚举 + metrics_snapshots_<src> + event 白名单)
□ Phase 2  拉取阶段(cron 抢占式 list-fetch,只写 stub row + 立即 trigger workflow)
□ Phase 3  CF Workflow 设计 + 实现(step 0 数据补全 → step 1 关联回填 fan-out
            → step 2 长内容 → step 3 classify+translate 合并 1 次 → step 4 完整性 gate)
□ Phase 4  跑批入口(/api/enrich/run?mode=backfill-<src>-workflow Bearer endpoint
            + scheduled handler 加兜底 cron slot)
□ Phase 5  Dashboard 渲染(<Src>Card + <Src>DrawerBody + SourceIcon + 在 Feed/Drawer 注册)
□ Phase 6  R2 资源迁移(如有图/视频,放进 workflow 内某个 step)
□ Phase 7  真机验收 + operations.md 同步更新
```

## 1. 已搭好的复用资产(不要重建)

### 1.1 Schema(worker/src/schema.sql)

- **`items` 大一统**:所有源共用一张表。共通字段 `id / source_type / source_id / title / content / author / handle / created_at / metrics(JSON) / media(JSON) / scraped_at / extra(JSON) / lang / is_relevant / content_translated / translation_quality / translation_attempts / translated_at / tier / next_refresh_at / last_velocity / deleted_at`
- **源特异字段进 `extra` JSON**:例:GH 用 `daily_rank / readme_excerpt / readme_translated / contributors_inline / license_spdx / default_branch / r2_migrated_at`;X 用 `quote_of / reply_of / retweet_of / link_card / longform / workflow_triggered_at / workflow_completed_at / media_backfilled_at / link_card_backfilled_at / nested_x_quote_backfilled_at / classified_at / ai_summary / translation_failed_at` 等
- **时间序列指标分表**:`metrics_snapshots_<src>`(gh + clawhub 已建)。每个源若需要追踪历史指标(star / view / install 等)就建一个,schema:`item_id / captured_at + source-specific 数值列`,默认 30 天 retention

### 1.2 Worker(worker/src/)

- **`scheduled()` cron `*/5`**:现在主要跑两类工作
  - **Phase 1 拉取**(refresh-metrics / list-poll-ingest / github-fetch / ph-daily-fetch / clawhub-fetch / hdx-fetch 等)— 拉数据写 stub row + trigger workflow
  - **Phase 5 兜底 backfill cron**(minute=10/40 跑 backfill-x-workflow,minute=15/45 跑 backfill-truncated 等)— 扫 stuck items 重 trigger workflow
- **CF Workflow bindings**(wrangler.toml)
  - `X_TWEET_PIPELINE_WORKFLOW` / `GITHUB_PIPELINE_WORKFLOW` / `PH_PIPELINE_WORKFLOW` / `CH_PIPELINE_WORKFLOW` / `HUODONGXING_DETAIL_WORKFLOW`
  - 每个源 1 个 workflow,内部 step 异步并行 enrich
- **endpoint 复用**
  - `GET /api/items` 通用,按 `source_type` 过滤,cursor 分页,sort=hot|time
  - `GET /api/items/:id` drawer 详情(含 metrics_history + thread siblings)
  - `POST /api/items/:id/refresh` drawer 打开时 on-demand enrich(workflow trigger)
  - `POST /api/items/:id/translate-now` cookie auth + 限流,即时翻译触发(批 1.5 加的)
  - `POST /api/enrich/run` Bearer auth,跑批入口(每个源都有 mode=backfill-<src>-workflow)
  - `/r/<key>` R2 资源代理(GET / HEAD),`Cache-Control: public, max-age=31536000, immutable`
  - `/img` cf.image transform 反代(自动 webp/avif 压缩 + R2 缓存)
  - `/api/track` 埋点(白名单见 `worker/src/track.ts`)

### 1.3 数据流模式(Phase 1 拉取 + Phase 2 workflow enrich)

```
Phase 1(cron 抢占式 list-fetch)
[Source]
  ↓ fetch(HTML / API / RSS / syndication)
  ↓ parse to canonical Item shape(基础字段 + extra.<hint> 信号位)
  ↓ INSERT items(stub row,is_relevant=NULL + 大部分 enrich 字段空)
  ↓ trigger <SRC>_WORKFLOW.create({ id, params })
              ↓
Phase 2(workflow 异步 enrich)
  step 0:数据补全(syndication 拉完整 content / mediaDetails 等)
  step 1 fan-out 并行:
    - backfill 关联字段(quote_of / reply_of / retweet_of 等,按 hasXxxRef 信号 conditional)
    - backfill 媒体(无条件,标 media_backfilled_at 防重)
    - backfill 外链卡片(scan content t.co URL + OG meta 抓取)
    - 嵌入式特殊 URL 处理(scan content x.com URL → 提取 status_id 当 quote)
    - 检测长内容标记(longform note / readme 长文 等)
  step 2:条件性长内容拉取(如 step 1 检测到)
  step 3:classify + translate 合并 1 次 DeepSeek JSON Mode 调用
          (返回 is_relevant + 6 个 _zh 字段,失败 retry 1 次 + 标 translation_failed_at)
  step 4:完整性 gate — 全部 step 完成 → 写 extra.workflow_completed_at 时间戳
```

**关键设计原则**:
- **Phase 1 拉取尽量快**(只 INSERT stub + trigger,不等 enrich)— cron tick 预算保住
- **Phase 2 workflow 异步并行**(step 内 fan-out)— 总耗时 = 最慢 step 时间,不是所有 step 串行
- **classify + translate 合并 1 次 DeepSeek 调用**(批 1 重构)— 比 7 次单字段调用降本 ~87%
- **完整性 gate**(`workflow_completed_at`)— `/api/items` SQL filter 只展示完整数据,避免 user 看到半成品

### 1.4 Workflow 设计模板(参考 worker/src/workflows/x-tweet-pipeline.ts)

```typescript
import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

const RETRY = {
  retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
  timeout: '5 minutes',
} as const;

export class XxxPipelineWorkflow extends WorkflowEntrypoint<Env, XxxParams> {
  async run(event: WorkflowEvent<XxxParams>, step: WorkflowStep) {
    const { itemId, hasFooRef, hasBarRef, lang } = event.payload;

    // Step 0:数据补全(同步必跑)
    await step.do('backfill-truncated-content', RETRY, () =>
      backfillTruncatedContentForXxx(this.env, itemId),
    );

    // Step 1:fan-out 并行(每个 step.do 独立 RETRY)
    const [, , , , longform] = await Promise.all([
      hasFooRef
        ? step.do('backfill-foo', RETRY, () => backfillFooForXxx(this.env, itemId))
        : Promise.resolve(null),
      hasBarRef
        ? step.do('backfill-bar', RETRY, () => backfillBarForXxx(this.env, itemId))
        : Promise.resolve(null),
      step.do('backfill-media', RETRY, () => backfillMediaForXxx(this.env, itemId)),
      step.do('backfill-link-card', RETRY, () => backfillLinkCardForXxx(this.env, itemId)),
      step.do('check-longform', RETRY, () => checkLongformForXxx(this.env, itemId)),
    ]);

    // Step 2:条件性长内容
    if (longform?.is_longform) {
      await step.do('fetch-longform', RETRY, () => fetchLongformForXxx(this.env, itemId));
    }

    // Step 3:classify + translate 合并 1 次调用
    const classifyTrans = await step.do('classify-translate', RETRY, () =>
      classifyAndTranslateForXxx(this.env, itemId, { lang }),
    );

    // Step 4:完整性 gate(失败时不写,/api/items filter 排除)
    if (!classifyTrans.failed) {
      const nowIso = new Date().toISOString();
      await step.do('mark-completed', RETRY, async () => {
        await this.env.DB.prepare(
          `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.workflow_completed_at', ?)
            WHERE id = ?`,
        ).bind(nowIso, itemId).run();
      });
    }

    return {
      itemId,
      is_relevant: classifyTrans.is_relevant,
      completed: !classifyTrans.failed,
    };
  }
}
```

### 1.5 Workflow trigger 模式

```typescript
export async function triggerXxxWorkflowForItem(
  env: { DB: D1Database; XXX_PIPELINE_WORKFLOW?: Workflow },
  itemId: string,
  signals: { hasFooRef: boolean; hasBarRef: boolean; ... },
): Promise<'triggered' | 'already_exists' | 'binding_missing' | 'failed'> {
  if (!env.XXX_PIPELINE_WORKFLOW) return 'binding_missing';
  const nowUnix = Math.floor(Date.now() / 1000);

  // 写 marker 防 30min 内重复 trigger
  try {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.workflow_triggered_at', ?) WHERE id = ?`,
    ).bind(nowUnix, itemId).run();
  } catch (e) { /* ignore */ }

  // ⚠️ instance ID 必须加 hour-bucket suffix,防 stuck instance 永远阻塞
  // (老的 deterministic ID 一旦 stuck,CF Workflows 同 ID 再 create 返 already_exists,
  // 旧代码永远不被新 deploy 替换 — 2026-05-17 N fix)
  const hourBucket = new Date().toISOString().slice(0, 13).replace('T', '-'); // "2026-05-17-15"
  const instanceId = `xxx-${itemId.replace(/[^a-zA-Z0-9-]/g, '-')}-${hourBucket}`;

  try {
    await env.XXX_PIPELINE_WORKFLOW.create({
      id: instanceId,
      params: { itemId, ...signals, lang: 'zh' as const },
    });
    return 'triggered';
  } catch (e) {
    if (String(e).toLowerCase().includes('already exists')) return 'already_exists';
    return 'failed';
  }
}
```

### 1.6 Backfill endpoint 模式

每个源都该有 backfill endpoint(让老数据 + stuck items 重新走 workflow):

```typescript
if (mode === 'backfill-xxx-workflow') {
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 200);
  const throttleMs = Math.max(parseInt(url.searchParams.get('throttle_ms') || '5000'), 0);
  if (!env.XXX_PIPELINE_WORKFLOW) {
    return jsonResponse({ error: 'workflow binding missing' }, 500, request, env);
  }
  const t0 = Date.now();
  // 扫 stuck items:未 workflow_completed + 30min 内未 trigger
  const pending = await env.DB.prepare(
    `SELECT id, extra FROM items
      WHERE source_type='xxx'
        AND deleted_at IS NULL
        AND json_extract(extra, '$.workflow_completed_at') IS NULL
        AND (
          json_extract(extra, '$.workflow_triggered_at') IS NULL
          OR CAST(json_extract(extra, '$.workflow_triggered_at') AS INTEGER) < strftime('%s','now','-30 minutes')
        )
      ORDER BY
        -- 优先 stuck 类型(retweet_pending / quote_pending 等)
        (CASE WHEN ... THEN 0 WHEN ... THEN 1 ELSE 9 END),
        published_at DESC
      LIMIT ?`,
  ).bind(limit).all<{ id: string; extra: string | null }>();

  let triggered = 0, skipped = 0, failed = 0;
  for (const [i, r] of pending.results.entries()) {
    const extra = r.extra ? JSON.parse(r.extra) : {};
    const signals = {
      hasFooRef: !!(extra.foo_id || extra.foo),
      hasBarRef: !!(extra.bar_id || extra.bar),
    };
    const result = await triggerXxxWorkflowForItem(env, r.id, signals);
    if (result === 'triggered') triggered++;
    else if (result === 'already_exists') skipped++;
    else failed++;
    if (throttleMs > 0 && i < pending.results.length - 1) {
      await new Promise((r) => setTimeout(r, throttleMs));
    }
  }

  return jsonResponse({
    mode: 'backfill-xxx-workflow', found: pending.results.length,
    triggered, skipped, failed, elapsed_ms: Date.now() - t0,
  }, 200, request, env);
}
```

**搭配兜底 cron**(scheduled handler 加 slot):

```typescript
const isXxxBackfillSlot = minute === 10 || minute === 40; // 30min cadence
if (isXxxBackfillSlot) {
  // inline 复制 endpoint 逻辑(不抽 helper 保持 simple)+ limit 较小
  // ... 跟 endpoint 同 SQL + trigger 逻辑,limit=20-50
}
```

**OPS 跑批模式**(持续 forever loop):

```bash
while true; do
  source /Users/.../aifeeds-prod.env 2>/dev/null
  RES=$(curl -s --max-time 600 -X POST -H "Authorization: Bearer $INGEST_TOKEN" \
    -H "X-Dev-Token: $DEV_TOKEN" -A "Mozilla/5.0" \
    "https://api.ai-feeds.com/api/enrich/run?mode=backfill-xxx-workflow&limit=200&throttle_ms=300")
  FOUND=$(echo "$RES" | grep -oE '"found":[0-9]+' | head -1 | grep -oE '[0-9]+')
  if [ -z "$FOUND" ]; then echo "网络空,sleep 30 retry"; sleep 30; continue; fi
  echo "$(date +%H:%M:%S) found=$FOUND"
  if [ "$FOUND" -lt 5 ]; then echo "暂无新,sleep 5min"; sleep 300; continue; fi
  sleep 3
done &
```

⚠️ 注意:**不要写 `if [ "$FOUND" -lt 5 ]; then break`** — curl 返空时 FOUND 也空,会误 break。要 retry,真正 found 长期 < 5 才考虑停。

### 1.7 Dashboard 复用

- **Feed.tsx**:通用列容器。PC 多列 + 移动单列(chip 切换)。**已经支持任意 source_type**
- **TweetDrawer.tsx**:通用抽屉。已包含 swipe-to-close、双击回顶、动态 title、移动手势分区、scroll-trap 修复
- **Lightbox.tsx**:图片浏览组件(注意 close 蒙层必须 `stopPropagation` 防点击穿透)
- **GithubDrawerBody.tsx**:参考实现 — markdown 渲染 + R2 资源 resolve + lightbox 集成
- **GithubCard.tsx**:参考实现 — feed 单条卡片
- **SourceIcon.tsx**:每个源加一个 SVG icon(用 lucide-react 同款,严禁 emoji)
- **link_card 渲染逻辑**:FE 现有支持 `image_url` + 新加 `video_url`(有值时用视频组件)

### 1.8 移动端兼容性已踩过的坑(不要再撞)

- iOS Safari `touch-action: pan-x/pan-y` **不可靠**(WebKit 133112),用 JS imperative + `[data-no-page-scroll]` 兜底
- iOS WeChat WebView 的 fetch **抖动严重**:apiFetch 已加 5s AbortController × 3 attempts + 200/600ms backoff
- Tailwind v4 / Vite 8 默认目标 Chrome 111+,安卓 WeChat WebView (TBS) 通常 Chrome 86-90 — **国内用户走 main 自定义域**(ai-feeds.com),preview *.pages.dev 在国内被卡,**只能 iOS 验收**
- README 图片包链接(`[![img](src)](url)`)渲染成 `<a><img/></a>`,img onClick 必须 `e.preventDefault()` 阻止 universal link 跳出
- IntersectionObserver 触发的 loadMore 失败要加 cooldown 阈值
- 图片大图蒙层 close 必须 `e.stopPropagation()`,防穿透点击到下层卡片打开抽屉

### 1.9 Telemetry

新增 event 类型必须 **三处同步**,否则 worker 丢弃:

1. `dashboard/src/lib/telemetry/event-types.ts`(EVENTS 常量 + 类型 union)
2. `dashboard/src/lib/telemetry/types.ts`(EventTypeName union)
3. `worker/src/track.ts`(`EVENT_TYPE_WHITELIST` Set)

已有事件复用:`item_open_drawer / item_close_drawer / external_link_click / share_click / feed_load_error / api_error / image_load_error / item_impression`

## 2. 每个新源的决策矩阵(先填这张表再动手)

| 维度 | 问题 | 例:GH |
|------|------|--------|
| 数据来源 | API / HTML / RSS / 第三方?需要 cookie / token / IP? | trending HTML + REST API |
| 拉取频率 | cron 频率 + 每次预算多少 subreq? | 每天 1:00 / 13:00(CST)|
| Item 映射 | source_id / title / content / created_at / author 都来自哪? | repo full_name / repo full_name / readme / first push / owner |
| extra 字段 | 哪些源特异字段必存(进 extra JSON)? | readme_excerpt / category / daily_rank / license / contributors |
| 指标 | 哪些值得追时间序列? | total_stars / today_stars / forks / watchers / open_issues / open_prs |
| Workflow step | 该源 workflow 需要几个 step?有哪些 enrich 函数? | classify / r2-migrate-readme / readme-translate |
| 关联字段 | 是否有需要二次拉取的字段(quote / reply / referenced_repo)? | 一般无,readme 内嵌资源走 R2 |
| 媒体字段 | 是否有图/视频/封面?是否迁 R2? | readme 内 raw.githubusercontent.com 图迁 R2 |
| LLM judge | "AI 相关"对该源怎么定义?输出哪些字段? | is_ai + category + ai_summary |
| 翻译 | 哪些字段翻译?eager / lazy? | readme excerpt + summary eager,readme 全文 lazy |
| 完整性 gate | 什么条件算"完整"(可写 workflow_completed_at)? | classify done + readme_translated done(若 lang!=zh) |
| Card 布局 | feed 卡片横向布局?需要 hero image?metadata 用什么 icon? | 见 `docs/plans/_mockups/` |
| Drawer 内容 | 抽屉里要展示什么? | repo header + summary + readme(markdown 渲染) |
| 排序 | 默认热度 vs 时间?hot 算法? | time desc + daily_rank asc |

## 3. 八个 Phase 详解

### Phase 0:设计 + Mockup(1 天)

1. 用 brainstorming skill 跟用户对齐决策矩阵
2. 写 `docs/plans/YYYY-MM-DD-<src>-source-design.md`,内容必含:
   - 数据源、抓取策略、停止条件
   - schema 增量(items.source_type 新值、是否新建 metrics 表、extra 字段表)
   - **Workflow step 设计**(step 0/1/2/3/4 每个 step 做啥 / hasXxxRef 信号有哪些)
   - LLM prompt 设计(关键句直接抄进文档便于回看)
   - UI 决策:**feed 卡片 + drawer 详情 + 分享海报**(三件套都要画)
   - 与已有源的差异点
3. 生成 HTML mockup(PC + 移动两版,多 variant 让用户挑)放 `docs/plans/_mockups/`,**必须包含**:
   - feed 卡片样式
   - drawer 详情区段
   - **分享海报(1080×1350)排版**(哪些字段进海报、视觉重心、是否带媒体图、CTA 块、品牌区)
4. 用户确认后再开 Phase 1。**不要跳过这一步**

> **为什么分享海报要进 Phase 0**:每个新源都得加 SVG 模板变体到 `worker/src/share/svg-template.ts`,海报跟 feed/drawer 的字段要预先对齐,不然 Phase 5/6 才发现海报缺字段就要倒回去改 schema + scraper。

### Phase 1:Schema(0.5 天)

```bash
# 1. 加新 SourceType
# 修:worker/src/schema.sql + dashboard/src/types.ts

# 2. 如需 metrics 表,加新建语句,并 D1 migrate
npx wrangler d1 execute xlist --remote --file=worker/src/schema.sql

# 3. 如有新 telemetry event,三处同步(见 §1.9)

# 4. App.tsx 把新源加进 SOURCE_COLUMNS + FILTER_CHIPS

# 5. wrangler.toml 加 <SRC>_PIPELINE_WORKFLOW binding(top-level + env.staging)
```

### Phase 2:拉取实现(2-5 天,源决定时长)

**核心原则:Phase 1 拉取只 INSERT stub + trigger workflow,不等 enrich**。

```typescript
// scrapers/<src>.ts 或 worker/src/<src>.ts
export async function runXxxFetch(env: EnrichEnv) {
  // 1. fetch list / API
  const items = await fetchSourceList(env);
  // 2. parse to canonical Item shape
  for (const item of items) {
    const candidate = parseItem(item);
    // 3. INSERT items(只写共通字段 + extra.<hint> 信号位)
    await env.DB.prepare(`INSERT OR IGNORE INTO items ...`).bind(...).run();
    // 4. 立即 trigger workflow(异步 enrich)
    await triggerXxxWorkflowForItem(env, candidate.id, {
      hasFooRef: !!candidate.foo_id,
      hasBarRef: !!candidate.bar_id,
    });
  }
}
```

**复用**:LLM client / DB client / 翻译 helper(已有,scrapers/_shared/ 或 worker/src/lib/)。

**分层验证**:
```
--dry-run → 看 candidate 列表(scraper 本机跑)
--limit 5 → 跑 5 条 INSERT + trigger workflow,看 D1 + workflow 是否对
正常跑 → cron 接上
```

**不要从一开始就追求大批量**。先把单条 happy path 跑通。

### Phase 3:Workflow 设计 + 实现(2-3 天)

**新建** `worker/src/workflows/<src>-pipeline.ts`(参考 1.4 模板)。

**关键决策**(每个 step 都要想):
- **step 0**:必跑同步(数据补全 / 截断修复 / 元信息抓取)
- **step 1 fan-out**:并行 backfill 多个字段。条件性(by hasXxxRef)还是无条件?
- **step 2**:条件性长内容(由 step 1 探测)
- **step 3**:classify + translate 合并(`classifyAndTranslateForXxx`,JSON Mode 1 次调用)
- **step 4**:完整性 gate(写 workflow_completed_at)

**workflow 内部所有 step 都要走 RETRY**(retries 3 + 10s + exponential backoff + 5min timeout)。

**enrich 函数命名约定**:
- `backfillXxxFor<Src>`(回填某字段,如 `backfillMediaForXTweet`)
- `classifyAndTranslateFor<Src>`(合并调用)
- `triggerXxxWorkflowForItem`(trigger workflow,带 hour-bucket suffix)

### Phase 4:跑批入口 + cron 兜底(0.5-1 天)

**1. Bearer endpoint**(`/api/enrich/run?mode=backfill-<src>-workflow`):参考 1.6 模板。

**2. 兜底 cron**(scheduled handler 加 slot):
- minute=10/40 或 minute=5/35,30min cadence
- 每 tick limit=20-50,throttle=2-3s
- 容量 = 48 tick × N = N×48/day,prod 老数据按这速度估完成时间

**3. (可选)translate-now endpoint**(`POST /api/items/:id/translate-now`):
- cookie auth(参考 share/handlers.ts 模式)
- 限流(per-user-per-item 60s 冷却 + 每日 20 次上限,KV-based)
- 单条调 `classifyAndTranslateFor<Src>` 返回 _zh 字段给 FE 实时刷新

### Phase 5:Dashboard UI(2-3 天)

```
src/components/
  <Src>Card.tsx       ← 抄 GithubCard.tsx 改字段
  <Src>DrawerBody.tsx ← 抄 GithubDrawerBody.tsx 改渲染
src/components/icons.tsx
  IconSrc             ← SVG(lucide-react 同款,严禁 emoji)加进 SourceIcon 的 switch
src/components/Feed.tsx
  渲染条件             ← `row.item.source_type === "<src>"` 路由到 <Src>Card
src/components/TweetDrawer.tsx
  渲染条件             ← `isSrc` 路由到 <Src>DrawerBody
```

**FE 渲染要点**:
- 检查 `extra.workflow_completed_at` 决定是否显示 "数据回填中" 占位(可选,prod 默认 filter 已过滤)
- `link_card.video_url` 有值 → 用视频组件,否则用图片
- `media` 字段 type=video 时 → 用 video tag,poster 用 thumbnail

UI 验收用 mockup 做对照,PC + 移动都要测。

### Phase 6:R2 资源迁移(如有,1 天)

放进 workflow 内某个 step(参考 github r2-migrate 实现):
- 解析 item 内 inline media URL(白名单 mime + 5MB cap + 20 资产/item)
- 算 SHA-256 key,PUT 到 R2 bucket
- 更新 item 的 readme_excerpt / extra 里把原 URL 替换成 `/r/<key>`
- 标记 `r2_migrated_at`(防重)
- **跳过 `/r/` 已迁路径**(避免 self-corrupting re-migrate,已踩过)

### Phase 7:真机验收 + operations.md(1 天)

**真机验收**:
- iOS 真机(preview URL OK)
- 安卓 **必须走 main 自定义域**(preview pages.dev 国内不通)
- mobile golden path:
  - 首屏加载 < 2s
  - chip 切换源
  - 卡片点开 drawer
  - drawer 内 swipe back 关
  - drawer 内长内容滚动 + 双击回顶
  - 顶 bar 横划只滚 chips 不滚 feed
- telemetry 检查:`feed_load_error / api_error / item_open_drawer` 都有写入

**operations.md 同步**(强制项,漏掉跨 session 维护就断档):
- 新增 cron / endpoint / workflow binding / 跑频率写进运维表
- 新增 D1 表 + 字段
- 新增 R2 bucket / KV namespace(如有)
- 新增 secrets
- backfill endpoint 跑批方法 + 兜底 cron 节奏

## 4. 故障案例库(踩过的坑)

### 4.1 Workflow instance ID 复用 → 永远不被新代码替换

**现象**:修了 P0 bug + prod deploy,但跑批仍 `triggered=0, skipped=N`(全 already_exists),新代码永远不被老 item 跑到。

**根因**:CF Workflow `create({id: 'prefix-itemId'})` deterministic ID — 老 stuck/completed instance 永远阻塞新 trigger。

**修法**(N fix,2026-05-17):instance ID 加 hour-bucket suffix `prefix-itemId-YYYY-MM-DD-HH`,每小时同 item 可重 trigger 新 instance。

### 4.2 hasXxxRef 信号字段名错(retweet bug)

**现象**:批 1 加了 `backfill-retweet` step,但 prod 跑批后 retweet_of 字段还是空 — workflow 跑了但 backfill-retweet skip。

**根因**:`hasRetweetRef = !!(extraObj.retweet_of_id || extraObj.retweet_of)` — 但 SB scraper ingest 时写的是 `extra.is_retweet=true + extra.retweeted_status_id="..."`,**没有 `retweet_of_id` 字段**!signal 永远 false → workflow 跳过 backfill-retweet。

**修法**:hasXxxRef 信号检查必须覆盖 SB / syndication / 内部 backfill 写的所有可能字段名。参考 X retweet fix:
```typescript
hasRetweetRef: !!(extraObj.is_retweet || extraObj.retweeted_status_id || extraObj.retweet_of_id || extraObj.retweet_of)
```

### 4.3 SB 偶发漏返 mediaDetails → 媒体字段空

**现象**:user 反馈 X 有图片视频但 aifeeds media=[]。

**根因**:SB scraper ingest 时 t.media 是空(SB API 偶发漏返 mediaDetails)。workflow 没有 backfill media 的 step。

**修法**:workflow 加 backfill-media step(`backfillMediaForXTweet`),无条件每条都跑(标 `media_backfilled_at` 防重复),syndication API 二次拉完整 mediaDetails(photo + video mp4)+ 覆盖 D1 media 字段。

### 4.4 嵌入式特殊 URL 没识别(嵌 X 链接当外链处理)

**现象**:推文正文里嵌 `x.com/.../status/(\d+)` URL,X 原页面渲染成 quote tweet preview(完整原推 + 视频),但 aifeeds 当外链处理只抓 OG 截断版。

**根因**:SB ingest 时没 expand t.co → 没识别这种"内嵌 X URL"为 quote → `quote_of_id` 空 → 走外链卡片路径只抓 og:title/description。

**修法**:加 `backfillNestedXQuoteForXTweet` step(scan content 内 x.com URL → 提取 status_id → 写 quote_of_id + inline 调 backfillQuote 拉完整原推数据)。

### 4.5 外链卡片 syndication 不返 → 自己抓 OG meta

**现象**:推文有外链(如 sublimetext.com)但 D1 link_card=null,FE 没法展示 preview card。

**根因**:X 的 syndication API 对纯外链推文返 card=null + entities.urls=[]。

**修法**:加 `backfillLinkCardForXTweet`(扫 content t.co URL → HEAD 跟随跳转 → GET HTML 抓 og:image/title/description → 写 extra.link_card),并加 `og:video / twitter:player` 字段提取(视频站点)。

### 4.6 CF Workers deploy 会压住 cron tick 5-10 分钟

**现象**:看 D1 数据某段时间没新写入,以为 cron 出问题。

**根因**:`wrangler deploy` 期间 CF Workers 会暂停 scheduled events,deploy 窗口 5-10 分钟内 cron 不 fire。连续多次 deploy 会 cascade 跳过多个 tick。

**修法 / 心智**:
1. 排查 cron health 时先排除最近是否有 deploy
2. `wrangler tail` 默认只 capture HTTP requests,**不 capture scheduled events** — 看 cron 状态必须 CF Dashboard → Workers → Logs 看 scheduled invocations
3. 部署节奏建议连续多次 deploy 留 10 分钟间隔

### 4.7 外站 WAF 高并发 403(hdx 例)

**现象**:hdx workflow 大量 errored,instance 详情显示 `HTTP 403`。

**根因**:backfill 高并发 trigger → 多 instance 同时跑 → CF 不同节点 IP 一起打 hdx → hdx WAF 检测异常 → 403。

**修法选项**(择一):
1. 降低 backfill 节奏(限 50 条/30min + throttle 5s)
2. 改走第三方代理(SB / 等)绕过直连
3. 接受部分缺失

### 4.8 Loop break bug:网络返空当"已完成"

**现象**:forever loop 第一轮 curl 失败 → 立刻 break 退出,实际什么都没跑。

**根因**:`if [ -z "$FOUND" ] || [ "$FOUND" -lt 5 ]; then break` — 网络返空 FOUND 也空,触发 break。

**修法**:`-z $FOUND` 时 sleep 30 retry,只有真 found < 5 才考虑 break(或者 sleep 5min continue,保持 forever)。参考 1.6 模板。

## 5. 接入新源前后的横向规则

### A. Reconnaissance 阶段(动手做 mockup 之前必跑)

1. **检查页面是不是 SPA**:curl 拿首页 HTML,grep `__NEXT_DATA__ / __NUXT__ / self.__next_f / $tsr / window.__INITIAL_STATE__` 识别框架。SPA 直接 curl 拿不到数据,但 80% 情况能从 JS bundle 抠到后端 endpoint。
2. **从 footer / `runtimeEnv` chunk 找 backend**:现代 SPA 一般会暴露 `VITE_*_URL`、`NEXT_PUBLIC_*_API` 这种常量。Convex / Supabase / Pocketbase 类后端常见且**默认对外开放只读 API,无鉴权**。
3. **优先尝试官方 REST V1**(如有),其次直接打后端 query 接口(Convex `/api/query`),最后才考虑 HTML 解析。能拿 JSON 不抓 HTML。
4. **审计源站 UI 元素清单**:fetch 一个 detail 页 HTML + 一张 listing 页 HTML,把 sidebar / sort options / category filter / KPI 字段都列全。新源 mockup **必须复刻源站自己强调的字段**。
5. **抓源站实际 icon 库**(grep `lucide-[a-z-]+` / `heroicons-[a-z-]+` / `phosphor-[a-z-]+`),用同款 SVG。**严禁用 emoji 替代真实 icon**。

### B. Schema 设计

1. **`items` 表共通字段不再加列**:每个新源的特有字段全进 `extra` JSON。schema 不应该出现 `<src>_<field>_count` 这种列。
2. **`metrics_snapshots_<src>` 表只放真正需要追时间序列的指标**,单值类 meta(license / version 文本 / comments 计数)放 `items.metrics` 或 `extra` 顶层。30 天 retention 默认。
3. **新源接入第一周不强求 trends 模块**:给 dashboard drawer 留 "30 天趋势" 折叠区段,但 v1 默认隐藏 — **数据点 ≥ 7 + variance > 5%** 才出。冷启动期空线条比没有更差。

### C. LLM judge / 翻译策略分类(按源决定)

| 源类型 | LLM relevance judge | 翻译时机 |
|--------|---------------------|---------|
| 流式新闻(X / 微博 / Twitter)| ★ 必做(噪音多)| eager(workflow step 3)|
| 优选 marketplace(PH / Skill marketplace 等)| ☆ 跳过(默认 is_relevant=1)| eager |
| 长尾发现(GH trending / arXiv)| ★ 必做(trending 含杂)| excerpt eager + 全文 lazy |
| 视频 / 播客 | ★ 必做(转录贵)| excerpt eager + 时间戳 lazy |

**翻译规则统一**:
- classify + translate 合并 1 次 DeepSeek JSON Mode 调用(批 1 模式)
- 代码块原文不译(fenced ``` / inline `code`)
- 翻译 prompt 显式 "preserve all fenced code blocks verbatim"
- 非用户面向的"指令文档"(SKILL.md / system prompt)**不翻**,只展示原文
- terminologies 翻译要专业,避免直译

### D. UI / Mockup 阶段的横向规则

1. **不要发明 hero image 槽位**:除非源站本身把 hero image 当主体(PH 的 product gallery 是;GH / X / Skill marketplace 类都不是)。文字密集的内容直接 text + avatar。
2. **server-side risk tags vs client-side category filter 不要混**:很多 marketplace 同时有「安全风险标签」(server 算)和「内容分类」(前端关键词匹配)。前者放 drawer Safety section,后者放 feed 顶部下拉。
3. **stat label 必须中文化**:drawer 里 "stars / downloads / installs" 改 "星标数 / 下载量 / 安装量"。保留英文标签等于偷懒。
4. **顶部筛选默认 dropdown 优于 chip 排**:分类 ≥ 5 项时 chip 行会折断 / 横滚。两个 native select 是 baseline。空间紧时压缩到 title 同行右侧。
5. **稀有但严重的安全告警才上颜色**:默认安全标签用纯文字行 + amber 文字色;只有高 severity finding 才上 rose ring。
6. **Files manifest 用代码块的目录树渲染**:等宽字体 + ASCII 树字符(├─ └─ │)。
7. **drawer 区段顺序按"用户决策"路径而非按 schema 顺序**:先看是什么 → 安不安全 → 怎么装/用 → 走势如何 → 还有啥 → 走出去。

### E. CF Workers 配额心智(2026-05-17 OPS verify)

- **CF Worker subreq**:Paid plan 1000/invocation cap,**无 monthly cap**(按 request 计费)。不再为"省 subreq"做拆 cron 槽优化。
- **DeepSeek 余额**:稳态月成本 ~¥22/月(合并调用 5→1 次降本 87%),余额 ¥200 撑 8 个月。
- **Workflow 并发**:CF 未公布上限,实测多 instance 并行 OK。
- **外链 fetch 风险**:hdx WAF 类站点高并发会 403。SB / syndication / GitHub API 实测稳定。

### F. ⚠️ 强制规则:mockup + 真实代码都不准用 emoji 做 icon

**错的写法**:

```html
<span>★ 3,479</span>          <!-- 用 emoji ★ 当星标 icon -->
<span>↓ 422k</span>            <!-- 用 ↓ 当下载 icon -->
<span>📦 active</span>         <!-- 用 📦 当 install icon -->
<option>★ 星标</option>        <!-- dropdown option 前缀 emoji -->
<span>⚠️ 风险</span>           <!-- ⚠️ 当 warning icon -->
```

**对的写法**:

```html
<span><svg><use href="#ico-star"/></svg> 3,479</span>
<span><svg><use href="#ico-download"/></svg> 422k</span>
<option>星标</option>
```

**理由**:emoji 跨平台/字体渲染差异大、信息可访问性差、design token 不可控。

**例外白名单**:
- skill 自身 frontmatter 的 emoji 字段(如 ClawHub `clawdis.emoji: "🎮"`),按数据原样渲染
- 用户输入内容(推文 / 评论 / README 正文里的 emoji),按原文渲染
- **任何 UI chrome(导航 / 按钮 / 标签 / 状态指示)必须 SVG**

### G. 分享海报结构(PR5 之后每个新源都要加变体的固化骨架)

**实现位置**:`worker/src/share/svg-template.ts`(共享)+ 每个源新写一个 `renderXxxContent` 函数

**真实海报由顶层 `renderShareSvg` 拼出 3 个区域**(不是 1 个大白卡):
- Hero 区(0..360 高,深色径向渐变 + 紫色 glow + 底部贝塞尔弧线)
- Content 卡(独立 rounded rect,白底 + soft shadow,放 avatar + title + metrics + body)
- Footer 卡(独立 rounded rect,白底,放分享人 + QR 码)

**新源加变体的硬性规则**:

1. **永远只写 content 区**(新增 `renderXxxContent` 函数 + `pickSourceMeta` 加分支),hero / footer 不动
2. content 函数签名抄 `renderGithubContent` 或 `renderPhContent`,改字段不改结构
3. 必须给该源选一个 **chipColor**(hero 右上角"来源 xxx"的强调色),跟现有变体不撞色:
   - X = `#ffffff` (白)
   - GitHub = `#c1f0d8` (mint)
   - Product Hunt = `#ffd1c1` (peach)
   - ClawHub = `#d8c8f5` (lavender)
   - 新源建议从 cyan / yellow / rose 等冷暖系剩余色挑
4. content 区 Body 必须从该源的"primary text"摘段:tweet 全文 / README 首段 / summary / 摘要描述等
5. content 区是否带媒体图(`renderMediaBlock`)由源决定。文字密集型默认无;视觉密集型建议有
6. mockup 必须画三件套(hero + content + footer)等比缩放预览

**复用清单**(不要重写):
- `renderHero(sourceLabel, sourceChipColor)` — 整个 hero 区
- `renderFooter(ctx, x, y, w, h)` — 整个 footer 区
- `renderCardBg(x, y, w, h, rx)` — 卡片底(白底 + shadow filter)
- `renderMediaBlock(...)` — 媒体图块(含 video play overlay)
- `wrapText(text, maxCharsPerLine, maxLines)` — body 文字 wrap
- `formatStat(n)` — 数字千分位 / k/m/b 后缀
- `estimateTextWidth(text, size, weight)` — 自适应字号宽度估算

## 6. 各源建议优先级 + 估时

| 顺序 | 源 | 预估工时 | 主要难点 | 是否需 R2 |
|------|----|---------|---------|----------|
| 1 | YouTube | 4-6 天 | 转录字幕 + LLM 摘要 + 防爬 | 否(YouTube 嵌入即可)|
| 2 | arXiv | 3-5 天 | PDF parse / abstract 抓 + 中译 | 否 |
| 3 | Podcast | 5-7 天 | 转录最贵,可选 Snipd 集成 | 否(音频用原始链接)|
| 4 | RSS 通用 | 2-3 天 | 各种 feed 格式归一 | 否(图片用原链 + cf.image)|

## 7. 反模式(不要做的事)

- ❌ 直接把 source-specific 字段塞 items 顶层列(应进 extra JSON)
- ❌ 每个源独立的 schema 表(重复 80% 字段,难做 cross-source feed)
- ❌ 跳过 mockup 直接写组件(最贵的返工是确定 layout)
- ❌ scraper 一上来就 worker 内跑(subreq 预算紧,先 worker 外验通再迁)
- ❌ 用浏览器 Chrome devtools 模拟 iOS 测移动端(很多手势 / WebKit 行为模拟器没有)
- ❌ 让用户验收 preview 不告诉他「安卓走 main」
- ❌ 增加新 telemetry event 只改 dashboard 不改 worker 白名单
- ❌ Phase 1 拉取阶段做 enrich(应该只 INSERT stub + trigger workflow,enrich 在 Phase 2 workflow 异步跑)
- ❌ Workflow instance ID 用 deterministic 不加 hour-bucket suffix(stuck instance 永远阻塞新代码)
- ❌ hasXxxRef 信号检查只看 enrich 后字段(必须覆盖 SB / syndication 原始字段名)
- ❌ Forever loop `if [ -z $FOUND ]; then break`(网络空当完成,实际什么都没跑)
- ❌ 多源接入靠 LLM 单字段调用(必须合并到 1 次 JSON Mode 调用,降本 87%)
