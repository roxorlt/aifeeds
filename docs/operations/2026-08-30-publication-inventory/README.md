# 2026-08-30 publication inventory activation packet

## Status

**Inventory sealed; activation intentionally blocked.** This packet performs no R2, D1, Worker,
configuration, or deployment write. `activation-command.json` has
`precondition_status=authoritative_read_required` and cannot be used until an operator performs a
fresh authoritative production read and regenerates it with the exact old budget snapshot.

## Sealed inventory

- Namespace: `daily-publications-v1`
- Bucket: `xlist-readme-assets`
- Prefixes: `daily/`, `daily-video/`
- Inventory logical snapshot: `2026-08-30T02:22:00.000Z` (`1788056520000` ms), passed explicitly
  to the builder and never derived from file mtime or the current clock
- `daily/`: 88 objects, 10,481,928 bytes
- `daily-video/`: 210 objects, 730,352,528 bytes
- Total: 298 objects, 740,834,456 bytes
- Object-set SHA-256: `8e673930948cabb60720d6f7708294f6c1d4f5724d4d36f11130db5773fb3191`
- Full manifest SHA-256: `5e9ca8c182f7109abc7093f5706d34c118024b21fe1f005eed0f91eb02f1cdee`
- Operator: `codex-aifeeds-publication-recovery`
- Command version: `aifeeds-r2-inventory-v1`

The manifest was generated from fresh read A and contains a sealed fresh read B equivalence witness.
A and B were taken in the same minute and their canonical object-set and full-manifest bytes matched.
The older unsuffixed response files were historical comparison only and were not used to generate this
packet. The object-set digest also independently matched the earlier two read-only listings. The canonical documents use
recursive UTF-8 byte-order property sorting, key byte-order object sorting, compact JSON, and one
terminal LF; that LF is part of the SHA-256 byte contract. Raw Cloudflare responses are deliberately
not committed.

The builder rejects unsuccessful/errored/truncated responses, unexpected prefixes, duplicate keys,
missing metadata, unsafe numeric sizes, total overflow, path controls, and credential-shaped keys or
metadata. This inventory passed those checks. Object keys are public daily publication paths; no
secret-bearing metadata is included in the manifest.

## Files

- `object-set.canonical.json`: exact cross-scan object-set proof.
- `inventory-manifest.canonical.json`: activation inventory payload and digest authority.
- `inventory-envelope.json`: review envelope containing both digests and the manifest.
- `activation-command.json`: **non-executable** Worker-helper command template. It contains no SQL,
  batch request, credential, or secret.

`inventory_digest` supplied to `activatePublicationCapacityBudget` is the full manifest digest, not
the smaller cross-scan object-set digest.

## Required authoritative snapshot and regeneration

Immediately before activation, read the production `publication_storage_budget` singleton through an
approved authoritative path. The exact JSON snapshot passed to `--budget-snapshot` must contain only:

```text
singleton_id, namespace, budget_bytes, legacy_baseline_bytes, reserved_bytes,
version, state, legacy_inventory_digest, legacy_inventory_object_count,
legacy_inventory_at_ms, updated_at_ms
```

The builder accepts only `singleton_id=1`, namespace `daily-publications-v1`,
`state=uninitialized`, `version=0`, zero baseline/reserved bytes, and null inventory fields. It also
requires the exact authoritative `budget_bytes` and `updated_at_ms`. Do not infer or copy this snapshot
from a migration file, old log, this document, or a previous read.

Regenerate into a new empty output directory using the same sealed inputs and inventory metadata,
add `--budget-snapshot /secure/path/authoritative-budget-snapshot.json`, and set `--now-ms` to the
actual approved activation time. Recheck both digests. The regenerated command must contain the exact
snapshot at `input.old_budget_snapshot`; both snapshot placeholders must cease to be null.
The resulting command remains `execution=disabled`: it is evidence for a separate, explicit operator
request and is never executable by itself.

The builder does not accept an operator-supplied audit ID. Once the old snapshot is present it derives
`input.audit_id` as lowercase SHA-256 over the fixed domain
`aifeeds-publication-capacity-activation-request-v1\0` and the complete immutable activation input
(excluding `audit_id` itself). Every old-snapshot field, including `updated_at_ms`, participates. The
Worker helper independently recomputes the same ID before both fresh activation and replay. A null old
snapshot therefore leaves the archived template's audit ID null and non-executable; never fill or edit
that field manually.

## Authorized activation request

The only supported production entry point is:

```text
POST https://api.ai-feeds.com/api/ops/publication-capacity/activate
```

It requires the existing production `INGEST_TOKEN` as a Bearer credential, `Content-Type:
application/json`, and an `Idempotency-Key` that exactly equals `input.audit_id`. The route authenticates
before reading the body, accepts at most 16 KiB, rejects unknown/missing fields, and directly invokes
the single `activatePublicationCapacityBudget` helper. It contains no duplicate activation SQL. Never
put the token in a file committed to this repository, command history, logs, or the request JSON.

Build the request from the freshly regenerated command in a secure temporary directory:

