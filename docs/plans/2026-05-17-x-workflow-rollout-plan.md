# X 抓取管道重构 · 落地计划

**日期**：2026-05-17
**设计稿**：[2026-05-17-x-workflow-redesign.html](2026-05-17-x-workflow-redesign.html)
**主导**：BE  ·  **配合**：FE / OPS

---

## 一、整体策略

按「先治本流程 → 再前端筛选 → 最后补存量」3 阶段串行实施。每阶段做完跑验证 + 跑 staging 全链路 → prod 部署 → 观察一周 → 下一阶段。

**为什么串行不并行**：

- 流程没改完之前前端筛选没意义（filter 完什么都没有）
- 前端没筛选之前 backfill 跑了用户也看不到效果
- 串行可以一阶段一阶段验证，问题及时收口

---

## 二、4 批 PR 拆分

### 批 1：workflow 主流程重构 + 云端完整性筛选（BE 主导，3-5 天）

**改动文件**：
- `worker/src/workflows/x-tweet-pipeline.ts` — workflow 节点重排
- `worker/src/enrich.ts` — 新加 `backfillRetweetForXTweet` / 新加合并调用函数 `classifyAndTranslateForXTweet`
- `worker/src/scrapebadger.ts` — 第 3 步「数据补全」实现（合并截断补全 + 视频 mp4 + 长推标记）
- `worker/src/index.ts` — `/api/items` endpoint SQL 默认加完整性 filter

**对应设计稿步骤**：
- 第 3 步：合并长推标记到数据补全（一次 syndication 调用）
- 第 4 步：删 4d，保留 4a/4b/4c 三个分支并行
- 第 5 步：长推全文抓取（保持独立）
- 第 6 步：合并相关性判定 + 翻译（一次 DeepSeek 调用，含失败时 worker 内立即重试一次）
- 第 7 步：完整性检查（写 `extra.workflow_completed_at` 时间戳）
- 第 8 步：云端完整性筛选 — `/api/items` 默认 `WHERE json_extract(extra, '$.workflow_completed_at') IS NOT NULL`，FE 无感知（云端下发的就是完整数据）

**翻译失败处理**（决策点 ③ 落地）：
- workflow 第 6 步合并调用失败 → 立即在 worker 内重试一次
- 仍失败 → 标 `extra.translation_failed_at`，但 content 维持英文（不阻塞完整性 gate，is_relevant=1 + 重试过即算"已尝试"）
- 前端展示英文原文（feed 流内）
- 用户点击「译文」按钮 → 触发 `/api/items/:id/translate-now`（FE 配合，批 3 实施）

**DeepSeek 提示词**（重写）：
约定 JSON schema，含 `is_relevant / reason / content_zh / quote_of_zh / reply_of_zh / retweet_of_zh / link_card_title_zh / link_card_desc_zh`，用 JSON Mode 强制结构。具体提示词放设计稿验收标准内。

**验收**：按设计稿底部 8 项验收标准逐项过 + 完整性 filter 在 staging 验证（feed 数据量正确）

**配合**：无（纯 BE）

---

### 批 2：数据失效级联（BE 主导，1 天）

**改动文件**：
- `worker/src/scrapers/...` 各 backfill 函数

**改动内容**：
- 任何函数更新 `content` 时同步清 `content_translated = NULL`
- 任何函数更新 `extra.quote_of.content` 时同步清 `extra.quote_of.content_zh`
- 同理 `reply_of` / `retweet_of` / `link_card`

清空后下个 workflow tick 触发自动重翻。

**验收**：单元测试覆盖 5 种字段改 → 翻译清空场景

**配合**：无（纯 BE）

---

### 批 3：详情页样式对齐（FE 主导 2-3 天）

> 完整性筛选已挪到 BE 批 1（云端 SQL filter 在 /api/items 默认生效，FE 无感知）
> 「原文/译文」按钮交互保持 aifeeds 线上现有方式（发文时间后按钮 + 单击切换），FE 不改

