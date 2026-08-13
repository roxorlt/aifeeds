-- Explicit key lineage for response authentication and persisted manual proofs.
-- Empty defaults preserve legacy rows as unidentified; application reads treat
-- those IDs as unavailable and fail hidden without mutating them.
ALTER TABLE manual_news_evidence
  ADD COLUMN response_key_id TEXT NOT NULL DEFAULT ''
  CHECK (length(response_key_id) <= 64);

ALTER TABLE manual_news_assessment_verifications
  ADD COLUMN verification_key_id TEXT NOT NULL DEFAULT ''
  CHECK (length(verification_key_id) <= 64);
