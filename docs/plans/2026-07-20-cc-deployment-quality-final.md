# CC Deployment Quality Final Implementation Plan

**Goal:** Close the remaining deployment recovery races so an interrupted `.cc` mirror install either restores the exact prior state or fails closed without overwriting operator changes or leaking the root snapshot.

**Architecture:** Separate read-only journal inspection from mutation. Persist every recovery side-effect boundary in the preparing marker, stop and disable candidate units before rolling back Nginx or live files, and use one marker transaction abstraction for compare-and-swap replacement/removal. Every marker mutation is bound to an immutable, durable operation record and resumes from exact filesystem evidence. New root snapshots live below a root-only managed parent and are moved and removed through a hash-pinned Linux syscall helper using `renameat2`, directory file descriptors, `openat`, `fstatat`, and `unlinkat`; legacy `/var/tmp` snapshots are validated but never used to change `/var/tmp` ownership or mode.

**Tech Stack:** Node.js 18, Bash installer orchestration, Linux/glibc filesystem syscalls exposed through a payload-pinned Python 3 `ctypes` helper, `node:test` integration harness.

---

### Task 1: Recovery ordering and durable runtime state

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add failing integration tests that require timer stop/disable and service stop before Nginx or any of the four live paths is restored. Have the fake candidate service write a sentinel and assert rollback never starts while it can still write.
2. Add SIGKILL cases at stop, disable, and restore boundaries. An unconfirmed systemd attempt must retain the marker and fail closed on retry; a confirmed step must resume without repeating an unsafe side effect.
3. Split the current preparing recovery command into read-only inspection and an explicit path-rollback command.
4. Persist recovery step `attempted` and `completed` transitions with marker CAS before and after each systemd action, then share the same ordered recovery routine between startup and `on_exit`.

