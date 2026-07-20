# CC Deployment Transaction Remediation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the remaining deployment transaction gaps around locking, immutable release recovery, systemd state, compare-and-swap rollback, and first-install side effects.

**Architecture:** Keep Bash as the root-only orchestrator and move filesystem identity-sensitive operations into the existing zero-dependency Node helpers. Every live mutation records a candidate identity before later work can fail; rollback changes only that exact candidate and otherwise preserves concurrent operator changes while returning exit 70.

**Tech Stack:** Bash, Node.js 18+ built-ins, systemd CLI, flock, Node test runner.

---

### Task 1: Private no-follow deployment lock

**Files:**
- Modify: `cc-site/sync/deployment-security.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add failing integration cases for a symlink and non-regular lock entry, external target preservation, unchanged shared `/run/lock`, and no `/var/lock` mutation.
2. Run the focused test and confirm the current `/var/lock` redirection fails the assertions.
3. Add a helper that validates `/run`, creates or validates `/run/aifeeds-cc-sync-deploy` as root-owned `0700`, and opens `deployment.lock` using `O_NOFOLLOW|O_CREAT` before verifying a root-owned single-link regular `0600` file.
4. Open the verified file read/write without truncation and acquire the existing nonblocking flock.
5. Run the focused lock and concurrent-deployment tests.

### Task 2: Recoverable immutable release publication

**Files:**
- Modify: `cc-site/sync/deployment-security.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add failing cases for an incomplete non-live final release and a second deployment of the same manifest.
2. Add exact release verification from the payload manifest: path set, bytes, owner, mode, type, and link count.
3. Build into `.stage.<manifest>.<uuid>`, normalize it, verify it, and atomically rename it to the final digest directory.
4. Reuse an exact final release. Quarantine and replace only a safely validated, non-live incomplete final release; fail closed if the live final release is damaged.
5. Clean only safely validated stage/quarantine artifacts at startup and during release GC.
6. Run the focused release tests.

### Task 3: Strict systemd state transaction

**Files:**
- Modify: `cc-site/sync/install-remote.sh`
- Modify: `cc-site/sync/test/deployment.test.mjs`

1. Extend the fake systemctl to model `show LoadState`, strict command exit codes, active/running/inactive service state, and enabled/disabled/active/inactive timer state.
2. Add failing tests for stop failure with zero live writes and for rejected masked, runtime-enabled, static, failed, and deactivating states.
3. Capture only supported state combinations before account or live filesystem mutation.
4. Stop and disable only states that require it, fail immediately on command failure, and re-check inactive/disabled state before activation.
5. Restore absent/disabled/enabled and inactive/active/running states exactly; a previously running oneshot is restarted.
6. Run focused systemd tests.

### Task 4: CAS rollback for env, units, and live symlink

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Modify: `cc-site/sync/deployment-security.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add failing helper and installer tests for concurrent changes to env, service unit, timer unit, and `/opt/aifeeds-cc-sync`.
2. Record the installed file candidate's inode and digest in the rollback transaction.
3. Restore or remove a file only when its current identity and bytes still equal that candidate; otherwise preserve it and report conflict.
4. Restore/remove the live symlink only when it still points to this deployment's target.
5. Aggregate any rollback conflict into exit 70 while continuing independent rollback steps.
6. Run focused CAS tests.

### Task 5: Account and newly-created directory rollback

**Files:**
- Modify: `cc-site/sync/deployment-security.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add `USERDEL` to the test/production command contract and record whether this deployment created `aifeeds-sync`.
2. Add failing cases for account creation followed by path validation failure and service failure, asserting no account or new state/item roots remain.
3. For existing state/item roots, validate exact owner/group, directory `0750`, file `0640`, regular-file link counts, and allowed state `public/current` link shape without modifying anything.
4. For absent roots, create and record their inode identities. On rollback, stop the writer, verify the same roots and safe contents, remove them, then safely delete only the unchanged newly-created account.
5. Add failing cases proving wrong existing mode/owner is rejected without chmod/chown.
6. Run focused account/directory tests.

### Task 6: Complete verification and commit

1. Run `node --test cc-site/sync/test/deployment.test.mjs`.
2. Run `node --test cc-site/sync/test/*.test.mjs`.
3. Run Bash syntax checks, every sync `.mjs` syntax check, allowlist and secret/path scans, and `git diff --check`.
4. Commit the remediation without deploying remotely.