```sh
jq '{schema_version: 1, action: "activate_publication_capacity_budget", input: .input}' \
  activation-command.json > activation-request.json

AUDIT_ID="$(jq -er '.input.audit_id' activation-request.json)"
curl --fail-with-body --silent --show-error \
  --request POST 'https://api.ai-feeds.com/api/ops/publication-capacity/activate' \
  --header "Authorization: Bearer ${INGEST_TOKEN:?missing INGEST_TOKEN}" \
  --header 'Content-Type: application/json' \
  --header "Idempotency-Key: ${AUDIT_ID}" \
  --data-binary @activation-request.json
```

Before sending, an approved operator must authoritatively read the complete singleton and compare it
byte-for-value with `input.old_budget_snapshot`:

```sql
SELECT singleton_id,namespace,budget_bytes,legacy_baseline_bytes,reserved_bytes,
       version,state,legacy_inventory_digest,legacy_inventory_object_count,
       legacy_inventory_at_ms,updated_at_ms
  FROM publication_storage_budget
 WHERE singleton_id=1;
```

Any mismatch means stop and regenerate from a new authoritative read; do not edit the request by hand.
Direct D1 SQL/batch activation is forbidden because it would duplicate and drift from the helper's
audit, full-snapshot CAS, trigger, reconcile, and replay semantics.

After the route returns, authoritatively reread and verify all of the following before any gate is
enabled:

1. budget state is `active`, baseline/count/time/digest match this manifest, and version is exactly 1;
2. the exact `activate_inventory` audit tuple exists once;
3. capacity control is active, references the same audit, and snapshots the same budget version;
4. reserved bytes and publication/reservation/head rows have not changed unexpectedly.

Verify the immutable audit row and warning-control projection with authoritative reads:

```sql
SELECT action,old_budget_bytes,new_budget_bytes,old_occupied_bytes,new_occupied_bytes,
       inventory_digest,actor,reason,ticket_ref,created_at_ms
  FROM publication_budget_audit
 WHERE audit_id='<exact input.audit_id>';

SELECT singleton_id,namespace,schema_version,epoch,budget_version_snapshot,
       budget_bytes_snapshot,legacy_baseline_bytes_snapshot,reserved_bytes_snapshot,
       occupied_bytes_snapshot,state,last_audit_id,updated_at_ms
  FROM publication_capacity_warning_control
 WHERE singleton_id=1;
```

An HTTP 503, timeout, disconnect, or other unknown response is never retried blindly. First perform all
three authoritative reads above. If and only if the budget, complete immutable audit tuple, and control
projection exactly match the request, treat it as committed; otherwise stop for investigation. Sending
the same request again is permitted only after that authoritative reconciliation proves it was not
committed. A same-ID replay with any tuple mismatch is a hard failure, not an update mechanism.

## Two-commit gate rollout (no publication loop)

### Phase 1 — bootstrap commit

The current bootstrap candidate **must keep all five gates at "0"** in production. Staging omits them
because Wrangler environment vars are non-inheritable. Merge and deploy this bootstrap first so the
authenticated activation API exists while every producer, reservation, PUT, and promotion path is
still fail-closed:

```sh
npm --prefix worker run deploy:publication:bootstrap
```

Do not activate through direct SQL and do not enable a gate in this bootstrap commit.

### Phase 2 — authoritative activation and cumulative live rollout

Capture the authoritative snapshot, regenerate the request-derived audit ID, call the authenticated
activation route, and complete the authoritative post-read checks above. Then deploy and verify one
stage at a time in the frozen order below. Each package script supplies **all five vars explicitly**;
enabled values accumulate and later stages remain zero. Never edit wrangler.toml between live rollout
steps and never skip a command.

1. `npm --prefix worker run deploy:publication:drain`
2. `npm --prefix worker run deploy:publication:producer`
3. `npm --prefix worker run deploy:publication:reservation`
4. `npm --prefix worker run deploy:publication:put`
5. `npm --prefix worker run deploy:publication:promotion`

After every command, authoritatively verify the deployed vars and the corresponding warning outbox,
capacity, reservation, object-integrity, or authorized-head behavior before continuing. Stop on any
schema/control/audit mismatch, unexpected warning state, reservation drift, PUT integrity failure, or
head authorization failure.

### Phase 3 — independent follow-up config commit/PR

Only after all five live stages pass may an independent follow-up config commit/PR change the five
production values in `worker/wrangler.toml` from `"0"` to `"1"` and update the bootstrap config test to
the reviewed durable final-state expectation. Merge and deploy that separate PR to converge source
control with the already proven live state. Never combine Phase 1 and Phase 3: doing so recreates the
activation/deployment loop. Staging must remain off until it completes its own independent inventory
activation and rollout.

## Rollback

On a rollout fault, disable promotion, PUT, reservation, and producer; keep drain enabled until all
durable outbox work is terminal, then disable drain. Do not restore fixed-key overwrite, issue DELETE,
or reduce the recorded baseline. Revert the durable gate config before the next production deploy so a
later deployment cannot re-enable a disabled gate. Schema, audit, baseline, reservations, objects, and
last authorized heads remain intact for investigation and replay.
