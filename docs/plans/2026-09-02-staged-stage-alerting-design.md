# 分批日报阶段告警与连坐解耦（2026-09-02 事故修复 · 第二部分）

> 第一部分（D1 CPU 超限的查询修复）见 `2026-09-02-news-query-two-phase-design.md`。
> 本篇处理同一次事故暴露的两个编排问题：**六连败零告警**、**editorial 失败连坐停掉论文与最终推送**。

## 1. 告警为什么会完全静默

事故当天 07:50 行业要闻批次重建连败 3 次、08:00 回补再败 3 次，六次失败**一条告警都没有**，
owner 08:45 自己发现。通读 `worker/src/digest/node-run.ts` 全部 catch 路径与 PushDeer 生产/消费链后，
静默是三个缺口叠加的结果——不是一个 bug：

### 缺口 A：只有一条告警，且挂在最外层，必须等重试全部耗尽

修复前，staged 阶段重建（`rebuildStageStep` → `step.do('pool-stage-{stage}')`，
`retries.limit = 2`，即 1 + 2 = 3 次尝试，正好对上「连败 3 次」）失败时，
唯一的告警在 `runDigestNodeWorkflow` 最外层的 catch 里。也就是说：

- 三次尝试全部失败之前，用户看不到任何东西；
- 每个 workflow 实例最多产生 **1 条**告警，六次失败最多也只有 2 条（07:50 一条、08:00 一条）。

### 缺口 B：告警投递结果被丢弃，「一条都没推出去」等于「成功」

`worker/src/notifier.ts` 的 `sendPushDeer` 把每一种失败——`PUSHDEER_ADMIN_KEYS` 未配置、
HTTP 非 2xx、provider `code != 0`、`fetch` 抛异常——**全部在内部捕获、计数、`console.error`，然后正常返回**
一个 `PushDeerSendResult`。而 `pushDeerAlert` 的返回类型是 `Promise<void>`，把这个结果直接扔掉。

后果有两层：

1. 全仓所有告警调用点都无法区分「推成功」和「N 个 key 一条都没送达」；没有任何地方检查过 `succeeded`。
2. 写在调用点后面的 `.catch(() => {})` 是**永远不可能触发的死代码**——`sendPushDeer` 从不 reject。
   它给人一种「已经处理过失败」的错觉，实际上什么都没处理。

### 缺口 C：告警和故障在同一个 isolate 里，没有任何外部观察者

这是 9/2 真正致命的一条。`runDigestNodeWorkflow` 的 catch、`step.do` 回调里的 catch，
全都运行在**发生故障那次 workflow 调用自己的 isolate** 中。只要故障不是以「可捕获的 Promise rejection」
形式回到用户代码——Workers 的 `Exceeded CPU time limit`、isolate 被回收、OOM——那些 catch **一行都不会执行**，
`finally` 不跑，出站 `fetch` 也发不出去。D1 CPU 超限打穿一次 Worker 调用，正是这一类。

而当时唯一跑在 workflow 之外的看门狗是 `checkDailyPageFreshness`（UTC 01:00），它只盯 SEO 静态日报页，
盯不到 `foundation` / `editorial` / `papers` / `finalize` 四个阶段本身。

> **诚实的边界**：缺口 A 和 B 可以从代码直接证明。缺口 C 是最符合「六连败零告警」现象的解释
> （只有它能解释「连一条最终失败告警都没有」），但要 100% 坐实需要当天的 Workers 实例日志。
> 三个缺口的修复互相独立，且只有针对 C 的看门狗能覆盖 isolate 被直接掐死的场景。

## 2. 修复

### A → 两级阶段告警

`runStagedStepWithAlerts` 把每个 staged 阶段步骤包一层：

- **第 1 次失败**（retry 还没开始）立刻发一条「分批日报阶段首次失败(将自动重试)」，带日期 / 阶段名 / 步骤名 / 错误摘要；
- **重试全败**后再升级一条「今日 {stage} 阶段最终失败」；
- 最外层 workflow 兜底告警保留，但它现在是第三层，不再是唯一一层。

`reportedFirstFailure` 是闭包变量，同一 isolate 内多次 retry 只发一条首次告警；
若 Workflows 把 retry 调度到新 isolate，最多多发几条——宁可重复也不要静默。

覆盖的步骤：`pool-stage-{foundation,editorial,papers}`、`push-codex-{foundation,editorial,papers,finalize}`、
`freeze-news-review-batch`。

### B → 告警投递结果必须被检查

新增 `notifier.ts` 的 `pushDeerAlertResult`（同一封路径，但把 `PushDeerSendResult` 交还调用方）
和 `deliverCriticalAlert`（发送 + 检查 `succeeded` + 零成功落 `console.error` + 返回布尔）。

`node-run.ts` 与 `codex-push.ts` 里全部 8 处 `pushDeerAlert(...).catch(() => {})`
换成 `deliverCriticalAlert(...)`，裸吞 catch 清零。

### C → 独立于失败 isolate 的看门狗

新增 `worker/src/digest/staged-stage-monitor.ts`，由 `*/5` cron 每 tick 调一次（窗口外纯计算直接返回，零 I/O）：

| 阶段 | BJT 计划时刻 | 宽限期 | 最早告警时刻 |
|---|---|---|---|
| foundation | 06:30 | 15 min | 06:45 |
| editorial | 07:50 | 10 min | **08:00** |
| papers | 08:00 | 20 min | 08:20 |
| finalize | 08:00 | 25 min | 08:25 |

