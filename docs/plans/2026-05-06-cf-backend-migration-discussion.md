---
title: "CF 后端服务整体迁移讨论"
created_at: 2026-05-06
status: discussion
owner: roxor
tags: [cf, migration, workflow, queue, images, analytics, logs]
related:
  - docs/cf-platform-overview.html
  - docs/cf-deep-dive-5-products.html
  - docs/scrapebadger-cost-and-frequency.md
---

# CF 后端服务整体迁移讨论

> **文档定位**：讨论文档，不是 spec / 不是 plan。
> 内容是 CF 平台 5 个产品 × xlist 业务的可行性调研 + 修正后的迁移建议 + 真实业务量评估。
> 进入实施前需要按各功能再起 spec → plan，逐项落地。

---

## 0. 触发动机

xlist 业务后端这半年从单一 Worker `*/5 cron` 演化到现在 **11 个 X cron mode + 4 个 GH cron mode + 1 个 PH 本地 launchd**，多模式靠抢占 slot 串联。已有几个痛点：

- `fill-translations` / `backfill-quotes` / `backfill-replies` 等模式靠 D1 NULL 状态字段做状态机，分支多易乱
- DeepSeek 慢（500ms-3s）时 cron slot 被占满，别的模式饿死
- 一条记录的完整 lifecycle（fetch → classify → translate → enrich → save）目前看不到端到端 trace，挂在哪步只能从字段反推
- 没有 retry 粒度（整个 cron mode 失败 = 整批失败）
- 长推流程（detect → fetch full → translate）跨 3 个 cron mode + D1 NULL 状态，最复杂的链

CF 2024-2025 出了 Queues / Workflows / Images 等产品，加上原本就有的 Web Analytics / Workers Logs，借这次梳理一次性看清「哪些用上 / 哪些不必」，避免之后再东一榔头西一棒槌迁。

---

## 1. 当前业务量 ground truth（D1 实测，2026-05-06）

| 维度 | 真实数据 | 备注 |
|---|---|---|
| X 每天 ingest 入库（is_relevant=0/1 都算） | **261 条/天**（峰 748，谷 30） | 7 天平均，过去用「5000/天」估算是错的，差 20 倍 |
| X is_relevant 通过率 | 67%（25175 通过 / 12101 拒） | 拒的早退占 33% |
| X 长推占比 | 8.3%（152/1830） | 进 longform 链的少数 |
| GitHub 入库总量 | 30 条 | 启动期，量小 |
| Product Hunt 入库总量 | 21 条 | 启动期，量小 |
| Dashboard PV | ~1k/天 estimated | （实际数等 Web Analytics 开了再看） |

**关键修正**：之前所有「Workflow $150/月成本估」基于错估的 5000/天 X，按真实 261/天 重算后，**Workflow / Queue 都能在免费额度内跑**。下面所有计算用 261/天。

---

## 2. 不切的事（明确边界）

避免下面讨论被「都迁去 CF」的诱惑带跑偏：

| 模块 | 不切的理由 |
|---|---|
| `refresh-tiered` | 走 ScrapeBadger **batch endpoint**（`GET /twitter/tweets/?tweets=id1,id2,...,idN`，一次拿 N 条 tweet，计费 N+1 credits），cron + batch 比 Queue 的 chatty 模式划算（每条单 ack 反而贵）。详见 § 7 ScrapeBadger 计费章节 |
| `cleanup`（每日 03:35 清 30d 前 snapshots）| 简单 cron 定时任务，CF 任何高级产品都是 over-engineering |
| 同步 HTTP 交互（auth send/login / share poster / `/api/items/:id/refresh`） | 用户等结果，必须同步返回，切 Queue / Workflow 反而加延迟 |
| 本地 PH scraper（launchd `com.aifeeds.ph-scraper`） | 依赖 browser-use Python，跑在 Mac 本地，CF Workflow 无法直接调 |
| Telemetry events 上报 | 前端已有 batch + sendBeacon，再加层 Queue 价值低 |
| D1 数据归档（events / sms_send_log 等满了） | Logpush 不解决（dataset 不通），用 D1 export → R2 自家方案 |

---

## 3. ScrapeBadger 计费规则（迁移决策依赖项）

完整在 [`docs/scrapebadger-cost-and-frequency.md`](../scrapebadger-cost-and-frequency.md)，这里抽核心：

```
公式：credits = 1 base + 1 × N
N = 响应里 tweet/user 等的条数
单价：$0.15 / 1000 credits（PAYG）
Rate limit：60 req/min
```

两个 endpoint 实际用：