**FE 主导改动**：

`dashboard/src/components/TweetCard.tsx`：
- 回复（reply）详情页：父推完整推文卡（含头像 / handle / 互动数）在主推上方，thread line 连接
- 自连回复（thread）详情页：展开整个会话，多条按时间顺序，thread line 串联
- 删「该会话后续」「被回复的父推」等多余小标题文案，按 X 原生结构（卡片 + thread line）展示
- 引用 / 转发 / 原帖：基本不变

**新增功能：译文按钮点击触发即时翻译**（决策点 ③ 落地）：
- 用户点击「译文」按钮时，若该字段当前为 NULL（翻译失败状态）→ FE 调 BE 新加的 `/api/items/:id/translate-now` Bearer endpoint
- BE 单条 DeepSeek 翻译 → 写回 D1 + 返回翻译文本
- FE 实时更新流内卡片 + 抽屉对应位置

**BE 配合**：
- 新加 `POST /api/items/:id/translate-now` endpoint（Bearer + 防滥用限流）
- 单条调用走第 6 步同一套合并 prompt，仅含主推（无关联字段时）或全字段
- 返回 JSON `{ content_zh, quote_of_zh, ... }` 给 FE 实时渲染

**验收**：
- 5 种推文类型详情页对照 X 平台原貌 mockup 验视觉
- 译文按钮点击触发翻译 → DeepSeek 调用 → 写回 + 实时刷新流程跑通

---

### 批 4：老数据 backfill + 兜底定时任务（BE 主导，OPS 配合 1 天 + 跑 6 小时）

**BE 改动**：
- 新加 `/api/enrich/run?mode=backfill-x-workflow&limit=N` Bearer endpoint，跑老数据走新流程
- 新加 cron tick 兜底（minute=15/45）每 30 分钟扫 `workflow_completed_at IS NULL` 的 X 推文重 trigger

**OPS 配合**：
- 跑批前确认 CF Worker 月度 subrequest 额度够（3 万 × 10 subreq = 30 万）
- 跑批前确认 DeepSeek API 月度额度够
- 跑批日实时监控 worker 错误率 + DeepSeek token 消耗

**执行方式**：
- 7 天内的优先（按 published_at DESC），跑完后宽松节奏跑老数据
- 失败的标 `extra.workflow_failed_at` 不重复 retry

**验收**：
- 跑完 24 小时后 `workflow_completed_at IS NULL` 的 X 推文 < 100
- 完整性 filter 打开后 feed 有数据展示（覆盖 95% 以上推文）
- 监控指标稳定一周无回归

---

## 三、协作分工表

| 工作 | BE | FE | OPS |
|------|----|----|-----|
| workflow 改造（批 1） | ✅ 主导 | — | 协助 deploy |
| 数据失效级联（批 2） | ✅ 主导 | — | — |
| 前端完整性筛选（批 3） | 出 SQL | ✅ 主导 | — |
| 详情页 mockup 修正（批 3） | — | ✅ 主导 | — |
| 原文切换交互（批 3） | — | ✅ 主导 | — |
| 翻译失败展示策略（批 3） | — | 提建议 | — |
| 老数据 backfill（批 4） | ✅ 主导 | — | 资源准备 |
| 跑批监控（批 4） | — | — | ✅ 监控 |
| DeepSeek 用量监控 | — | — | ✅ 全周期 |

---

## 四、时间线（估计）

| 周 | BE | FE | OPS |
|----|----|----|-----|
| 第 1 周 | 批 1 workflow 改造（3-5 天）+ 批 1 验收 | — | DeepSeek 配额检查 |
| 第 2 周 | 批 2 失效级联（1 天）+ 出批 3 SQL 接口 | 启动批 3 准备 | — |
| 第 3 周 | 配合批 3 接口联调 | 批 3 实施 + staging 验证 | — |
| 第 4 周 | 批 4 backfill + 兜底 cron（1 天 + 6 小时跑批） | — | 跑批日监控 |
| 第 5 周 | 观察周 | 观察周 | 监控指标稳定性 |