判定只读 D1（`getDailyStageState`）：非 finalize 阶段缺快照 → `missing_snapshot`；
`DAILY_PUSH_ENABLED='1'` 且缺 `pushed_at` → `missing_push`。KV 按 `(date, stage)` 去重，当天只告一次（TTL 25h）。
读状态本身失败记 `read_failed` 并落日志，**不冒充**「阶段失败」。看门狗自身永不抛错。

关键性质：它的全部输入就是 D1 状态，**与 workflow 是否跑到 catch 完全无关**。
按这套时刻表，9/2 的 editorial 缺失在 BJT 08:00 就会告警——比 owner 自己发现（08:45）早 45 分钟。

## 3. 连坐耦合点与解法

### 耦合点①：08:00 前批快照补建（`ensurePriorStageSnapshots`）

修复前它直接向外抛。一旦 editorial 回补失败，后面**全部**停摆：papers 重建、列订阅、
`spawn-deliver-*` 发邮件、SEO 静态日报页——比事故描述的还要宽。

解法：每个前批阶段独立 try / 记账，返回 `StageOutcome`，不再向外抛。
阶段错误累计到 `stageFailures`，在邮件与 SEO 都跑完之后统一抛出，workflow 仍然保持失败可重试。

### 耦合点②：08:00 推送段（`recoverPriorStagePushes` + papers + finalize 同一个 try）

修复前 `recoverPriorStagePushes` 一抛，`papers` 与 `finalize` 的推送全被跳过。

解法（依据：`DIGEST_POOL_STAGE_SOURCES` 里 `papers=['hf-paper']`、`editorial=['news','x']`，
papers 的重建与推送与 editorial 内容零依赖）：

- 前批推送独立记账，不阻断 papers 推送；
- papers 重建与推送各自独立 try；
- **finalize 例外**：它的 manifest 引用三个阶段各自的 revision，任一前置缺失时推不出去是合理的。
  但不能静默停——改成产生明确的挂起：
  - `console.error` 一行 `finalize suspended, missing: [...]`；
  - 一条「分批日报 finalize 挂起」PushDeer 告警，列出具体缺哪几项；
  - `finalizeSuspended` 写进 workflow 返回值，事后能从实例输出复盘；
  - 看门狗也会在 BJT 08:25 独立报一次 finalize 未完成。

`stageFailures` 同样写进返回值。全绿路径的推送顺序仍然是 `foundation → papers → finalize`，与修复前一致。

## 4. 测试与变异验证

| 文件 | 覆盖 |
|---|---|
| `src/notifier.test.ts`（+5） | `deliverCriticalAlert` 成功 / 前缀 / 四种失败模式（key 未配置、HTTP 非 2xx、provider code≠0、fetch 抛异常）各自返回 false 并落日志 |
| `src/digest/staged-stage-alerting.test.ts`（新增 12） | 两级告警、首次告警发生在第 1 次尝试、3 次尝试只发 1 条首次告警、推送失败同样两级、告警投递失败不吞原始错误；papers 在 editorial 快照/推送/人审冻结失败下各自独立完成；邮件与 SEO 不再连坐；finalize 挂起状态 + 告警；全绿路径零告警且顺序不变 |
| `src/digest/staged-stage-monitor.test.ts`（新增 12） | 开关 / 窗口 / 尾巴、计划时刻与 cron 路由一致、缺快照、缺 pushed_at、`DAILY_PUSH_ENABLED` 未开不误报、当天去重、KV 故障不吞告警、read_failed 不冒充失败、全健康静默、9/2 重演 |

变异验证（都实跑过、确认会红）：

1. **事故前「只有最外层一条兜底告警」的形状**：显式建出旧编排，断言它没有「首次失败」告警、
   唯一那条要等第 3 次尝试跑完才发、也没有「阶段最终失败」升级——第一、二个用例的断言在它上面全假。
2. **丢弃投递结果的旧写法**：`pushDeerAlert(...).catch(() => {})` 在全失败下仍然 resolve 成 `undefined`，
   无法与成功区分；新写法在同样条件下返回 `false`。
3. **前批推送失败就整段跳过的旧写法**：断言当前实现下 papers 推送在前批推送失败时仍然发生。
4. **看门狗宽限期放宽到 30 分钟**：editorial 就不在 BJT 08:00 这一 tick 的检查范围内，告警推迟 20 分钟。

全量：`cd worker && npm test` → 120 files / 2874 tests 全绿（`origin/main` 基线 118 / 2842）；
`tsc --noEmit`、`wrangler deploy --dry-run` 通过。

## 5. 遗留风险

- **首次失败告警的跨 isolate 去重**：`reportedFirstFailure` 只在单个 isolate 内有效。
  Workflows 若把 retry 调度到新 isolate，同一阶段最多会收到 3 条「首次失败」。选了「宁可重复不要静默」。
- **看门狗依赖 cron 本身还活着**。整个 Worker 的 `scheduled` handler 挂掉时它也不会跑；
  这一层需要 CF 侧的 cron 健康监控来兜（本次未做）。
- **`finalize` 挂起目前只落在日志 / 告警 / workflow 返回值里**，没有写进 D1 的阶段状态表。
  想在 admin 看板上直接看到「今天 finalize 挂起」还需要单独一版。
- **告警噪音**：阶段首次失败即告警，意味着「失败一次但重试成功」也会推一条。
  对每天一次的批次流水线这是想要的行为，但如果未来阶段数变多，需要考虑聚合。
