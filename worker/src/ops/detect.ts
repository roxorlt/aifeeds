// 运营看板内容池 — 池子检测 cron（每 30min 跑一次）
// 设计：docs/plans/2026-05-21-ops-pool-design.md § 5
// 一处坑全坑：所有 SQL 必须 is_relevant = 1（设计 § 3）
//
// 4 件事：
//   1. hot 标：score > P90 → UPDATE items.is_hot = 1（仅 update 增量）
//   2. 爆推：score > P99 AND likes >= 300 → 写 ops_pool_items + PushDeer
//   3. 趋势推：最近 snapshot pair 增速 > P95 AND likes_total >= 50 → 写池 + push
//   4. 发现博主：14d distinct_tweets >= 5 AND not in list → 写池 + push
//
// PushDeer 通过 OPS_PUSHDEER_ENABLED env flag 控制（先跑不推 3 天）。

import type { Env } from '../index';
import { pushDeerAlert } from '../notifier';

const BAOPUI_LIKES_MIN = 300;
const TREND_LIKES_MIN = 50;
const DISCOVER_DISTINCT_TWEETS_MIN = 5;
const DISCOVER_WINDOW_DAYS = 14;
const PROD_HOST = 'https://ai-feeds.com';

export type DetectResult = {
  hot_marked: number;
  baopui_added: number;
  trend_added: number;
  discover_added: number;
  pushed: number;
  skipped_no_baseline?: boolean;
  error?: string;
};

type PushItem = { pool: string; itemKey: string; title: string; body: string };

async function readBaseline(env: Env): Promise<Map<string, number>> {
  const rs = await env.DB.prepare(
    `SELECT source_type, metric_key, value FROM ops_pool_baseline`,
  ).all<{ source_type: string; metric_key: string; value: number }>();
  const map = new Map<string, number>();
  for (const r of rs.results || []) {
    map.set(`${r.source_type}:${r.metric_key}`, r.value);
  }
  return map;
}

async function tryInsertPool(
  env: Env,
  pool: string,
  itemId: string,
  payload: Record<string, unknown>,
  now: number,
): Promise<boolean> {
  const r = await env.DB.prepare(`
    INSERT INTO ops_pool_items (pool_type, item_id, payload, added_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(pool_type, item_id) DO NOTHING
  `).bind(pool, itemId, JSON.stringify(payload), now).run();
  return (r.meta.changes || 0) > 0;
}

function tweetUrl(itemId: string): string {
  const tid = itemId.replace(/^x_list:/, '');
  return `${PROD_HOST}/x/${tid}`;
}

