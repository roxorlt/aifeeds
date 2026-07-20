# CC Global Journal Preparing Protocol Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:systematic-debugging task-by-task.

**Goal:** Remove the global-marker hard-link crash wedge and make every pre-commit live-path mutation recover as an explicit rollback rather than an unsafe forward finalize.

**Architecture:** Publish root-owned `0600` preparing and committed markers through candidates held in a dedicated root-owned `0700` journal directory. A preparing marker durably binds the release, the four destination/transaction/receipt paths, their prior identities, and original systemd state; each receipt is atomically armed in that marker before its live mutation. Startup rolls a valid preparing deployment back and restores runtime state, while only a fully validated committed marker may finalize. Candidate recovery is deliberately narrow: one controlled candidate with the canonical marker's exact inode may be removed; every extra, foreign, linked, or symbolic object fails closed.

**Tech Stack:** Node.js 18 filesystem primitives, Bash installer orchestration, `node:test`.

---

### Task 1: Global marker hard-link crash recovery

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Modify: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/test/fixtures/publish-and-pause.mjs`

1. Add a child-process fixture that pauses immediately after marker hard-link publication and directory fsync but before candidate unlink.
2. Add RED tests that SIGKILL the fixture for preparing and committed markers and prove the canonical marker and candidate share one inode with `nlink=2`.
3. Add RED rejection cases for multiple candidate links, a different-inode controlled candidate, an arbitrary hard link, and a symlink candidate.
4. Implement a root-owned `0700` journal-candidate directory and controlled phase-specific candidate naming.
5. Before reading a canonical marker, inspect it and the whole candidate directory without following links. Repair only the exact one-candidate/same-inode/owner/mode/`nlink=2` state, fsync the directory, and then require canonical `nlink=1`.
6. Re-run the focused crash and adversarial-link tests.

### Task 2: Durable preparing marker and receipt arming

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add RED unit tests for creating a preparing marker before any transaction directory and rejecting orphan transaction receipts without a valid marker.
2. Store schema, phase, manifest/release, original service/timer states, Nginx rollback path, and all four planned destination/transaction/receipt/type/prior-identity records.
3. Add an `afterReceiptPrepared` hook to file and symlink transactions.
4. Atomically arm the matching preparing entry after receipt fsync and before the first live rename/link; bind transaction and receipt inode plus receipt-header digest and candidate identity.
5. Remove the installer's old `recover-*` then immediate `finalize-path` preflight. Scan all four destination parents for orphan transaction directories and fail closed if no valid global marker owns them.
6. Run focused preparing/arming/orphan tests and existing path-transaction tests.

### Task 3: Preparing rollback versus committed finalize

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Modify: `cc-site/sync/test/deployment.test.mjs`

1. Extend the remote harness to SIGKILL the installer after path publications 1, 2, 3, and 4, plus immediately before committed-marker creation after health checks.
2. Add RED restart tests proving startup rolls every valid preparing transaction back, restores old OPT/env/unit bytes and original service/timer active/enabled state, and then permits a clean redeploy.
3. Implement idempotent preparing recovery: validate planned/armed receipts, roll back armed or published paths, safely clean prepared-but-unpublished receipts, and never call forward recovery/finalization.
4. Keep the preparing marker until Nginx and systemd restoration succeeds; only then validate old live identities and remove/fsync it.
5. Create the committed marker only after health and timer activation, validating all four armed receipts and live candidate identities. A valid committed marker supersedes its matching preparing marker.
6. Preserve best-effort committed finalization and fail closed on every marker/receipt mismatch.
7. Run focused kill/restart, committed-finalize, rollback, and mismatch tests.

### Task 4: Verification and local commit

1. Run focused journal/path tests.
2. Run `node --test cc-site/sync/test/deployment.test.mjs` with loopback permission.
3. Run `npm test` from `cc-site/sync` with loopback permission.
4. Run `node --test cc-site/sync/test/publish-indexes.test.mjs`.
5. Run Bash syntax checks separately and `node --check` for every sync `.mjs`.
6. Run payload allowlist, secret/local-path, and `git diff --check` scans.
7. Commit locally and confirm the worktree is clean. Do not push or deploy.
