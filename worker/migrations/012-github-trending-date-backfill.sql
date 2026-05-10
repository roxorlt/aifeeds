-- Backfill items.extra.trending_date_str + recompute daily_rank for today.
--
-- Pre-fix the field was set only on first INSERT and stayed frozen, so repos
-- still on trending today were excluded from today's daily_rank query
-- (it filters by trending_date_str = today). The forward fix in
-- worker/src/github.ts ON CONFLICT now keeps the field current on every
-- Phase-1 run; this migration handles the historical drift.
--
-- Two steps:
--   1) Realign trending_date_str to BJT(last_seen_on_trending_at) for any
--      github row seen on trending in the last 30 days
--   2) Recompute daily_rank for the most recent trending_date_str (so the
--      dashboard's "today" leaderboard reflects current state immediately
--      instead of waiting for the next BJT 01:00 cron tick to enrich a new
--      pending row and trigger the rank update side effect)
--
-- Apply order:
--   wrangler d1 execute xlist-staging --env staging --remote --file=migrations/012-github-trending-date-backfill.sql
--   wrangler d1 execute xlist          --remote                  --file=migrations/012-github-trending-date-backfill.sql

-- ─── Step 1: realign trending_date_str ─────────────────────────────────────
UPDATE items
SET extra = json_set(
  extra,
  '$.trending_date_str',
  date(
    CAST(json_extract(extra, '$.last_seen_on_trending_at') AS INTEGER),
    'unixepoch',
    '+8 hours'
  )
)
WHERE source_type = 'github'
  AND json_extract(extra, '$.last_seen_on_trending_at') IS NOT NULL
  AND CAST(json_extract(extra, '$.last_seen_on_trending_at') AS INTEGER) >
      CAST(unixepoch('now', '-30 days') AS INTEGER);

-- ─── Step 2: recompute daily_rank for the latest trending day ──────────────
UPDATE items
SET extra = json_set(extra, '$.daily_rank', sub.new_rank)
FROM (
  SELECT id,
         ROW_NUMBER() OVER (
           ORDER BY CAST(json_extract(metrics, '$.today_stars') AS INTEGER) DESC,
                    CAST(json_extract(metrics, '$.stars') AS INTEGER) DESC
         ) AS new_rank
    FROM items
   WHERE source_type = 'github'
     AND is_relevant = 1
     AND COALESCE(CAST(json_extract(extra, '$.sponsor') AS INTEGER), 0) = 0
     AND deleted_at IS NULL
     AND json_extract(extra, '$.trending_date_str') = (
       SELECT MAX(json_extract(extra, '$.trending_date_str'))
         FROM items
        WHERE source_type = 'github'
          AND is_relevant = 1
          AND deleted_at IS NULL
     )
) AS sub
WHERE items.id = sub.id;

-- Clear stale daily_rank from rows whose trending_date_str is NOT the latest
-- (so dashboard's ORDER BY trending_date_str DESC, daily_rank ASC ranking
-- doesn't see leftover ranks pointing at older days).
UPDATE items
SET extra = json_remove(extra, '$.daily_rank')
WHERE source_type = 'github'
  AND json_extract(extra, '$.daily_rank') IS NOT NULL
  AND json_extract(extra, '$.trending_date_str') != (
    SELECT MAX(json_extract(extra, '$.trending_date_str'))
      FROM items
     WHERE source_type = 'github'
       AND is_relevant = 1
       AND deleted_at IS NULL
  );