| Endpoint | 用途 | 单 call credits |
|---|---|---|
| `GET /twitter/lists/{id}/tweets?cursor=...` | list-poll-ingest（拉新推文） | ~57（一页 55-56 条 + 1 base） |
| `GET /twitter/tweets/?tweets=id1,id2,...,idN` | refresh-tiered + lazy enrich（按 ID 批量拿）| **N+1**（worker 已 cap 在 ~20 条/call = 21 credits） |

**这就是为什么 refresh-tiered 不切 Queue**：把「一批 100 个 ID 一次拿回」拆成「100 条独立消息每条单查」=  100 个 base × 1 = 多 100 base credit 的浪费 + 每条单消息额外 ack/retry overhead。当前 prod 配置（30min cron）月费 $4.5 refresh + $12.3 list-poll = **$16.8/月**，迁 Queue 反而更贵。

---

## 4. 各产品讨论

### 4.1 Workflows（核心迁移目标）

**定位**：持久执行引擎，每个 step 自动持久化 + retry + 可 sleep 长达 1 年。

**业务匹配场景**：

| 流程 | 当前实现 | 迁 Workflow 后 |
|---|---|---|
| **X 单推文 ingest 完整链** | 4 个 cron mode 异步串联（list-poll-ingest → classify-pending → fill-translations → backfill-quotes/replies），靠 D1 字段（is_ai NULL / translated NULL / quote_of NULL）做状态机 | 1 个 Workflow instance/推文，6 个 step（fetch + classify + check-longform + translate + enrich + save），early exit on is_ai=0 |
| **GitHub trending 完整链** | 4 个 cron mode（github-fetch → enrich → readme-translate → r2-migrate） | 1 个 Workflow instance/repo，4 个 step |
| **Longform 链** | 3 个 cron mode（detect-longform → longform-via-sb → fill-translations）| 整合到 X ingest pipeline，长推走 conditional step（check-longform → fetch-fulltext → translate） |
| **GitHub README 资源迁移到 R2** | github-r2-migrate cron 模式 | Workflow 内一个 step |

**真实预算（按 261/天 X + 1/天 GH + 1/天 PH）**：

```
X step 计算：
  is_ai=1 (67%) 走完 6 step（短推） 或 7 step（长推 8.3%）
    → 平均 6.1 step
  is_ai=0 (33%) 早退 2 step（fetch + classify）
  
  日 step = 261 × 0.67 × 6.1 + 261 × 0.33 × 2 = 1066 + 172 = 1238 step/天
  月 step = 1238 × 30 = 37,140 step/月

GH step = ~1/天 × 4 step × 30 = 120 step/月（启动期，未来扩展再算）
Longform 已计入 X 主链

总月 step = ~37,260
免费额度 = 100,000 step/月
利用率 = 37%
月成本 = $0
```

**收益**：
1. **Trace 可视**：CF Dashboard 直接看每个 instance 走到哪步、为啥失败、stuck 在哪
2. **Retry 内置**：每个 step 独立 retry 配置（`{ retries: { limit: 3, delay: '10s', backoff: 'exponential' } }`）
3. **状态自管**：删掉 D1 里 `is_ai NULL / translated NULL / quote_of NULL / longform_pending` 等状态字段，Workflow 自带 state
4. **Step 间状态传递**：step.do 返回值自动 persist + 跨 step 可读，无需 D1 中转
5. **Conditional flow**：is_ai=0 直接 return（早退算 step 也少），长推 conditional step.do
6. **Long sleep**：`step.sleep('30 minutes')` 等 metrics 稳定再补，不需要写 cron schedule

**成本**：
- 工时：估 3-5 天（GH 链先迁 1 天试水，X 主链 2-3 天，longform 整合到 X 链 1 天）
- 月费：$0（免费额度内）
- 学习曲线：略陡（cloudflare:workers SDK + WorkflowEntrypoint class），但 LLM 友好

**风险**：
- 单实例最长存活 1 年（够用），但 step 数有上限（~10k/instance），不能滥用
- `step.sleep` 期间不收 CPU 时间费，但占 instance 配额（不限并发但有 instance 总量限制）
- 迁移期间双写：旧 cron 模式跟 Workflow 并跑一段，验证 Workflow 数据一致后再下旧模式

### 4.2 Queues（暂缓 / 局部备选）

**定位**：消息队列，producer/consumer 解耦，CF push 模型自动触发 consumer。