---

## 五、决策点（已对齐）

| 编号 | 决策项 | 结果 |
|------|--------|------|
| ① 完整性检查 | ✅ 做（云端 SQL filter，FE 无感知） |
| ② 老数据 3 万条处理方案 | ✅ B 方案：最近 7 天优先 + 老数据按新工作流走一遍 |
| ③ 翻译失败处理 | ✅ workflow 内立即重试 1 次 → 仍失败展示英文 → 译文按钮点击触发即时翻译并回写 D1 |
| ④ 实施顺序 | ✅ 4 批顺序按上面执行 |

---

## 六、风险与回退预案

### 批 1 风险：DeepSeek 合并调用不达验收标准

- **症状**：JSON 结构错误率 > 1% / 翻译质量差 / 准确率 < 90%
- **回退**：保留旧逻辑（判定 + 翻译分开调用），新合并调用做 feature flag，达标后切换

### 批 3 风险：完整性筛选打开后 feed 没数据

- **症状**：老数据全部 `workflow_completed_at IS NULL`，filter 打开后 feed 空白
- **预防**：staging 先验证 + 批 4 backfill 完成后再上线 prod filter
- **回退**：dashboard 加紧急开关关闭 filter

### 批 4 风险：CF Worker subrequest 超额

- **症状**：跑批跑一半 worker 限流报错
- **预防**：OPS 提前查月度配额，必要时升级套餐 / 分批跑
- **回退**：暂停跑批，老数据保留显示 + 加「早期数据可能不完整」标识

---

## 七、BE「主 agent」工作模式（统筹整个改版）

BE 作为主 agent 统筹改版，每一步：
1. 待办拆解（自己 / FE / OPS 各做什么）
2. 给 OPS / FE 写明确的转发文案（user 直接复制粘贴）
3. 转发文案里**明确要求回执**（什么时机 / 什么格式）
4. 回执回来后汇总到 user，决定下一步

### 回执格式约定

**OPS 回执模板**：
```
[OPS → BE · 关于 XX 任务]

状态：[ ] 已确认  [ ] 已实施  [ ] 阻塞
- 已确认 → 计划开始时间：YYYY-MM-DD
- 已实施 → 验证结果 / 影响范围 / 后续注意点
- 阻塞 → 阻塞原因 + 需要什么支持
```

**FE 回执模板**：
```
[FE → BE · 关于 XX 任务]

状态：[ ] 收到 / 理解  [ ] 已实施  [ ] 有疑问
- 收到 / 理解 → 预计 ETA + 实施细节理解（确保跟 BE 期待一致）
- 已实施 → PR 链接 + staging 验证截图 / 录屏
- 有疑问 → 具体疑问点 + 期望的输入
```

### 每轮发给 user 的内容结构

```
## 当前状态
（哪些已做 / 哪些进行中 / 哪些等回执）

## 给 OPS 的转发文案
（user 直接复制贴）
（含回执要求 + 时机）

## 给 FE 的转发文案
（user 直接复制贴）
（含回执要求 + 时机）

## 等回执后我下一步会做什么
（让 user 知道协作脉络）
```

### 节奏

- BE 内部工作（写代码 / 跑测试 / deploy staging）→ 自己跑，不下发，完成后通报 user
- 任何需要 OPS / FE 配合的点 → 提前一轮发转发文案给 user 转，让对方有时间准备
- 任何决策点（设计 / 取舍）→ 不擅自决定，明确列选项给 user 拍板

---

## 八、后续延伸

X 这套跑完后，按相同模板梳理另外 3 个源：

- **活动行（hdx）**：详情页 loading 卡死问题
- **Product Hunt**：作者头像缺失问题
- **GitHub Trending**：暂未集中梳理

