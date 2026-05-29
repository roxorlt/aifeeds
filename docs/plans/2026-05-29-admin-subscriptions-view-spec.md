# 后台订阅看板规格（admin subscriptions view）

> FE 出规格，BE 实现（admin dashboard 是 worker 渲染：`worker/src/admin-dashboard.ts`）。2026-05-29。
> PM 需求：直观看到「每个推送时段有哪些用户、各自配置是什么」，要**看板（聚合）+ 明细（列表）**。

## 放哪 / 怎么接（沿用现有模式）

admin dashboard 现状：HTML 由 `serveAdminDashboardHtml` 渲染，数据走 `GET /api/admin/analytics?metric=<name>`（`handleAdminAnalytics`），鉴权 CF Access JWT（Basic Auth fallback，见 `admin.ts checkAdminAuth`）。前端各卡片用 `getJson('/api/admin/analytics?metric=X')` 拉数据填表。

两种落法（BE 定）：

- **A（推荐，省脚手架）**：在主看板加一组「订阅」卡片，`handleAdminAnalytics` 加下列 `metric` 分支即可。
- **B**：独立页 `/admin/subscriptions`（像 `/admin/ops`、`/admin/tasks`），顶部导航加一个 tab。后续若要加手动操作（踢出 / 重置）或数据量大，B 更合适。

数据源：`subscriptions` + `digest_send_log`（schema 见 `operations.md`「订阅推送子系统」§D1）。

## 一、看板（聚合卡片）

| metric | 展示 | 建议 SQL（D1） |
|--------|------|----------------|
| `sub-overview` | 总订阅数 + 状态分布 + 已注册占比 | `SELECT status, COUNT(*) n, SUM(user_id IS NOT NULL) registered FROM subscriptions GROUP BY status` |
| `sub-by-slot` | 各推送时段（8/12/17）active 数 ← **PM 核心诉求** | `SELECT send_slot, COUNT(*) FROM subscriptions WHERE status='active' GROUP BY send_slot` |
| `sub-by-density` | 默认 / 精选 active 数 | `SELECT density, COUNT(*) FROM subscriptions WHERE status='active' GROUP BY density` |
| `sub-by-source` | 各源被勾选数（热度） | `SELECT j.value src, COUNT(*) FROM subscriptions s, json_each(s.sources) j WHERE s.status='active' GROUP BY j.value` |
| `sub-delivery-7d` | 近 7 天投递：sent / no_items / failed_resend + welcome 数 + 成功率 | `SELECT status, COUNT(*) FROM digest_send_log WHERE sent_at > ? GROUP BY status` |
| `sub-growth-14d` | 近 14 天每日新增订阅 | `SELECT date(created_at/1000,'unixepoch','+8 hours') d, COUNT(*) FROM subscriptions GROUP BY d ORDER BY d` |

> status 对外口径：`paused`（Resend 故障致系统暂停，非用户原因）可归一成 active 或单列标「系统暂停」；`kicked`（bounce ≥2）单列。

## 二、明细（可筛选列表）

`GET /api/admin/analytics?metric=sub-list&slot=<8|12|17|all>&status=<active|unsubscribed|kicked|all>&limit=&offset=`

| 列 | 来源 | 备注 |
|----|------|------|
| 邮箱 | `email` | admin 已 CF Access 保护，可显示真值；要脱敏就中间打码 |
| 源 | `sources`(JSON) | 渲染成中文源名（热门产品 / 开源项目 / 论文 / 龙虾技能 / 动态） |
| 推送时段 | `send_slot` | 早 8 / 午 12 / 下午 17 |
| 档位 | `density` | 默认 / 精选 |
| 状态 | `status` | active / unsubscribed / kicked / paused |
| bounce | `bounce_count` | ≥2 即 kicked |
| 失败次数 | `worker_send_failures` | ≥5 即 paused（疑似 Resend 故障） |
| 上次推送 | `last_sent_at` | — |
| 订阅时间 | `created_at` | 默认倒序 |
| 已注册 | `user_id` 非空 | 区分匿名 vs 已注册 |

建议 SQL：
```sql
SELECT email, sources, send_slot, density, status, bounce_count,
       worker_send_failures, last_sent_at, created_at, user_id
FROM subscriptions
WHERE (?slot   = 'all' OR send_slot = ?slot)
  AND (?status = 'all' OR status   = ?status)
ORDER BY created_at DESC
LIMIT ? OFFSET ?;
```

筛选项：**按时段筛**（PM 核心诉求「每个时段有哪些用户」）、按状态筛、created_at 倒序、分页。

## 三、可选增强（后续，非首版）

- 每条下钻「最近一封 digest 实际发了啥」：`digest_send_log.slot_key` → `digest_pool`
- admin 手动操作：踢出 / 重置 bounce（写接口，谨慎，二次确认）
- 导出 CSV

## 验收

- 打开 admin dashboard → 看到：订阅总数 + 三个时段各多少人 + 源/档位分布 + 近 7 天投递成功率
- 明细按时段筛选 → 看到该时段每个订阅的「邮箱 + 源 + 时段 + 档位 + 状态」
