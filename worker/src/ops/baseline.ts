// 运营看板内容池 — 滑动基线计算 cron
// 设计：docs/plans/2026-05-21-ops-pool-design.md § 5
// 每日 BJT 凌晨跑 1 次（KV 哨兵防 5min cron 多触发），算 X score P90/P99 + 增速 P95
// 写 ops_pool_baseline 表，detect cron 读这张表做对比

import type { Env } from '../index';
import { OPS_CONFIG } from './config';

const KV_SENTINEL_KEY = 'ops:baseline:last_run_bjt_date';

export type BaselineRow = {
  source_type: string;
  metric_key: string;
  value: number;
  sample_size: number;
};

export type BaselineResult = {
  skipped?: boolean;
  computed?: BaselineRow[];
  error?: string;
};

export async function runOpsBaseline(env: Env): Promise<BaselineResult> {
  // KV 哨兵：同一 BJT 日已跑过就跳过
  const bjtDate = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const last = await env.AUTH_KV.get(KV_SENTINEL_KEY);
  if (last === bjtDate) {
    return { skipped: true };
  }

  try {
    const computed: BaselineRow[] = [];

    // §1 X score P90 + P99 (AI only, OPS_CONFIG.BASELINE_SCORE_WINDOW_DAYS 滑动)
    const scoreRow = await env.DB.prepare(`
      WITH scored AS (
        SELECT
            COALESCE(json_extract(metrics, '$.likes'), 0) * 1
          + COALESCE(json_extract(metrics, '$.bookmarks'), 0) * 10
          + COALESCE(json_extract(metrics, '$.replies'), 0) * 13.5
          + COALESCE(json_extract(metrics, '$.retweets'), 0) * 20 AS score
        FROM items
        WHERE source_type = 'x_list' AND is_relevant = 1
          AND scraped_at > datetime('now', '-${OPS_CONFIG.BASELINE_SCORE_WINDOW_DAYS} days')
          AND metrics IS NOT NULL
      ),
      ranked AS (
        SELECT score, NTILE(100) OVER (ORDER BY score) AS pct
        FROM scored WHERE score > 0
      )
      SELECT
        MIN(CASE WHEN pct = 90 THEN score END) AS p90,
        MIN(CASE WHEN pct = 99 THEN score END) AS p99,
        COUNT(*) AS n
      FROM ranked
    `).first<{ p90: number | null; p99: number | null; n: number }>();

    if (scoreRow && scoreRow.p90 != null && scoreRow.p99 != null) {
      computed.push({ source_type: 'x_list', metric_key: 'score_p90', value: scoreRow.p90, sample_size: scoreRow.n });
      computed.push({ source_type: 'x_list', metric_key: 'score_p99', value: scoreRow.p99, sample_size: scoreRow.n });
    }

    // §2 X likes/h 增速 P95 (captured_at 是秒级 INTEGER，跟 items.scraped_at 不同)
    const rateRow = await env.DB.prepare(`
      WITH snaps AS (
        SELECT
          s.item_id,
          s.captured_at,
          s.likes,
          LAG(s.likes) OVER (PARTITION BY s.item_id ORDER BY s.captured_at) AS prev_likes,
          LAG(s.captured_at) OVER (PARTITION BY s.item_id ORDER BY s.captured_at) AS prev_at
        FROM metrics_snapshots s
        JOIN items i ON i.id = s.item_id
        WHERE i.is_relevant = 1
          AND s.captured_at > (strftime('%s', 'now') - ${OPS_CONFIG.BASELINE_RATE_WINDOW_DAYS} * 86400)
      ),
      rates AS (
        SELECT CAST((likes - prev_likes) AS REAL) * 3600 / NULLIF(captured_at - prev_at, 0) AS rate
        FROM snaps
        WHERE prev_at IS NOT NULL
          AND captured_at - prev_at > 60
          AND likes >= prev_likes
      ),
      ranked AS (
        SELECT rate, NTILE(100) OVER (ORDER BY rate) AS pct
        FROM rates WHERE rate > 0
      )
      SELECT
        MIN(CASE WHEN pct = 95 THEN rate END) AS p95,
        COUNT(*) AS n
      FROM ranked
    `).first<{ p95: number | null; n: number }>();

    if (rateRow && rateRow.p95 != null) {
      computed.push({ source_type: 'x_list', metric_key: 'rate_p95', value: rateRow.p95, sample_size: rateRow.n });
    }

    // 写入 baseline 表（UPSERT 覆盖前一日值）
    const now = Math.floor(Date.now() / 1000);
    if (computed.length > 0) {
      await env.DB.batch(
        computed.map((c) =>
          env.DB.prepare(`
            INSERT INTO ops_pool_baseline (source_type, metric_key, value, computed_at, sample_size)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(source_type, metric_key) DO UPDATE SET
              value = excluded.value,
              computed_at = excluded.computed_at,
              sample_size = excluded.sample_size
          `).bind(c.source_type, c.metric_key, c.value, now, c.sample_size),
        ),
      );
    }

    // 标记今天已跑
    await env.AUTH_KV.put(KV_SENTINEL_KEY, bjtDate, { expirationTtl: 25 * 3600 });

    return { computed };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
