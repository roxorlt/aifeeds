ALTER TABLE daily_news_review_batches ADD COLUMN batch_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE daily_news_review_batches ADD COLUMN supersedes_batch_id TEXT;
ALTER TABLE daily_news_review_batches ADD COLUMN revision_origin TEXT NOT NULL DEFAULT 'scheduled_freeze';
ALTER TABLE daily_news_review_batches ADD COLUMN lineage_id TEXT NOT NULL DEFAULT '';
ALTER TABLE daily_news_review_batches ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_news_review_batches ADD COLUMN candidate_generation INTEGER NOT NULL DEFAULT 0;

UPDATE daily_news_review_batches SET lineage_id = review_date WHERE lineage_id = '';
WITH ranked_legacy AS (
  SELECT rowid AS legacy_rowid,
         FIRST_VALUE(batch_id) OVER (
           PARTITION BY review_date ORDER BY created_at DESC, rowid DESC
         ) AS winner_batch_id,
         ROW_NUMBER() OVER (
           PARTITION BY review_date ORDER BY created_at DESC, rowid DESC
         ) AS legacy_rank
  FROM daily_news_review_batches
  WHERE superseded_by IS NULL
)
UPDATE daily_news_review_batches
SET superseded_by = (
      SELECT winner_batch_id FROM ranked_legacy
      WHERE legacy_rowid = daily_news_review_batches.rowid
    ),
    is_current = 0
WHERE rowid IN (SELECT legacy_rowid FROM ranked_legacy WHERE legacy_rank > 1);

UPDATE daily_news_review_batches
SET is_current = CASE WHEN superseded_by IS NULL THEN 1 ELSE 0 END;

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_news_review_one_current
  ON daily_news_review_batches(review_date, lineage_id) WHERE is_current = 1;

-- A date/lineage-scoped monotonic generation closes the pre-freeze confirmation
-- race. Existing dates start at generation 0 and are initialized lazily, so a
-- rollout over already-created review batches remains safe.
CREATE TABLE IF NOT EXISTS daily_news_review_candidate_generations (
  review_date TEXT NOT NULL,
  lineage_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (review_date, lineage_id)
);

CREATE TABLE IF NOT EXISTS manual_news_leads (
  id TEXT PRIMARY KEY,
  review_date TEXT NOT NULL,
  input_type TEXT NOT NULL,
  input_text TEXT NOT NULL DEFAULT '',
  input_url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error_message TEXT,
  submit_idempotency_key TEXT NOT NULL,
  last_mutation_kind TEXT,
  last_mutation_idempotency_key TEXT,
  processing_owner TEXT,
  processing_attempt INTEGER NOT NULL DEFAULT 0,
  processing_lease_until INTEGER,
  confirmed_batch_id TEXT,
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(review_date, submit_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_manual_news_leads_date
  ON manual_news_leads(review_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_news_leads_status
  ON manual_news_leads(status, updated_at);

CREATE TABLE IF NOT EXISTS manual_news_evidence (
  lead_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  publisher TEXT NOT NULL,
  published_at TEXT,
  retrieved_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  claims_supported_json TEXT NOT NULL,
  fetch_audit_json TEXT NOT NULL DEFAULT 'null',
  reliable INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (lead_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_manual_news_evidence_lead
  ON manual_news_evidence(lead_id, retrieved_at);

CREATE TABLE IF NOT EXISTS manual_news_event_assessments (
  lead_id TEXT NOT NULL,
  assessment_version INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  material_update INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL,
  recommendation TEXT NOT NULL,
  assessment_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lead_id, assessment_version)
);

CREATE INDEX IF NOT EXISTS idx_manual_news_assessments_event
  ON manual_news_event_assessments(event_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_items_event_fingerprint
  ON items(json_extract(extra, '$.event_fingerprint'))
  WHERE json_extract(extra, '$.event_fingerprint') IS NOT NULL;

CREATE TABLE IF NOT EXISTS manual_news_lead_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  idempotency_key TEXT,
  resulting_version INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_news_lead_audit
  ON manual_news_lead_audit(lead_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_news_lead_audit_version
  ON manual_news_lead_audit(lead_id, resulting_version, action);
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_news_lead_audit_idempotency
  ON manual_news_lead_audit(lead_id, action, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
