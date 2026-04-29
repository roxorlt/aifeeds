-- M3: Initial tier backfill for all x_list items.
-- Age buckets map to tier ids:
--   <1h        → L0 (tier=0, next_refresh +10min)
--   1-6h       → L1 (tier=1, next_refresh +20min)
--   6-24h      → L2 (tier=2, next_refresh +60min)
--   1-7d       → L3 (tier=3, next_refresh +6h)
--   7-14d      → L4 (tier=4, next_refresh +3d)
--   >14d       → L5 (tier=5, next_refresh NULL — never)
--
-- last_velocity = likes / age_minutes (cumulative average proxy; M5 will
-- replace with real Δlikes/Δt from metrics_snapshots once enough data is
-- accumulated).

UPDATE items
SET
  tier = CASE
    WHEN (unixepoch('now') - unixepoch(published_at)) < 3600 THEN 0
    WHEN (unixepoch('now') - unixepoch(published_at)) < 21600 THEN 1
    WHEN (unixepoch('now') - unixepoch(published_at)) < 86400 THEN 2
    WHEN (unixepoch('now') - unixepoch(published_at)) < 604800 THEN 3
    WHEN (unixepoch('now') - unixepoch(published_at)) < 1209600 THEN 4
    ELSE 5
  END,
  next_refresh_at = CASE
    WHEN (unixepoch('now') - unixepoch(published_at)) < 3600 THEN unixepoch('now') + 600
    WHEN (unixepoch('now') - unixepoch(published_at)) < 21600 THEN unixepoch('now') + 1200
    WHEN (unixepoch('now') - unixepoch(published_at)) < 86400 THEN unixepoch('now') + 3600
    WHEN (unixepoch('now') - unixepoch(published_at)) < 604800 THEN unixepoch('now') + 21600
    WHEN (unixepoch('now') - unixepoch(published_at)) < 1209600 THEN unixepoch('now') + 259200
    ELSE NULL
  END,
  last_velocity = CASE
    WHEN (unixepoch('now') - unixepoch(published_at)) < 60 THEN 0
    WHEN json_extract(metrics, '$.likes') IS NULL THEN 0
    ELSE (json_extract(metrics, '$.likes') * 1.0) / ((unixepoch('now') - unixepoch(published_at)) / 60.0)
  END
WHERE source_type = 'x_list';