每个源走「设计稿 → 工程评审 → 4 批 PR」相同流程，主 agent 工作模式延续。

---

## 九、批 3 接口决策细节（FE 第 1 轮回执对齐 · 2026-05-17）

FE 第 1 轮回执提了 5 个阻塞 / 疑问，BE 全部拍板如下。批 1 BE 改动需对齐这些规格。

### ① 译文按钮鉴权 → cookie auth

- `/api/items/:id/translate-now` 复用 dashboard cookie session（不引入 Bearer 流，跟 `/api/share/create` 一致）
- 加 CSRF token header 校验
- 限流：每 user 每 item 60s 冷却 + 每日 20 次上限

### ② thread 详情页数据源 → /api/items/:id?include=thread_members

- 默认不返 thread_members（feed 列表无谓查询省 D1 cost）
- 详情页 FE 显式索取
- response 字段：`extra.thread_members: Tweet[]`（按 `created_at` ASC，schema 跟主推完全一致）

### ③ thread 展开范围 → 默认全渲染 + 上限 50

- thread_members 默认 max 50 条返回（覆盖 99%）
- 超过 50 → `extra.thread_has_more: true`，FE 可显示截断提示
- 不做 lazy load（产品低优先级）

### ④ 译文按钮 loading 状态 → spinner

- 走 FE 判断（跟 dashboard 其他 async 操作一致）

### ⑤ media schema 统一（reply_of / quote_of / retweet_of 跟主推一致）

- BE 在批 1 改 `enrich.ts` 时强制统一字段为 **BE 当前实际 schema**(2026-05-17 摸底修正,不引入冗余字段)：
  ```ts
  {
    type: 'image' | 'video',
    url: string,           // 视频时 = mp4 url(可直接 video tag src),图片时 = image url
    width: number | null,
    height: number | null,
    poster: string | null, // 视频专用,封面图;图片时 null
    alt: string | null,    // 当前始终 null(X 不暴露),保留字段位
  }
  ```
- BE 保证 reply_of / quote_of / retweet_of 的 media 数组用同 schema
- FE MediaGallery 用 `poster` 字段(不是 poster_url),`alt` 字段忽略

### 错误码契约（/api/items/:id/translate-now）

| HTTP | 场景 | FE 处理 |
|------|------|---------|
| 200 | 翻译成功（或字段已有译文直接返回） | 拿响应字段刷新流卡 + 抽屉 |
| 401 / 403 | session 过期 / CSRF 失败 | 弹登录态过期提示 |
| 404 | item 不存在 | 静默回退英文 + 不再触发 |
| 429 | 限流（60s 冷却内 / 当日超 20 次） | toast "请稍后再试" + 按钮冷却 |
| 5xx | DeepSeek 失败 | toast 错误 + 按钮恢复可重试 |

### 接口规格落地

- 上述决策影响批 1 PR：
  - `worker/src/index.ts` 新加 `/api/items/:id/translate-now` cookie auth endpoint + `/api/items/:id?include=thread_members` query 支持
  - `worker/src/enrich.ts` 改 media schema 统一逻辑（父推 / 引用 / 转发 media 字段对齐主推）
- 批 1 PR merge 后 BE 单独发一份 OpenAPI / 字段示例给 FE 做联调依据

---

## 十、OPS 第 1 轮回执确认（2026-05-17）

OPS 第 1 轮预查 3 件全部通过,无阻塞。

### ✅ DeepSeek JSON Mode 支持

- `deepseek-v4-flash` 实测通过 6 字段 schema（`is_relevant` boolean + 5 个 `_zh` nullable string + `reason`）
- 单次 ≈ 544 tokens（含 156 reasoning tokens),单价约 ¥0.00077
- ⚠️ prompt 必须含 "json" 字样（DeepSeek 硬性要求）— 批 1 提示词照做
- ⚠️ 字段缺失需要应用层校验 — 批 1 在 worker 内对返回 JSON 做必字段 check + 缺则触发重试