**业务匹配场景**：
- ❌ X 主链：量小（261/天）+ 单条要在多 step 间传状态，Workflow 更合适
- ❌ GH 链：同上
- ❌ refresh-tiered：batch endpoint 更划算（前面讲了）
- ❌ 同步交互：auth/poster 不行
- ⚠️ 真有「大量独立任务并发」的场景再用：
  - 未来 newsletter 给 10k 用户群发（PR7）
  - 未来通知推送（push notification fanout）

**预算**：免费额度 1M ops/月，按 261/天 × 3 ops × 30 = 23k/月，**完全用不到**。

**结论**：**先不切**。Workflow 已经覆盖了主要业务流程，Queue 是「真要大并发独立任务」时再上。学习成本留到那时候再付。

### 4.3 Images (cdn-cgi/image)

**定位**：边缘图片变换 proxy（resize / format / quality），不需要把图迁到 CF（保留你的 R2 + worker /r/ 反代）。

**业务匹配场景**：

| 场景 | 当前 | 迁后 |
|---|---|---|
| X 推文图（pbs.twimg.com） | proxyImg() 改写到 worker /img?url=… 反代原图 | worker /img 内部走 cdn-cgi/image transform，URL 携带 width/format 参数返 webp |
| 头像（40px 显示）| 拉原图（200-400px）浏览器缩 | 请求 width=80（@2x DPI），瘦身 70%+ |
| 卡片大图 / lightbox | 原图直返 | 按 viewport 请求精确尺寸 |
| PH gallery（1920px 截图）| 原图直返 | 移动端 width=600 + webp，省 80%+ |
| R2 资源（PH/GH 迁过的 /r/<key>）| handleR2Asset 直返 + cache headers | worker 内部加一层 cdn-cgi/image transform，按 query 变换 |

**实施改造（dashboard utils.ts）**：

```typescript
export function proxyImg(
  url: string | null | undefined,
  opts?: { w?: number; h?: number; q?: number; fit?: 'cover' | 'contain' }
): string {
  // ... 现有解析 ...
  const params = [];
  if (opts?.w) params.push(`width=${opts.w}`);
  if (opts?.h) params.push(`height=${opts.h}`);
  if (opts?.q) params.push(`quality=${opts.q}`);
  params.push('format=auto');
  return `${PROXY_BASE}/cdn-cgi/image/${params.join(',')}/img?url=${encodeURIComponent(url)}`;
}
```

**预算**：
- Workers Paid 免费 5000 unique transformations/月
- 同 URL+参数 cache hit 不再计
- 估算：dashboard 1k PV/天 × 30 image avg × cache 命中 → unique 可能在 5k-15k/月
- 月费：$0 ~ $5（按 5000 免费 + $0.50/1000 超额）

**收益**：移动端流量减 60-80%，LCP 显著提升。前端改 ~5-10 个 `<img>` 调用方，半天工时。

**结论**：✅ 推荐。

### 4.4 Web Analytics

**定位**：CF 自家 RUM（真实用户监控）+ 流量看板，跟自家 telemetry SDK 互补不冲突。

**互补关系**：
- WA 管「平台聚合」：流量 / 来源 / 设备 / 地理 / Web Vitals 分位数（P50/P75/P95）
- Telemetry SDK 管「业务事件」：item_click / login_success / share_landing / device_id ↔ user_id 关联

**业务匹配场景**：

| 想看的 | 当前 | WA |
|---|---|---|
| prod LCP P95？ | D1 自查无看板 | ✅ 现成 UI |
| 今天多少 UV？ | D1 SELECT COUNT(DISTINCT device_id) | ✅ 现成 |
| 移动端 vs PC 占比？ | telemetry 没存 device type | ✅ UA parse |
| Top 10 referrer？ | telemetry 字段（如有）自查 | ✅ 现成 |
| 哪个 path 404 多？ | worker logs 自查 | ✅ Top pages + status |
| 漏斗（item_click → drawer → share）| events 表自查 | ❌ WA 不支持，自家 SDK 主导 |
| 用户 lifetime 行为 | events 表 | ❌ WA 匿名汇总 |

**预算**：完全免费，30 天 retention，0 工时（10 分钟 dashboard 开关）。

**结论**：✅ 立刻开。开 1 周后回看，如果 WA 已覆盖了 Web Vitals，可下线 telemetry SDK 那一块（省 D1 写入）。

### 4.5 Workers Logs / Logpush

两个分开看：

#### Workers Logs（CF Dashboard 集中查 prod 日志）

**定位**：worker invocation log 自动落到 CF 内部，3 天 retention，CF Dashboard 查询 UI（filter by status / path / region / 自定义字段）。

