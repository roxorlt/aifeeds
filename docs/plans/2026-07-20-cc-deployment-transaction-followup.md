# CC Deployment Transaction Follow-up Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:systematic-debugging task-by-task.

**Goal:** Close the remaining deployment races without overwriting operator changes, accept every legitimate sync-state artifact, restore systemd after partial command failures, and reject unmanaged prior live-code links.

**Architecture:** Replace check-then-rename deployment writes with an append-only, fsynced receipt plus same-directory candidate and quarantine objects. Publication and rollback use create-exclusive hard links and post-move identity verification, so no step overwrites an existing live name. Installer state recovery is driven by observed systemd state and strictly validated managed release links.

**Tech Stack:** Node.js filesystem primitives, Bash/systemd orchestration, `node:test`.

---

### Task 1: Non-overwriting path transactions

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add failing real-filesystem tests for receipt-write failure on env, interrupted service commit followed by same-transaction recovery, a timer replacement after the old file is opened, and an OPT symlink replacement immediately before its move.
2. Run only those tests and confirm that the current check/rename implementation overwrites or strands live state.
3. Implement same-directory candidates, unique quarantines, append-only fsynced receipts, create-exclusive publication, and post-move verification for regular files and symlinks.
4. Add explicit `recover`, `rollback`, and `finalize` commands; make a repeated deployment of the same manifest recover an interrupted receipt before capturing new rollback state.
5. Run the four timing tests and the existing operator-concurrency rollback tests.

### Task 2: Legitimate private sync-state modes

**Files:**
- Modify: `cc-site/sync/deployment-security.mjs`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add a failing fixture containing `state.json`/`sync.lock` mode `0600`, `sync.lock.guard` and lock candidates mode `0700`, owner metadata mode `0600`, and a valid `public/current` tree.
2. Add negative fixtures for a private mode inside `public`, an unknown symlink, and group/other-writable private state.
3. Teach the validator to distinguish public (`0750`/`0640`) from owner-private (`0700`/`0600`) paths while retaining exact uid/gid and no-write checks.
4. Run the focused state-root tests.

### Task 3: Systemd partial-failure observation

**Files:**
- Modify: `cc-site/sync/install-remote.sh`
- Modify: `cc-site/sync/test/deployment.test.mjs`

1. Add failing cases where service stop, timer stop, and timer disable mutate state but return nonzero.
2. Record each attempt before invoking systemctl, always re-query after the command, and derive quiesced/disabled flags from observed state.
3. Abort on the nonzero command result, then restore exactly the original active/enabled state using fresh observations.
4. Run the three focused rollback tests plus existing systemd-state tests.

### Task 4: Prior OPT target validation

**Files:**
- Modify: `cc-site/sync/deployment-security.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add failing tests for absolute, traversal, unmanaged-relative, and damaged managed release targets.
2. Add a verifier that accepts only `aifeeds-cc-sync-releases/<64hex>/cc-site/sync`, resolves it beneath `/opt`, and validates the referenced release tree before payload tests or live writes.
3. Run the focused target tests.

### Task 5: Verification and commit

1. Run `node --test cc-site/sync/test/deployment.test.mjs`.
2. Run `node --test cc-site/sync/test/*.test.mjs`.
3. Run Bash and Node syntax checks, payload allowlist, secret/path scans, and `git diff --check`.
4. Commit locally without deploying.
