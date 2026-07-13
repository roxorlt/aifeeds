# GL-a Exceptional Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Safely reconcile the existing GL-a `rollback_failed(prepared)` transaction while preserving helper provenance, and prevent the same pre-publication rotation-state failure from recurring.

**Architecture:** Extend the existing rollback helper with a narrowly validated initialized-candidate recovery path and an opt-in exceptional authority mode. Reuse the existing CAS journal, cleanup plan, terminal pair, and marker; add durable authority/receipt records that distinguish the transaction-bound helper SHA from the actual recovery executor SHA.

**Tech Stack:** Bash, Python 3 standard library, jq, Docker fixture tests, Nginx/systemd shims.

---

### Task 1: Freeze the incident contract and dependency preflight

**Files:**
- Modify: `deploy/nginx/install-aifeeds-performance-log.integration.test.sh`
- Modify: `deploy/nginx/install-aifeeds-performance-log.sh`
- Modify: `deploy/nginx/test-fixtures/gl-a-installer/run-scenario.sh`

**Step 1: Keep the independent failing preflight contract**

Run `preflight-logrotate-missing` outside the frozen 135-case array. Assert exit 69, exact error
`ERROR dependency=logrotate path=/usr/sbin/logrotate`, unchanged live site, no backup namespace,
no candidates, and active Nginx.

**Step 2: Verify the historical RED result is recorded**

Expected before the implementation: the scenario reaches `mutation_started`, creates candidates,
and fails the assertion `preflight-logrotate-error-marker`.

**Step 3: Keep the minimal dependency check**

Validate `/usr/sbin/logrotate` is a non-symlink regular non-empty `root:root 0755` file after current-operation recovery checks but before the first new journal/backup mutation. Exit 69 on mismatch.

**Step 4: Run the focused contract**

Run the isolated no-network Docker scenario. Expected: `PASS scenario=preflight-logrotate-missing rc=69`.

**Step 5: Commit**

Commit only after Tasks 2–5 are also green so fixture and production behavior remain atomic.

### Task 2: Add a failing initialized-candidate rollback contract

**Files:**
- Modify: `deploy/nginx/test-fixtures/gl-a-installer/run-scenario.sh`
- Modify: `deploy/nginx/test-fixtures/gl-a-installer/shims/sync`
- Modify: `deploy/nginx/rollback-aifeeds-performance-log.sh`

**Step 1: Create the exact pre-publication state**

After installer preflight and `mutation_started`, remove `/usr/sbin/logrotate` at the first format
candidate durability barrier. Assert the forward installer leaves an allocated anchor, initialized
rotation-state candidate, incomplete runtime inventory, base live site, and no live runtime finals.

**Step 2: Run the immutable helper and observe RED**

Restore `logrotate`, invoke the helper with xtrace in the isolated container, and assert the first
failing function is `persist_rotation_state_identity` with resume phase `prepared`.

**Step 3: Add the narrow candidate verifier**

When live state is absent and candidate state is recorded, call the recorded checker candidate with
`rotation-verify-initialized`; validate the returned ledger/status snapshot and CAS it into the rollback
journal. Do not accept a candidate in later phases, with a sealed inventory, with a non-allocated
anchor, or when any identity differs.

**Step 4: Run the focused scenario**

Expected: automatic rollback reaches a valid terminal pair, removes all operation-owned candidates,
keeps the base site and backup, and leaves Nginx active.

### Task 3: Add exceptional authority validation

**Files:**
- Modify: `deploy/nginx/rollback-aifeeds-performance-log.sh`
- Modify: `deploy/nginx/test-fixtures/gl-a-installer/run-scenario.sh`

**Step 1: Write failing authority tests**

Generate a staged helper variant by appending a deterministic fixture comment so the transaction binds
a different SHA. Use a fixture-only one-shot fault to retain `rollback_failed(prepared)`. Assert that
the current helper rejects: no authority, wrong operation, wrong source/rollback SHA, equal executor and
transaction SHA, wrong metadata, symlink input, and unknown keys. Capture all pre-call journal/candidate
fingerprints and assert zero mutation for every rejection.

**Step 2: Accept an optional tenth argument**

Nine arguments retain normal behavior. Ten arguments enable exceptional mode only after strict
authority validation. Store `ROLLBACK_EXECUTOR_SHA256` separately from the transaction-bound
`ROLLBACK_HELPER_SHA256`; normal mode requires equality.

**Step 3: Persist authority before recovery mutation**

Copy the exact validated authority bytes to
`/var/backups/aifeeds-performance-log/exceptional-recovery-authority-<operation>.json` using no-replace,
root-only metadata, fsync, and exact-byte idempotency. Reject an unknown existing destination.

**Step 4: Run negative and positive focused tests**