### Task 2: Marker CAS and committed-marker validation

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/test/fixtures/publish-and-pause.mjs`

1. Add failing unit and real-process tests for foreign committed-marker `EEXIST`, foreign canonical replacement, ABA replacement, in-place same-inode mutation, and kills before link/rename/unlink.
2. Replace check-then-rename/unlink with one private-journal marker transaction: pin identity plus content digest, move the canonical marker into a unique quarantine, validate the moved object, publish the candidate without replacement, and safely restore or fail closed on conflict.
3. Make commit retry validate committed phase, deployment id, manifest/release, marker identity/content, all four receipts, and all four live identities. Mere path existence must never set the shell commit boundary or delete the preparing snapshot.

### Task 3: Root snapshot lifecycle

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add failing tests for successful recovery cleanup, failed recovery retention, snapshot-root replacement, and snapshot-root symlink substitution.
2. Record the canonical snapshot path, parent, device/inode, owner, and mode in the preparing marker; accept only the controlled `aifeeds-cc-root-snapshot.<id>` name under `/var/tmp` or the rooted test equivalent.
3. After complete recovery, write a cleanup receipt, move the exact snapshot identity into controlled quarantine, CAS-remove the preparing marker, then delete recursively without following symlink entries and fsync the parent. A later recovery must finish a receipt-bound orphan quarantine if interruption lands after marker removal.
4. Verify the backed-up secret environment file leaves no residual snapshot after a successful recovery.

### Task 4: Bootstrap ordering

**Files:**
- Modify: `cc-site/sync/install-remote.sh`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Add a failing test with an intermediate symlink in the root-owned `/opt`, release, `/etc`, or systemd path chain and assert rejection occurs before `useradd`.
2. Validate the complete root-owned, no-symlink, owner/mode-constrained chain before account lookup/creation. Keep account creation documented as a narrow, non-transactional bootstrap step.

### Task 5: Verification and handoff

1. Run the focused new tests after each red/green cycle.
2. Run `node --test cc-site/sync/test/deployment.test.mjs` and `node --test cc-site/sync/test/*.test.mjs`.
3. Run Node and Bash syntax checks, payload/secret/path scans, and `git diff --check`.
4. Review the diff and update operations/TODO facts if behavior changed. Do not commit, push, or deploy in the final quality-review session.

### Task 6: Linux directory transaction helper and managed snapshot parent

**Files:**
- Create: `cc-site/sync/deployment-linux-fs.py`
- Modify: `cc-site/sync/payload-files.txt`
- Modify: `cc-site/sync/deploy-to-cc.sh`
- Modify: `cc-site/sync/install-remote.sh`
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Test: `cc-site/sync/test/deployment.test.mjs`

1. Write failing helper tests for `renameat2(RENAME_NOREPLACE)`: an occupied quarantine must remain byte-for-byte and inode-for-inode unchanged; a source directory replaced after validation must be restored to its original name and the operation must fail closed.
2. Write failing cleanup tests that replace the quarantine between JavaScript validation and deletion. The replacement and every child must remain unchanged, while the bound original is not reached through the replacement pathname.
3. Add a stdlib-only Python helper that rejects non-Linux platforms, opens parent and child directories with `O_DIRECTORY|O_NOFOLLOW`, checks exact device/inode/owner/mode, calls libc `renameat2` with `RENAME_NOREPLACE`, and recursively cleans only through directory-relative `openat`/`fstatat`/`unlinkat`. Sync every changed directory descriptor.
4. Add the helper to the payload allowlist and digest-checked root bootstrap. In production require `/usr/bin/python3` and the fixed helper before the installer mutates managed state; in tests inject the interpreter and helper paths.
5. Change new snapshot allocation to `/var/lib/aifeeds-cc-deploy-snapshots`, with a validated root-owned chain and a root:root `0700` parent. Remove every `install -d`, `chmod`, or `chown` operation targeting `/var/tmp`.
6. Keep a legacy marker validator for `/var/tmp/aifeeds-cc-root-snapshot.*` that accepts only root-owned, non-symlink `01777` `/var/tmp`, without modifying it. Add tests for preserved `01777`, intermediate symlinks, wrong owner, and wrong mode.

### Task 7: Durable marker mutation operation protocol

**Files:**
- Modify: `cc-site/sync/deployment-file-transaction.mjs`
- Modify: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/test/fixtures/publish-and-pause.mjs`

1. Write real-process failing tests for create, replace, and delete at each applicable boundary: operation-record fsync, candidate fsync, canonical-to-quarantine fsync, no-replace canonical publication fsync, quarantine unlink fsync, and candidate unlink fsync. Run every case for preparing, committed, and snapshot-cleanup receipt mutations.
2. Each test must SIGKILL at the named durable boundary, run recovery at least twice, require the exact final canonical phase and bytes, and require zero controlled candidates, quarantines, and operation records. An error is never an accepted outcome.
3. Write mutation-conflict tests for foreign canonical files, ABA replacement, same-inode content mutation, foreign operation artifacts, and record mutation. Require fail-closed behavior with operator files unchanged.
4. Replace ad hoc marker temporary names with one immutable schema-1 operation record created and fsynced before mutation. Bind action, phase, canonical, exact expected CAS snapshot or expected absence, exact target bytes/digest, and controlled candidate/quarantine paths.
5. Recover the operation before reading any preparing marker, committed marker, or cleanup receipt. Derive the next step only from the immutable record plus an exact allowed filesystem tuple, perform one idempotent transition, fsync, and continue until the operation record can be removed.
6. Route initial preparing/committed publication, marker replacement/removal, and cleanup-receipt replacement/removal through the same protocol.

### Task 8: Documentation and final verification

**Files:**
- Modify: `cc-site/sync/README.md`
- Modify: `docs/operations.md`
- Modify: `TODO.md`

1. Document the managed snapshot parent, legacy `/var/tmp` read-only compatibility, Linux/glibc/Python 3 assumptions, no-replace publication, directory-fd cleanup, and the root-only-parent threat boundary.
2. Run the new target suites, the full focused deployment matrix, the 41-test static publisher suite, syntax checks, `git diff --check`, secret scan, and conflict-marker scan.
3. If the complete loopback suite still requires unavailable escalation, do not bypass it; report the exact limitation and all narrower evidence. Freeze without commit, push, or deploy.