### ✅ CF Worker 配额无压力

- 实测 30 天:306k requests / 118k subreq / error rate 0.38%
- 已是 Workers Paid plan(R2 6 buckets + Cron Triggers 证据)
- CF 已无 subreq monthly cap 概念(按 request 计费)
- 改造后 +30 万 subreq 不触发任何 hard limit
- per-invocation 10 subreq << 1000 cap

### ✅ DeepSeek API 余额充裕

- 当前余额 ¥205,5 月消费 ¥55(日均 ¥4-5)
- 改造稳态月成本 ~¥22/月(合并调用 5→1 次降本 87%)
- 改造首月含 30k backfill ~¥45 一次性 = 余额 22%
- 余额可撑 3-4 个月不充值

### OPS 建议采纳

- 批 1 继续用 `deepseek-v4-flash`(不切 pro)— 与 CLAUDE.md 模型选型规范一致
- 实测合并任务质量不够才切 pro

### OPS 跑批日承诺(批 4)

- 跑批前 1h 拉 baseline
- 跑批中每 30 分钟监控 subreq + error rate + DeepSeek token 消耗
- 阈值告警:worker error rate > 5% / DeepSeek 余额 < ¥100 / subreq > 10% plan
- 跑批完出监控总结回执

---

## 十一、批 1 启动决定(2026-05-17)

OPS 全绿 + FE 接口契约已落第九节 → 批 1 BE 开工,预计 3-5 天。

### 实施顺序(细化)

1. **摸底**当前 4 个文件代码结构(workflow / enrich / scrapebadger / index.ts)— Explore agent 跑摸底
2. **改 `worker/src/scrapebadger.ts`** 第 3 步合并 syndication:
   - 一次 syndication 调用合并:截断补全 + 视频 mp4 + 长推标记 + media schema 统一
   - media 字段输出统一:`type / url / video_url / width / height / poster_url`
3. **改 `worker/src/enrich.ts`** 新加合并调用:
   - `classifyAndTranslateForXTweet`(JSON Mode 单次调用,prompt 含 "json" 字样)
   - 返回 6 字段 schema:`is_relevant` / `reason` / `content_zh` / `quote_of_zh` / `reply_of_zh` / `retweet_of_zh` / `link_card_title_zh` / `link_card_desc_zh`
   - worker 内对返回 JSON 做必字段 check + 缺则重试 1 次
   - 重试仍失败 → 标 `extra.translation_failed_at`,content 维持英文
   - 同时新加 `backfillRetweetForXTweet`(纳入 workflow,补回 retweet_of)
4. **改 `worker/src/workflows/x-tweet-pipeline.ts`** workflow 节点重排:
   - 删 step 2d(原判定 + 翻译分开调用)
   - 重排 step 编号对齐设计稿 8 步
   - step 7 完整性 gate:三必填字段齐 → 写 `extra.workflow_completed_at` 时间戳
5. **改 `worker/src/index.ts`**:
   - 新加 `POST /api/items/:id/translate-now`(cookie auth + CSRF + per-user-per-item 限流 60s + 每日 20 次)
   - 新加 `GET /api/items/:id?include=thread_members`(query 支持,默认 max 50 + `thread_has_more` flag)
   - `/api/items` 默认 SQL filter:`WHERE json_extract(extra, '$.workflow_completed_at') IS NOT NULL`
6. **tsc + 单元测试**(必字段 check / 限流 / SQL filter)
7. **staging deploy** + 按设计稿 8 项验收标准跑验收
8. **PR + merge + prod deploy**

### 风险预案

- DeepSeek JSON Mode 必字段缺失率 > 1% → 切 v4-pro(预算翻倍约 ¥45/月,仍在余额范围)
- staging 验收某项不达标 → 锁定该项不上 prod,先开 issue 跟踪
