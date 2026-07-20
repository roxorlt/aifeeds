-- 030: make each admin mirror decision a unique concurrency authority.
-- Existing overrides remain readable by Task 4/5 and receive the empty legacy
-- marker; every new admin decision replaces it with a non-empty random token.

ALTER TABLE cc_item_overrides
  ADD COLUMN decision_token TEXT NOT NULL DEFAULT '';