Expected: all malformed authorities fail without changing F/T/P/C; the valid authority reaches the
existing rollback state machine.

### Task 4: Publish and validate the exceptional receipt

**Files:**
- Modify: `deploy/nginx/rollback-aifeeds-performance-log.sh`
- Modify: `deploy/nginx/install-aifeeds-performance-log.sh`
- Modify: `deploy/nginx/test-fixtures/gl-a-installer/run-scenario.sh`

**Step 1: Write a failing receipt contract**

After exceptional recovery, require a deterministic committed receipt binding authority SHA,
pre-recovery source/rollback SHA, transaction helper SHA, executor SHA, terminal source/rollback SHA,
and commit-marker SHA. Assert a second invocation emits the same receipt and terminal hashes.

**Step 2: Implement no-replace receipt publication**

Publish the receipt only after terminal-pair validation. On terminal reentry, repair only an absent or
owned in-progress receipt candidate; reject any byte/inode/path drift.

**Step 3: Make installer preflight understand exceptional closure**

If an exceptional authority exists, require its matching committed receipt and terminal pair before an
old operation can be ignored. Authority without receipt, receipt without authority, receipt hash drift,
or a still-`rollback_failed` journal remains `recovery_required`.

**Step 4: Inject publication crashes**

Exercise pre-copy, post-copy, pre-rename, and post-rename receipt crash points. Expected: retry converges
without overwriting an unknown file.

### Task 5: Preserve normal-path compatibility and full matrix

**Files:**
- Test: `deploy/nginx/install-aifeeds-performance-log.integration.test.sh`
- Test: `deploy/nginx/rollback-aifeeds-performance-log.test.sh`
- Test: `deploy/nginx/check-nginx-request-id.test.py`

**Step 1: Run syntax checks**

Run `bash -n` for every modified shell file. Expected: zero output and exit 0.

**Step 2: Run focused contracts**

Run logrotate preflight, initialized-candidate normal recovery, exceptional authority negatives,
exceptional success, reentry, and receipt crash tests. Expected: all pass.

**Step 3: Run the frozen integration matrix**

Run `bash deploy/nginx/install-aifeeds-performance-log.integration.test.sh`. Expected: the existing
matrix remains exactly `135/135`, with independent contracts reported separately.

**Step 4: Run related unit tests**

Run the rollback shell tests and checker Python tests. Expected: all pass with no newly skipped tests.

### Task 6: Update operations and release evidence contracts

**Files:**
- Modify: `docs/operations.md`
- Modify: `TODO.md`
- Modify: `docs/plans/2026-07-10-c-end-performance-optimization-plan.md`
- Modify: `scripts/run-aifeeds-perf-gates.sh`

**Step 1: Document the dependency invariant**

State that `jq` and a validated `/usr/sbin/logrotate` are GL-a prerequisites and the global timer remains
disabled.

**Step 2: Document exceptional recovery**

Describe authority/receipt schemas, normal versus exceptional helper SHA semantics, exact fail-closed
conditions, operator/rollback-owner approval requirements, and the rule that no new operation starts
until the old receipt and terminal pair validate.

**Step 3: Add the independent contracts to G0 evidence**

Keep the frozen matrix count stable while recording each additional contract and its output in the G0
summary.

**Step 4: Update task status**

Record the incident and local remediation status without claiming production reconciliation or release.

### Task 7: Verify, review, and commit the local recovery implementation

**Files:**
- Review: all modified files

**Step 1: Run the complete G0 suite**

Use the repository gate runner and preserve the full evidence directory. Expected: every required gate
passes, including the frozen 135 matrix and independent recovery contracts.

**Step 2: Review the diff**

Check for secrets, machine-local paths, test-only behavior reachable outside fixtures, schema ambiguity,
unbounded cleanup, and unrelated changes.

**Step 3: Commit in coherent units**

Commit the design/plan, implementation/tests, and operations evidence updates separately. Do not push or
merge until verification is complete.

### Task 8: Prepare but do not execute production recovery

**Files:**
- Create in evidence directory only: exceptional authority, manifest, recovery runbook, read-only audit runbook

**Step 1: Generate a fresh clean G0 evidence directory**

Bind the exact commit, helper executor SHA, old transaction helper SHA, source/rollback before hashes,
operation id, operator, rollback owner, approval evidence SHA, and package manifest.

**Step 2: Re-run production read-only audit**

Require healthy Nginx/front/API, base site SHA, disabled global timer, exact old journals, exact
operation-owned candidates, sufficient disk/inodes, and no unknown namespace occupants.

**Step 3: Produce the exact production command and rollback boundaries**

Show upload, verification, exceptional helper invocation, and post-recovery read-only checks. State every
remote write path and stop condition.

**Step 4: Request separate production authorization**

Do not execute the new exceptional recovery command until the user approves that exact reviewed command.

