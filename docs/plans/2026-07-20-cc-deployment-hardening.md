# CC Deployment Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the `ai-feeds.cc` production deploy path test the exact payload it installs, publish immutable releases transactionally, and fail closed across filesystem, systemd, Nginx, and smoke-test boundaries.

**Architecture:** The local deployer builds an allowlisted repository-shaped payload and a sorted SHA-256 manifest. A minimal root bootstrap fixes and verifies the installer before execution; the installer takes a non-blocking deployment lock, copies the mutable upload into a root-owned snapshot, verifies the exact manifest, runs real Node tests there, then prepares an immutable release. Live code is switched by an atomic `/opt/aifeeds-cc-sync` symlink, while unit/env and Nginx files use same-directory fsync+rename transactions with compare-before-commit and compare-before-rollback checks.

**Tech Stack:** Bash 4+, Node.js 18+ built-ins, systemd, `flock`, OpenResty/Nginx, Node test runner.

---

### Task 1: Exact production payload and product-only entrypoint

**Files:**
- Modify: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/deploy-to-cc.sh`
- Create: `cc-site/sync/payload-files.txt`

**Steps:**

1. Add tests that inspect the staged payload tree and require `cc-site/sync/test/fixtures/publish-and-pause.mjs`, every sync test/runtime file, and the static files used by `publish-indexes.test.mjs` (`index.html`, `robots.txt`, `sitemap-static.xml`, `deploy.sh`, `cc-prompts/**`, assets, and four verification files).
2. Add negative assertions that no `cc-site/server/**`, `.env*`, `.secrets/**`, symlink, or non-allowlisted path is staged.
3. Run the focused payload test and observe the current flat payload fail.
4. Add a sorted `payload-files.txt` allowlist and build a private local payload preserving repository-relative paths; generate `MANIFEST.sha256` over the allowlist plus `deploy/cc-sync.env`.
5. Replace staging target support with exact `prod`; add a test that `staging` exits before SSH/SCP and observe RED before changing the script.
6. Make secret discovery read only `.secrets/aifeeds-prod.env` and use only `https://api.ai-feeds.com`.
7. Run focused tests until GREEN.

### Task 2: Service capacity boundary

**Files:**
- Modify: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/aifeeds-cc-sync.service`

**Steps:**

1. Assert exact `TimeoutStartSec=2h` and observe RED.
2. Add the directive without changing the two allowed write paths.
3. Run the focused service test until GREEN.

### Task 3: Fixed bootstrap, root snapshot, manifest, and deployment lock

**Files:**
- Modify: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/deploy-to-cc.sh`
- Modify: `cc-site/sync/install-remote.sh`
- Create: `cc-site/sync/deployment-security.mjs`

**Steps:**

1. Change the harness so the uploaded payload is materialized exactly and `node --test` executes the real copied suite; first demonstrate the old flat payload fails on missing fixture/static files.
2. Add tampered digest, extra file, symlink, and hardlink snapshot tests and observe RED.
3. Add a two-process test: the first installer holds the deployment lock while real tests begin; the second must fail explicitly and leave all live state unchanged.
4. Implement a minimal SSH root bootstrap that copies the installer and manifest into a unique root-owned directory, verifies their locally supplied SHA-256 digests, and executes only the fixed installer copy.
5. At installer start, take `flock -n` on a root-owned lock file; copy staging to a root-owned snapshot before parsing env or executing code.
6. Verify `MANIFEST.sha256` digest, exact sorted allowlist, no extra entries, regular-file type, `nlink=1`, and each file digest. Consume only the snapshot afterward.
7. Check Node major >=18 and run `node --test <snapshot>/cc-site/sync/test/*.test.mjs` through `runuser` with the real Node binary.
8. Run the focused manifest/lock/real-payload tests until GREEN.

### Task 4: Immutable release and full systemd rollback

**Files:**
- Modify: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/install-remote.sh`
- Modify: `cc-site/sync/aifeeds-cc-sync.service`

**Steps:**

1. Add a success test requiring `/opt/aifeeds-cc-sync` to be a symlink to `/opt/aifeeds-cc-sync-releases/<release>/cc-site/sync`, with the complete verified payload retained in the release.
2. Add failure tests for first install and upgrade at each activation boundary (symlink, env, unit, daemon-reload, service, Nginx, timer), asserting prior code/config and enabled/active states are restored exactly.
3. Observe existing in-place install and unconditional timer disable fail.
4. Record old current target or absence, atomic snapshots of env/unit/timer, and `is-enabled`/`is-active` states for timer and service.
5. Copy the verified snapshot to a root-owned immutable release; atomically switch the compatibility symlink only after tests pass.
6. Write env/unit/timer through same-directory temporary files, fsync, and rename; daemon-reload after commit and rollback.
7. Restore prior timer enabled/active and service active state exactly on failure; remove first-install artifacts rather than leaving a half-install.
8. After success, retain current plus a bounded number of prior safe root-owned release directories and reject symlink/foreign candidates during GC.
9. Run focused success/rollback tests until GREEN.

### Task 5: Filesystem and account identity boundaries

**Files:**
- Modify: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/deployment-security.mjs`
- Modify: `cc-site/sync/install-remote.sh`

**Steps:**

1. Add tests for malicious symlinks in every managed path chain and hardlinked regular files below `/i`; assert the outside inode content/mode/owner is unchanged.
2. Add account tests for non-numeric/non-system UID, wrong primary group, home, or shell.
3. Observe RED before adding validation.
4. Validate every existing path component with `lstat`: directory, non-symlink, allowed owner, and no group/other writes before root install/chown; safely create only missing final directories after their parent passes.
5. Validate an existing `aifeeds-sync` passwd entry has a system UID, primary group `www`, `/nonexistent` home, and nologin shell; validate newly created account the same way.
6. Walk `/i` without following links; reject all symlinks/special files and regular files with `nlink != 1`, then apply ownership/modes.
7. Run focused path/account tests until GREEN.

### Task 6: Strict include placement and atomic Nginx transaction

**Files:**
- Modify: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/nginx-vhost-editor.mjs`
- Create: `cc-site/sync/nginx-config-transaction.mjs`
- Modify: `cc-site/sync/install-remote.sh`

**Steps:**

1. Add editor tests requiring exactly one top-level `#REWRITE-END` in the target server, located before every top-level regex location; cover absent, duplicate, and misplaced marker cases and observe RED.
2. Make insertion fail closed unless that marker contract holds; preserve idempotent managed blocks only if they remain before all target-server regex locations.
3. Add transaction tests for panel modification between prepare/commit, `nginx -t` failure, reload failure, rollback conflict, rollback `nginx -t` failure, and rollback reload failure.
4. Prepare metadata containing original identity, digest, uid/gid/mode, and candidate digests for both vhost and snippet.
5. Revalidate original identity/digest before commit; write candidates with same-directory temp files, fsync file+directory, and atomic rename.
6. Roll back only if the current file still matches this deployment candidate; on conflict do not overwrite and return an aggregated nonzero rollback error. Restore atomically and surface validation/reload failures.
7. Run editor and transaction tests until GREEN.

### Task 7: Nginx mapping and content-verifying localhost smoke

**Files:**
- Modify: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/nginx-content-mirror.conf`
- Modify: `cc-site/sync/install-remote.sh`

**Steps:**

1. Add config tests requiring `/ai-news/` to use `root /var/lib/aifeeds-cc-sync/public/current;` plus `try_files`, never `alias + $uri`.
2. Add harness smoke behavior that materializes actual current sitemap, generation shard, and archive bytes; require every curl to use `--resolve ai-feeds.cc:443:127.0.0.1`, return exactly HTTP 200, and write content that is byte-compared with the expected file.
3. Add failure cases for non-200 root sitemap, wrong bytes, malformed/missing generation reference, shard mismatch, and archive mismatch; observe RED.
4. Change Nginx mapping and keep remote `nginx -t` as a hard gate.
5. Download root sitemap, parse one allowlisted generation shard, and download it plus `/ai-news/`; compare each response with its current/generation source file before enabling the timer.
6. Run focused Nginx/smoke tests until GREEN. If no local Nginx binary exists, record that only config/path-mapping harness coverage was possible locally.

### Task 8: Documentation and complete verification

**Files:**
- Modify: `cc-site/sync/README.md`
- Test: `cc-site/sync/test/*.test.mjs`

**Steps:**

1. Document production-only remote deployment; Task 11 staging is local or an isolated temporary directory and never targets the production host.
2. Document first bootstrap of roughly 30k pages, the 2h systemd boundary, and restart/resume from persisted state/lock without claiming measured capacity.
3. Document repository-shaped payload, root snapshot, immutable release, retained runtime/test payload, deployment lock, transactional rollback, localhost content smoke, and remaining real-host verification requirements.
4. Run `node --test cc-site/sync/test/deployment.test.mjs`.
5. Run `node --test cc-site/sync/test/*.test.mjs` with loopback permission.
6. Run `bash -n` separately for both shell scripts and `node --check` for every sync `.mjs`.
7. Run `git diff --check` and scan the payload/changes for secrets, local absolute paths, `.env`, and `cc-site/server` leakage.
8. Commit the complete remediation and verify the worktree is clean. Do not deploy remotely.
