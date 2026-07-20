# CC Deployment Transaction Important Follow-up Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:systematic-debugging task-by-task.

**Goal:** Close the remaining symlink publication crash window, make four-path deployment commit globally durable before cleanup, and cryptographically bind every release to its manifest.

**Architecture:** Keep each live path in its existing receipt-first transaction, but publish a symlink by create-exclusive inode-preserving hard link so its receipt identity remains stable across crashes. Add a root-only global deployment journal that is written only after all four local transactions verify their live candidates; once globally committed, receipt cleanup becomes retryable housekeeping rather than rollback-triggering work. Store the exact payload manifest in every immutable release and derive the release directory name from those bytes, using the manifest—not a mutable in-release allowlist—as the authority for release paths and hashes.

**Tech Stack:** Node.js 18 filesystem primitives, Bash installer orchestration, `node:test`.

---

### Task 1: Inode-preserving symlink publication

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add a failing filesystem test that interrupts after the live symlink is created but before a published receipt event; assert live `dev/ino` equals the receipt candidate and same-transaction recovery can safely continue and roll back.
2. Add a failing sibling case that replaces the interrupted live link with an operator-created link to the same target but a different inode; assert recovery reports a conflict and preserves it.
3. Run only these cases and record the expected identity/recovery failures.
4. Publish symlinks with a create-exclusive hard link to the candidate inode, verify the published identity, append the receipt event, then unlink the private candidate and fsync both directories. Fail closed on platforms where inode-preserving publication is unavailable.
5. Run the new cases and the existing file/symlink CAS suite.

### Task 2: Global deployment commit journal

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Extend the installer harness with deterministic failure injection for the second, third, and fourth local finalize operations and for global-journal creation.
2. Add failing tests proving local-finalize failures after a global commit return success with a warning, leave the new release and healthy timer active, and are cleaned by the next deployment.
3. Add a failing test proving global-journal write failure occurs before the commit boundary and restores all four original paths.
4. Add helper commands that verify all four receipts are `candidate-published` and match live identities, then create and fsync a root-owned `0600` global journal containing manifest/release and the four receipt identities.
5. On installer startup, validate any journal against the same manifest and receipts, finish retained local finalization safely, and remove/fsync the journal. Reject marker/receipt mismatch.
6. On success, create the global journal, set `deployment_committed=1`, and make each finalize plus journal cleanup best-effort warnings.
7. Run focused commit/finalize tests and existing rollback tests.

### Task 3: Manifest-bound immutable releases

**Files:**
- Modify: `cc-site/sync/deployment-security.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Update release fixtures to include an exact `MANIFEST.sha256` copy and add failing cases for modified release content, modified manifest bytes, directory-id mismatch, and an edited path list.
2. During release staging, copy only `MANIFEST.sha256` alongside `cc-site/`; never copy `deploy/cc-sync.env`.
3. Validate that the release directory id equals SHA-256 of manifest bytes, the manifest has the exact payload allowlist plus the deploy-env hash entry, the release contains exactly `MANIFEST.sha256` and every `cc-site/**` entry, and every release file matches its manifest hash and normalized metadata.
4. Route old-OPT preflight, idempotent reuse, damaged-live detection, publication, and release GC through this bound verifier.
5. Run focused release tests plus normal first install/redeploy tests.

### Task 4: Verification and commit

1. Run `node --test cc-site/sync/test/deployment.test.mjs`.
2. Run `node --test cc-site/sync/test/*.test.mjs`.
3. Run all Node and Bash syntax checks, payload allowlist checks, secret/path scans, and `git diff --check`.
4. Commit locally without remote deployment.