**业务匹配场景**：
- ✅ 「上周二下午 cron 跑挂了原因？」→ Logs 3 天内可查
- ✅ 「DeepSeek 这周失败率？」→ filter "deepseek 503" 总数
- ✅ 「prod 慢请求 P99？」→ invocation_logs 自带 duration
- ✅ 「ScrapeBadger 月配额用了多少？」→ console.log 加结构化日志（`{ provider: 'sb', cost_units: ... }`）→ 按 provider 聚合

**实施**：wrangler.toml 加 4 行：

```toml
[observability]
enabled = true
head_sampling_rate = 1.0    # 1.0=全采样, 0.1=10%

[observability.logs]
invocation_logs = true       # 自动加 path/status/duration
```

**预算**：Workers Paid 含 20M log lines/月，估算业务量 1-2M lines/月，远不到上限。**月费 $0**。

**结论**：✅ 立刻开（10 分钟）。

#### Logpush（推到 R2 / S3 / Datadog 长期归档）

**定位**：把 worker invocation log 推到 R2 等 destination 长期存档。

**业务匹配**：仅当 PR6 「异常告警分级」做时用得上（log → R2 → 定时 worker 跑规则告警），或想跑历史日志分析（周报）。

**预算**：Logpush 自身免费，R2 存储 ~$0.05/月（按 3M lines/月 × 500B = 1.5GB）。

**结论**：⏸ **按需做**，PR6 触发时再开。现在不必。

### 4.6 AI Gateway（前面文档推过，加进来一起讨论）

**定位**：LLM 调用 proxy，自动 cache 同 prompt + analytics + fallback。

**业务匹配**：
- DeepSeek 调用全走 Gateway
- `is_relevant` 二分类同 prompt 几小时内会重复 score 多次（refresh / reclassify 触发），cache hit 直接节省
- Translation 也有重复（同句子在多条推文出现）
- 还可以配 fallback：DeepSeek 挂了自动切 OpenAI / Workers AI

**预算**：免费层够用，月费 $0。

**实施**：
1. AI Gateway dashboard 创建 gateway
2. 改 worker DeepSeek 调用的 base URL：`https://api.deepseek.com/v1/...` → `https://gateway.ai.cloudflare.com/v1/<acct>/<gw>/deepseek/chat/completions`
3. headers 加 `cf-aig-cache-ttl: 3600`（缓存 1h）

**收益**：cache hit 省 20-30% 调用 + 全套 latency / cost analytics + fallback 防挂。半天工时。

**结论**：✅ 推荐。

---

## 5. 整体迁移分阶段 roadmap

按 ROI + 依赖关系排序：

### Phase 1（这周内，2-3 小时）— 零风险快速收益

1. **Web Analytics 开关**（10 分钟）— CF Dashboard
2. **Workers Logs 开关**（10 分钟）— wrangler.toml + redeploy
3. **AI Gateway 包 DeepSeek**（半天）— 改 base URL + cache headers

→ 这一阶段不动业务逻辑，纯 ops 收益。

### Phase 2（1 周）— Dashboard 性能提升

4. **Images cdn-cgi 改造 dashboard proxyImg()**（半天）— `width=...&format=auto` 参数化
5. 移动端 5-10 个 `<img>` 调用方升级

→ 立见效（移动端流量减 60-80%）。

### Phase 3（1-2 周）— GH 链试点 Workflow

6. **GitHub 4 模式（fetch → enrich → translate → r2-migrate）整合成 1 个 GitHubRepoWorkflow**
   - 量小（启动期 1/天）+ step 链短（4 step），适合先试水
   - 跟旧 cron 双写 1 周，对比数据一致性
   - 验证后下线旧 cron mode

→ 验证 Workflow 模型 + 团队（你自己）熟悉 SDK，为 X 主链铺路。

### Phase 4（2-3 周）— X 主链 Workflow 迁移（最大头）

7. **TweetIngestWorkflow 设计 + 实施**
   - cron `list-poll-ingest` 仍然是 producer（保留 ScrapeBadger batch list-poll）
   - 拿到新推 ID 列表 → 逐条 `env.TWEET_WORKFLOW.create({ id, params })` 触发
   - Workflow 内 6 step：fetch / classify / check-longform / (longform-fetch if) / translate / enrich / save
   - 长推 conditional step.do
   - **跟旧 cron 模式双写 2 周**：classify-pending / fill-translations / backfill-quotes / backfill-replies / detect-longform / longform-via-sb 全部继续跑
   - 双写期间对比：D1 中两条路径写入的 item 字段一致 → 才下旧模式

8. **下线旧 cron mode**：classify-pending / fill-translations / backfill-quotes / backfill-replies / detect-longform / longform-via-sb 6 个模式
9. **保留**：list-poll-ingest（producer）+ refresh-tiered（独立批量任务）+ cleanup

