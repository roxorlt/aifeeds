-- Reliable, per-event warning outbox for exhausted feed workflow recovery.
-- All timestamps are UTC Unix epoch milliseconds.
CREATE TABLE warning_outbox (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  event_type TEXT NOT NULL CHECK (event_type = 'workflow_retry_exhausted'),
  source_type TEXT NOT NULL CHECK (source_type IN ('blog', 'podcast')),
  subject_id TEXT NOT NULL,
  dedup_period TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
  record_kind TEXT NOT NULL DEFAULT 'deliverable'
    CHECK (record_kind IN ('deliverable', 'producer_quarantine')),
  payload_json TEXT,
  payload_sha256 TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0
    CHECK (attempts >= 0 AND attempts <= 6),
  next_retry_at_ms INTEGER
    CHECK (next_retry_at_ms IS NULL OR next_retry_at_ms >= 0),
  lease_owner TEXT,
  lease_until_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  delivered_at_ms INTEGER,
  failed_at_ms INTEGER,
  last_error_code TEXT,
  last_error_detail TEXT,
  expires_at_ms INTEGER,
  CHECK (
    (record_kind = 'deliverable'
      AND payload_json IS NOT NULL
      AND payload_sha256 IS NOT NULL)
    OR
    (record_kind = 'producer_quarantine'
      AND payload_json IS NULL
      AND payload_sha256 IS NULL
      AND state = 'failed'
      AND attempts = 0
      AND next_retry_at_ms IS NULL
      AND lease_owner IS NULL
      AND lease_until_ms IS NULL
      AND delivered_at_ms IS NULL
      AND last_error_code IS NOT NULL
      AND last_error_code GLOB 'PRODUCER_*'
      AND failed_at_ms IS NOT NULL
      AND failed_at_ms >= 0
      AND expires_at_ms IS NOT NULL
      AND expires_at_ms > failed_at_ms)
  ),
  UNIQUE (event_type, source_type, subject_id, dedup_period)
);

CREATE INDEX warning_outbox_due_idx
  ON warning_outbox (state, next_retry_at_ms, lease_until_ms, created_at_ms, event_id);

CREATE INDEX warning_outbox_retention_idx
  ON warning_outbox (state, expires_at_ms, event_id);