export async function runOpsDetect(env: Env): Promise<DetectResult> {
  const result: DetectResult = {
    hot_marked: 0, baopui_added: 0, trend_added: 0, discover_added: 0, pushed: 0,
  };

  try {
    const baseline = await readBaseline(env);
    const scoreP90 = baseline.get('x_list:score_p90');
    const scoreP99 = baseline.get('x_list:score_p99');
    const rateP95 = baseline.get('x_list:rate_p95');

    if (scoreP90 == null || scoreP99 == null) {
      result.skipped_no_baseline = true;
      return result;
    }

    const pushEnabled = env.OPS_PUSHDEER_ENABLED === 'true';
    const now = Math.floor(Date.now() / 1000);
    const pushList: PushItem[] = [];

    // ─── 1) hot 标 — score > P90 (AI 7d) UPDATE 增量 ─────────────
    const hotUpdate = await env.DB.prepare(`
      UPDATE items
      SET is_hot = 1
      WHERE source_type = 'x_list'
        AND is_relevant = 1
        AND scraped_at > (strftime('%s', 'now') - 7 * 86400) * 1000
        AND metrics IS NOT NULL
        AND COALESCE(is_hot, 0) = 0
        AND (
          COALESCE(json_extract(metrics, '$.likes'), 0) * 1
          + COALESCE(json_extract(metrics, '$.bookmarks'), 0) * 10
          + COALESCE(json_extract(metrics, '$.replies'), 0) * 13.5
          + COALESCE(json_extract(metrics, '$.retweets'), 0) * 20
        ) > ?
    `).bind(scoreP90).run();
    result.hot_marked = hotUpdate.meta.changes || 0;

    // ─── 2) 爆推 — score > P99 AND likes >= 300 (AI 24h) ─────────
    const baopuiRows = await env.DB.prepare(`
      SELECT
        id, handle, content_translated, content,
        COALESCE(json_extract(metrics, '$.likes'), 0) AS likes,
        COALESCE(json_extract(metrics, '$.retweets'), 0) AS retweets,
        COALESCE(json_extract(metrics, '$.replies'), 0) AS replies,
        COALESCE(json_extract(metrics, '$.bookmarks'), 0) AS bookmarks,
        (
          COALESCE(json_extract(metrics, '$.likes'), 0) * 1
          + COALESCE(json_extract(metrics, '$.bookmarks'), 0) * 10
          + COALESCE(json_extract(metrics, '$.replies'), 0) * 13.5
          + COALESCE(json_extract(metrics, '$.retweets'), 0) * 20
        ) AS score
      FROM items
      WHERE source_type = 'x_list' AND is_relevant = 1
        AND scraped_at > (strftime('%s', 'now') - 24 * 3600) * 1000
        AND metrics IS NOT NULL
        AND COALESCE(json_extract(metrics, '$.likes'), 0) >= ?
        AND (
          COALESCE(json_extract(metrics, '$.likes'), 0) * 1
          + COALESCE(json_extract(metrics, '$.bookmarks'), 0) * 10
          + COALESCE(json_extract(metrics, '$.replies'), 0) * 13.5
          + COALESCE(json_extract(metrics, '$.retweets'), 0) * 20
        ) > ?
      ORDER BY score DESC
      LIMIT 50
    `).bind(BAOPUI_LIKES_MIN, scoreP99).all<{
      id: string; handle: string;
      content_translated: string | null; content: string | null;
      likes: number; retweets: number; replies: number; bookmarks: number;
      score: number;
    }>();

    for (const r of baopuiRows.results || []) {
      const inserted = await tryInsertPool(env, 'baopui', r.id, {
        score: Math.round(r.score),
        likes: r.likes, retweets: r.retweets, replies: r.replies, bookmarks: r.bookmarks,
        threshold: Math.round(scoreP99),
        handle: r.handle,
      }, now);
      if (inserted) {
        result.baopui_added++;
        const snippet = (r.content_translated || r.content || '').slice(0, 80);
        pushList.push({
          pool: 'baopui',
          itemKey: r.id,
          title: `🔥 爆推 · @${r.handle}`,
          body: `score ${Math.round(r.score)}（阈值 P99=${Math.round(scoreP99)}）\n`
            + `likes ${r.likes} / retweets ${r.retweets} / replies ${r.replies} / bookmarks ${r.bookmarks}\n\n`
            + `${snippet}\n\n${tweetUrl(r.id)}`,
        });
      }
    }

    // ─── 3) 趋势推 — 最近 6h 内 snapshot pair 增速 > P95 ──────────
    if (rateP95 != null) {
      const trendRows = await env.DB.prepare(`
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
            AND s.captured_at > (strftime('%s', 'now') - 6 * 3600)
        ),
        latest AS (
          SELECT item_id, MAX(captured_at) AS captured_at FROM snaps GROUP BY item_id
        ),
        rates AS (
          SELECT
            s.item_id,
            s.likes,
            CAST((s.likes - s.prev_likes) AS REAL) * 3600 / NULLIF(s.captured_at - s.prev_at, 0) AS rate
          FROM snaps s
          JOIN latest l ON l.item_id = s.item_id AND l.captured_at = s.captured_at
          WHERE s.prev_at IS NOT NULL
            AND s.captured_at - s.prev_at > 60
            AND s.likes >= s.prev_likes
        )
        SELECT r.item_id AS id, r.rate, r.likes,
               i.handle, i.content, i.content_translated
        FROM rates r
        JOIN items i ON i.id = r.item_id
        WHERE r.likes >= ? AND r.rate > ?
        ORDER BY r.rate DESC
        LIMIT 30
      `).bind(TREND_LIKES_MIN, rateP95).all<{
        id: string; rate: number; likes: number;
        handle: string; content: string | null; content_translated: string | null;
      }>();

      for (const r of trendRows.results || []) {
        const inserted = await tryInsertPool(env, 'trend', r.id, {
          rate: Math.round(r.rate),
          likes: r.likes,
          threshold: Math.round(rateP95),
          handle: r.handle,
        }, now);
        if (inserted) {
          result.trend_added++;
          const snippet = (r.content_translated || r.content || '').slice(0, 80);
          pushList.push({
            pool: 'trend',
            itemKey: r.id,
            title: `📈 趋势推 · @${r.handle}`,
            body: `增速 ${Math.round(r.rate)} likes/h（阈值 P95=${Math.round(rateP95)}）\n`
              + `当前 likes ${r.likes}\n\n${snippet}\n\n${tweetUrl(r.id)}`,
          });
        }
      }
    }

    // ─── 4) 发现博主 — 14d distinct_tweets >= 5 AND not in list ─
    const discoverRows = await env.DB.prepare(`
      WITH known AS (
        SELECT DISTINCT handle FROM items WHERE source_type='x_list' AND handle IS NOT NULL
      ),
      mentions AS (
        SELECT
          json_extract(extra, '$.quote_of.handle') AS h,
          json_extract(extra, '$.quote_of.id') AS src_tid
        FROM items
        WHERE source_type='x_list' AND is_relevant=1
          AND json_extract(extra, '$.quote_of.handle') IS NOT NULL
          AND scraped_at > (strftime('%s','now') - 14 * 86400) * 1000
        UNION ALL
        SELECT
          json_extract(extra, '$.reply_of.handle'),
          json_extract(extra, '$.reply_of.id')
        FROM items
        WHERE source_type='x_list' AND is_relevant=1
          AND json_extract(extra, '$.reply_of.handle') IS NOT NULL
          AND scraped_at > (strftime('%s','now') - 14 * 86400) * 1000
      )
      SELECT
        h AS handle,
        COUNT(*) AS total_mentions,
        COUNT(DISTINCT src_tid) AS distinct_tweets,
        ROUND(CAST(COUNT(*) AS REAL) / COUNT(DISTINCT src_tid), 1) AS dilution
      FROM mentions
      WHERE h NOT IN (SELECT handle FROM known)
      GROUP BY h
      HAVING COUNT(DISTINCT src_tid) >= ?
      ORDER BY distinct_tweets DESC
    `).bind(DISCOVER_DISTINCT_TWEETS_MIN).all<{
      handle: string; total_mentions: number; distinct_tweets: number; dilution: number;
    }>();

    for (const r of discoverRows.results || []) {
      // discover 池用 'handle:<handle>' 当 item_id (hack 复用主键)
      const itemKey = `handle:${r.handle}`;
      const inserted = await tryInsertPool(env, 'discover', itemKey, {
        handle: r.handle,
        distinct_tweets: r.distinct_tweets,
        total_mentions: r.total_mentions,
        dilution: r.dilution,
        window_days: DISCOVER_WINDOW_DAYS,
      }, now);
      if (inserted) {
        result.discover_added++;
        pushList.push({
          pool: 'discover',
          itemKey,
          title: `👤 发现博主 · @${r.handle}`,
          body: `14 天被引用 ${r.distinct_tweets} 条不同 tweet（共 ${r.total_mentions} 次提及，dilution ${r.dilution}）\n\n`
            + `https://x.com/${r.handle}`,
        });
      }
    }

    // ─── 5) PushDeer 推送（只对刚 INSERT 的新 item）─────────────
    if (pushEnabled && pushList.length > 0) {
      for (const p of pushList) {
        try {
          await pushDeerAlert(env, p.title, p.body);
          await env.DB.prepare(
            `UPDATE ops_pool_items SET pushed_at = ? WHERE pool_type = ? AND item_id = ?`,
          ).bind(now, p.pool, p.itemKey).run();
          result.pushed++;
        } catch (e) {
          console.error('[ops-detect push]', e);
        }
      }
    }

    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    return result;
  }
}