### Phase 5（按需触发）— 后续

10. **Queues**：等真有大量并发独立任务（newsletter 群发 / push 通知）再上
11. **Logpush**：PR6 异常告警分级时同步上
12. **本地 PH/GH scraper 上 CF Container**：等 Container GA + 业务量增长再考虑

---

## 6. 风险评估 + 应对

| 风险 | 等级 | 应对 |
|---|---|---|
| Workflow 接入新概念多，第一次上手 step 设计错（粒度太细 / 太粗） | 中 | Phase 3 先用 GH 链试水，量小试错成本低，吃透后再 Phase 4 上 X 主链 |
| 双写期间两条路径数据不一致 | 中 | 设计 D1 字段 `pipeline_version: 'cron-v1' | 'workflow-v1'` 标记走哪条路径，对比脚本自动跑 diff |
| Workflow 100k step/月免费额度突然爆（业务量起来）| 低 | 先按 261/天 × 5 倍冗余设计；超额按 $0.30/k step 算，5x 量级也就 ~$50/月 |
| Images cdn-cgi 月费突涨（cache 命中率低于预期） | 低 | 先按 5000 免费跑 1 周，看 unique transformation 量再调 |
| AI Gateway cache miss / cache 失效逻辑跟业务对不上 | 低 | cache TTL 1h（短），观察 hit rate 调；hit rate < 10% 就 cache 不开（直接 proxy） |
| 旧 cron mode 下线后发现遗漏 case（比如某条推文走过 Workflow 但缺 quote） | 中 | 保留旧模式代码 1 个月（feature flag 关），出问题翻 flag 即恢复；之后再删 |

---

## 7. 待决策项（open questions）

写代码前需要敲定的：

- [ ] **Workflow instance 幂等 key**：用 `tweet_id` 直接做 instance.id？X tweet ID 是 snowflake，全局唯一，可以直接用。但要确认 Workflow instance.id 接受任意字符串
- [ ] **早退场景的 D1 落库策略**：is_ai=0 现在也写 D1（is_relevant=0）。Workflow 早退后是否仍写一条 D1（是的，前端 dashboard 默认隐藏 is_relevant=0，但管理需要看）
- [ ] **双写期间 D1 schema 加字段还是用 extra JSON**：`pipeline_version` 单列 vs 塞 extra？建议单列 + 索引（便于 query / aggregate diff）
- [ ] **AI Gateway cache TTL**：is_relevant 用 1h 缓存，translation 是否也缓存？translation 同句子重复率多少？
- [ ] **Web Analytics 开 1 周后**：哪些 SDK 事件可以下线（vitals 重复了？）→ 等真实数据回看决定
- [ ] **GH Workflow trigger**：当前 github-fetch 走 worker REST 拉 trending；切 Workflow 后 trigger 改成 cron worker → fetch trending → 逐 repo `WORKFLOW.create()`？还是 cron 直接是 Workflow 的 entry point？
- [ ] **Long-running step 的 cf cpu time 限制**：Workflow 单 step 还是按 worker CPU 30s 限制？长 DeepSeek 调用（30s+）需要拆 step

---

## 8. 关联文档

- [`docs/cf-platform-overview.html`](../cf-platform-overview.html) — CF 全产品矩阵 4 档分类（已用 / 强相关 / 弱相关 / 暂不必）
- [`docs/cf-deep-dive-5-products.html`](../cf-deep-dive-5-products.html) — 5 个产品 × 业务每模块决策矩阵（含 API 用法 + 价格）
- [`docs/scrapebadger-cost-and-frequency.md`](../scrapebadger-cost-and-frequency.md) — SB 计费规则 + 频率档位对照
- [`docs/operations.md`](../operations.md) — 运维手册（worker / D1 / R2 / KV 全 stack）
- [`docs/plans/2026-05-01-auth-system-design.md`](2026-05-01-auth-system-design.md) — 账号系统设计（已实施）
- [`docs/plans/2026-05-06-email-auth-design.md`](2026-05-06-email-auth-design.md) — Email 验证码登录设计（已实施）

---

## 9. 决策修订记录

- 2026-05-06：初版讨论文档
  - 修正：之前估 X 5000/天 → 实测 261/天，导致 Workflow 月费从 $150 估到 $0
  - 修正：X 主链推荐从 Queue 改为 Workflow（量小 + step 状态传递 + trace 优势压过 Queue）
  - 新增：ScrapeBadger batch endpoint 计费规则进入决策依据
  - 新增：AI Gateway 加入推荐第一阶段
