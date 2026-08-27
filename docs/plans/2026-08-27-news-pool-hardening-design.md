# 行业要闻候选池漏报与自愈加固设计

日期：2026-08-27
分支：`cdx/aifeeds-news-pool-hardening`
基线：`bb5af92c442e1f6211d486d1424c96077ac06d1d`

## 目标

解决 2026-08-27 候选池漏掉 GLM-5.3 Flash 的跨天误去重，并提高官方模型发布的发现覆盖与 blog/podcast 工作流失败后的自动恢复能力。

## 已确认根因

1. GLM-5.3 Flash 已在 02:21 BJT 完成入库加工，但 07:51 候选池生成前被跨天事件去重删除。历史 GLM-5.3/PhanRouter 条目没有结构化事件指纹，系统退化到关键词相似度，误把不同型号变体/发布事件视为同一事件。
2. Anthropic 当前依赖第三方 RSS 桥；Fable 5.1 昨晚没有新记录进入数据库。公开信息仍属未确认灰度/传闻，不应直接变成正式要闻。
3. 2026-08-20 的 Fable 相关文章停在 `workflow_completed_at IS NULL`，blog/podcast 的 stuck backfill 只有手工入口；即时 Workflow 创建失败也不会稳定进入自动重试队列。

## 资产、信任边界与失败路径

资产包括每日候选池、跨天推送账本、官方/媒体来源身份、事件指纹、Workflow 完成状态与人工审核池。

信任边界：官方页面或官方模型仓库可作为一手来源；第三方媒体可作为报道来源；社交平台、热搜和用户线索均是不可信 radar 数据，必须经过核验，不能自动进入正式候选。

主要失败路径：

- 历史条目缺指纹时，泛关键词把新型号误并入旧事件。
- 第三方 RSS 桥停更或延迟，官方消息未及时入库。
- Workflow 创建失败、实例卡死或完整性 gate 未完成，条目永久停留在半成品。
- 自动重试无边界造成重复实例、成本放大或告警轰炸。
- radar 数据绕过核验进入正式要闻。

## 必须保持的不变量

- 同一真实事件的跨源、跨天复述仍须去重。
- 新型号、明确变体或不同发布阶段不得仅因共享厂商/家族/版本词而被删除。
- 单边存在高置信结构化指纹时，只有非结构化一侧也能证明完整对象与动作兼容才允许跨天抑制；不确定时保留进入评分。
- `editorial_type=radar` 永远不参与正式候选池、日报视频或自动推送。
- X 继续不直接进入日报视频；本次不把 Fable 5.1 传闻强塞进正式新闻。
- 自动重试必须有延迟、次数上限、幂等实例和可观测终态；完成后清理 pending 状态。
- 不改变现有新闻评分权重、人工排序优先级和 DeepSeek editorial review 契约。

## 方案

### 1. 事件去重

在 `sameNewsEvent` 的单边结构化指纹路径增加 fail-open 守卫：高置信一侧携带明确 `object_variant`/`object_version`/完整对象时，非结构化一侧若不能覆盖该具体对象，不得用普通 token 相似度判为同事件。用 GLM-5.3/PhanRouter 与 GLM-5.3 Flash 生产样本作为红测；同时保留“同一 GLM-5.3 Flash 被另一媒体复述”仍去重的对照测试。

### 2. 官方来源覆盖

- Anthropic 保留原 source id/key，但发现方式切到官方 `https://www.anthropic.com/sitemap.xml` 的 `/news/<slug>` 页面，消除第三方 RSS 桥单点。
- Z.ai 官方 blog 没有可枚举索引，公开 sitemap 也未列 blog 条目；增加基于官方 `zai-org` Hugging Face 组织模型列表 API 的一手模型发布发现器。只为首次出现的模型仓库生成 item，后续普通更新时间不生成新事件；详情链接与正文来源均指向官方模型卡。
- 在 item extra 中持久化 `editorial_type`，正式候选 SQL 明确排除 `radar`。

### 3. blog/podcast 自愈

- Workflow binding 缺失或 create 失败时写 `pending_workflow=1`、错误码与失败时间。
- 独立 cron action 定期扫描至少 30 分钟未完成的 blog/podcast，按小时 bucket 重新触发。
- 每条最多自动重试 6 次；达到上限后停止重试并产生一次去重告警。
- 成功创建/已存在时清 pending，终态完成函数同时清 pending 与临时错误。
- 回填返回 found/triggered/failed/exhausted/oldest_age，进入 cron run 记录。

## 排除项

- 不自动把任意 X 帖转成正式新闻或自动确认的人工线索。
- 不为 Fable 5.1 制造“已发布”事实。
- 不调整候选评分权重、日报数量或下游视频生成逻辑。
- 不做全历史事件指纹大规模在线回填；现有运维回填通道继续保留。

## 验收

- GLM 生产样本红测先失败，修复后保留 GLM-5.3 Flash。
- 同一型号同一动作的跨源重复仍被过滤。
- Anthropic 官方 sitemap fixture 能发现 `/news/*` 且排除其他页面。
- Z.ai 官方模型 fixture 只生成首次出现的模型条目。
- radar 条目不出现在 `selectNewsByScoreWithAudit`。
- 即时触发失败进入 pending；30 分钟前不重试；达到上限不再触发；成功终态清理状态。
- focused、受影响模块、TypeScript、全量 Vitest、diff/gitleaks 全通过；独立 reviewer 无阻断 finding。
