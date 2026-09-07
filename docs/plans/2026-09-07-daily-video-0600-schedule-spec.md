# 每日视频提前到 06:00 出片，早间邮件保持 08:00

日期：2026-09-07　状态：owner 已拍板（「出 daily 视频是改在 6 点，发邮件还是在 8:00」）　实施中

## 1. 现状（代码核实）

`worker/src/digest/node-run.ts` `routeDigestCronWorkflows`（复用 `*/5` cron，UTC 判定，日期按 BJT）：

| UTC | BJT | 节点 | 内容 |
|---|---|---|---|
| 22:30 | 06:30 | `digest-node-<date>-08-foundation` | 重建 X/PH/GH 池并推送 foundation |
| 23:50 | 07:50 | `digest-node-<date>-08-editorial` | 重建 news/x 池、冻结要闻批次 + PushDeer、推送 editorial |
| 00:00 | 08:00 | `digest-node-<date>-08-papers`（slot 8） | `ensurePriorStageSnapshots` → `prepareNewsReviewStep`（幂等补建/补发） → 重建 papers → **列 `send_slot=8` 订阅并 spawn 邮件投递** → 推送 papers → 推送 finalize（→ 渲染机出片）→ `generateDailyPage`（SEO 日报页） |
| 04:00 / 09:00 | 12:00 / 17:00 | slot 12 / 17 | v1 全源重建 + 邮件 |

配套：`staged-stage-monitor.ts` 的 `STAGED_STAGE_DEADLINES`（06:30+15 / 07:50+10 / 08:00+20 / 08:00+25）；渲染机 `aifeeds-daily-submit.timer` 08:40 兜底；面板 `run.mjs` 文案「07:50」（`NEWS_REVIEW_FREEZE_LABEL` 与一处静态说明）。其它源抓取时间不受影响（GH BJT 01:00/13:00、ClawHub 04:00/16:00、PH 前一日 16:00 已定、X 持续、HF papers 08:05 抓取但 papers 阶段本就用前一日那批）。SEO 缺页检查 UTC 01:00 仍在出片之后。

## 2. 目标

| UTC | BJT | 节点 | 内容 |
|---|---|---|---|
| 20:30 | 04:30 | `…-08-foundation` | 同现在 |
| 21:50 | 05:50 | `…-08-editorial` | 同现在（冻结 + PushDeer） |
| **22:00** | **06:00** | `…-08-papers` | 同现在的 08:00 节点，**去掉邮件那一段**（不列订阅、不 spawn deliver）；保留 `ensurePriorStageSnapshots` / `prepareNewsReviewStep` / papers 重建 / papers 推送 / finalize 推送 / `generateDailyPage` |
| 00:00 | 08:00 | **新** `…-08-deliver` | 只发邮件：`ensurePriorStageSnapshots`（缺才补建，不做外部推送）→ papers 快照缺失时重建（不推送）→ 列 `send_slot=8` 订阅 → spawn deliver。**不**调 `prepareNewsReviewStep`、不推送任何 stage、不生成日报页 |
| 04:00 / 09:00 | 12:00 / 17:00 | 不变 | 不变 |

- `stagedEnabled=false`（v1 回滚开关）时：20:30/21:50/22:00 返回 `[]`，00:00 仍是原 v1 全量节点（含邮件）。行为与今天一致。
- `NodeRunParams.dailyStage` 增加 `'deliver'`；workflow id 唯一（`digest-node-<date>-08-deliver`）。
- `STAGED_STAGE_DEADLINES`：foundation 04:30+15、editorial 05:50+10、papers 06:00+20、finalize 06:00+25。告警文案里的时刻用 `dueMinuteBjt` 计算（已是）。
- 注释与 `wrangler.toml`/文档里所有「06:30/07:50/08:00」描述同步改。`Env.DAILY_STAGED_PUSH_ENABLED` 注释同改。

## 3. 面板（dailyVideo）

- `deploy/aifeeds-render/aifeeds-daily-submit.timer`：`OnCalendar=*-*-* 06:40:00 Asia/Shanghai`；`test_daily_submit.py` 断言同改。服务器上 `/etc/systemd/system/aifeeds-daily-submit.timer` 手动替换 + `daemon-reload` + `restart aifeeds-daily-submit.timer`。
- `run.mjs`：`NEWS_REVIEW_FREEZE_LABEL = "05:50"`；静态说明「07:50 默认前五会立即进入生产」改为「05:50 冻结、06:00 默认前五进入生产」；其余引用该常量的文案自动跟随。随下一次 render release 生效。

## 4. 测试

- `node-run.test.ts`：路由表改成 20:30/21:50/22:00/00:00（staged）与 v1 回滚下 22:00 为空、00:00 仍为全量；22:00 节点不 spawn deliver（`DIGEST_DELIVER_WORKFLOW.create` 未被调用）、00:00 deliver 节点只 spawn deliver 且不调用 `pushStageStep`/`prepareNewsReviewStep`/`generateDailyPage`；deliver 节点在 papers 快照缺失时重建但不推送。
- `staged-stage-monitor.test.ts`：新 deadline 表。
- `npm test` + `tsc --noEmit` 全绿。

## 5. 验收

- prod 部署后次日：04:30 foundation、05:50 editorial + PushDeer、06:00 papers + finalize，渲染机 06:0x 出片，`share/latest` 06:15 前更新；08:00 邮件照发（`digest_deliver` 记录）；staged 监控无误报。
- 已知取舍（owner 已接受）：北京 06:00 = 美西前一日 15:00，美国下午 15–17 点发布的消息推到次日。

## 6. 非目标

- 12:00 / 17:00 邮件节点不动；订阅页面文案「早 8 点」不动。
- 渲染机的 `RuntimeMaxSec` / TTS 预算不动。
