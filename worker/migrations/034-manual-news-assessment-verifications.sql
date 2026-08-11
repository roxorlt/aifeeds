-- Durable, independently verifiable attestation for a manual-news assessment.
-- Migration 033 remains immutable; legacy assessment rows have no active proof
-- and are therefore treated as untrusted by application reads.
CREATE TABLE IF NOT EXISTS manual_news_assessment_verifications (
  verification_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  assessment_version INTEGER NOT NULL CHECK (assessment_version > 0),
  policy_version TEXT NOT NULL,
  canonical_digest TEXT NOT NULL CHECK (length(canonical_digest) = 64),
  hmac_sha256 TEXT NOT NULL CHECK (length(hmac_sha256) = 64),
  verification_json TEXT NOT NULL,
  processing_owner TEXT NOT NULL,
  processing_attempt INTEGER NOT NULL CHECK (processing_attempt > 0),
  creation_nonce TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'invalidated')),
  reason TEXT,
  created_at INTEGER NOT NULL,
  invalidated_at INTEGER,
  CHECK (
    (status = 'active' AND reason IS NULL AND invalidated_at IS NULL)
    OR (status = 'invalidated' AND reason IS NOT NULL AND invalidated_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_news_verification_one_active_lead
  ON manual_news_assessment_verifications(lead_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_manual_news_verification_active_lead
  ON manual_news_assessment_verifications(lead_id, assessment_version DESC)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_manual_news_verification_history
  ON manual_news_assessment_verifications(lead_id, created_at DESC);

-- Evidence/verification audit events may legitimately repeat at the same lead
-- version across fenced Workflow attempts. Keep the original version-level
-- uniqueness for state transitions while allowing these immutable event rows.
DROP INDEX IF EXISTS idx_manual_news_lead_audit_version;
CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_news_lead_audit_version
  ON manual_news_lead_audit(lead_id, resulting_version, action)
  WHERE action NOT IN (
    'evidence_replace', 'verification_create', 'assessment_invalidate', 'verification_quarantine'
  );
