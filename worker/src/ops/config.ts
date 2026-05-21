// 运营看板内容池 — 所有阈值 / 时间窗口集中配置
// 设计：docs/plans/2026-05-21-ops-pool-design.md
//
// 改完跑 `cd worker && npm run deploy` 一条命令即可 prod 生效，无需找 SQL inline。
// SQL 用模板字符串拼接 — 这些常量来自代码不接收外部输入，无 injection 风险。

export const OPS_CONFIG = {
  // ─── 基线计算窗口（baseline cron 用，每日 BJT 02:10 跑） ───
  BASELINE_SCORE_WINDOW_DAYS: 7,   // X score P90/P99 计算的滑动窗口
  BASELINE_RATE_WINDOW_DAYS: 3,    // X likes/h 增速 P95 计算的滑动窗口

  // ─── 池子扫描窗口（detect cron 用，每 30min 跑） ───
  HOT_UPDATE_WINDOW_DAYS: 7,       // hot 标 UPDATE items.is_hot 的扫描窗口
  BAOPUI_WINDOW_HOURS: 24,         // 爆推扫描窗口
  TREND_SNAPSHOT_WINDOW_HOURS: 6,  // 趋势推取最近 snapshot pair 的窗口
  DISCOVER_WINDOW_DAYS: 14,        // 发现博主 distinct_tweets 计数窗口

  // ─── 池子绝对底线（防小样本误触发） ───
  BAOPUI_LIKES_MIN: 100,           // 爆推：score>P99 但 likes 至少要这么多
  TREND_LIKES_MIN: 50,             // 趋势推：rate>P95 但 likes_total 起跑线
  DISCOVER_DISTINCT_TWEETS_MIN: 3, // 发现博主：14d 被引用过几条不同 tweet 才进池

  // ─── 看板/UI 窗口（admin-ops.ts metric 用） ───
  POOL_DISPLAY_WINDOW_HOURS: 24,   // /admin/ops 爆推 + 趋势推 显示最近多久内进池
  DISCOVER_DISPLAY_WINDOW_DAYS: 14,
  HOT_DISPLAY_WINDOW_DAYS: 7,
} as const;
