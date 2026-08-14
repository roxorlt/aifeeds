# Manual News v3 — Architecture Addendum v8

Status: **DESIGN GO**. This is a normative architecture boundary. Implementation
evidence is collected and reviewed per PR; this document is not itself evidence
that a later PR has been implemented or passed.

The wire `contract_version` literal remains exactly
`manual-news-v11-spec-v6`. The architecture sequencing below does not rename or
version that wire literal.

## Scope and sequence

The required sequence is:

1. **PR-A** — Unicode/canonical JSON foundation and feature-off V11 envelope
   DAG only.
2. **PR-A1** — behavior-neutral extraction of the pure policy kernel.
3. **PR-A2** — behavior-neutral extraction of complete V10 leaf projections.
4. **PR-B** — V11 leaf compiler and leaf commitment recomputation.

No PR may skip an earlier boundary. In particular, PR-A must not duplicate V10
provenance or bilingual-semantic logic, and PR-B must consume the A1/A2 shared
objects rather than recreate them.

## PR-A: envelope-only contract

PR-A is an envelope-only foundation. It accepts and canonicalizes the A/P/V/H
domain preimages, checks their closed schemas and DAG bindings, and remains
feature-off. It does not accept, canonicalize, validate, or recompute leaf
payload preimages.

The approved API terminology is:

| Retired term | Required term |
| --- | --- |
| `*Payload` type | `*DomainPreimage` type |
| `ManualNewsV11Bundle` | `ManualNewsV11EnvelopeDag` |
| `validateManualNewsV11Bundle` | `validateManualNewsV11EnvelopeDag` |

The schema field names `assessment_payload_digest`,
`provenance_payload_digest`, and `verification_payload_digest` remain fixed
wire literals. They are opaque leaf commitments in PR-A: format validation is
allowed, but leaf preimage validation and digest recomputation are deferred to
PR-B.

PR-A must not claim completion of the full N01–N18 leaf vector set. Its tests
use explicit envelope vector identifiers; leaf vectors remain pending PR-B.

### PR-A workerd gate

The workerd suite must execute static, frozen Node-matching literals for all of:

- canonical A, P, V, and H domain-preimage bytes;
- SHA-256 links A/P → V → H;
- external HMAC-SHA-256 over the canonical H preimage, using the ASCII UTF-8
  bytes of the 64-character all-zero test secret.

The V11 module has no production importer. A feature-off closure gate must fail
if any production source outside the pure envelope module imports it. PR-A must
also retain the closed Unicode/canonical JSON guarantees: complete NFC C1–C5,
NFKC, extended grapheme conformance, linear 200k-RI behavior, strict array
prototypes, and truthful Unicode provenance/source closure.

## PR-A1: pure policy-kernel extraction

PR-A1 creates exactly these pure modules:

```text
safe-url-types.ts
safe-url-policy.ts
manual-news-leaf-contract.ts
manual-news-bilingual-semantic.ts
```

Only `safe-url-fetch.ts` and `manual-news-leads.ts` import and re-export moved
compatibility logic in PR-A1. Existing callers retain their public import paths.

| Module | Owns | Must not own |
| --- | --- | --- |
| `safe-url-types.ts` | pure URL, hop, limit, and fetch-audit structural types | fetch, keys, time, Env |
| `safe-url-policy.ts` | public URL/IP policy, canonical URL, normative policy constants | fetch, response HMAC, D1 |
| `manual-news-leaf-contract.ts` | exact structural leaf contracts and shape errors | V10 proof canonicalization, keyring, lifecycle |
| `manual-news-bilingual-semantic.ts` | bilingual slots, projection relations, semantic contract projection | provider, D1, HMAC, clock |

Forbidden edges:

- no pure module may import `manual-news-leads.ts`, store, pipeline,
  verification, `news-review.ts`, index, keyring, D1/Env, provider, or fetch
  implementation modules;
- `safe-url-policy.ts` must not import `safe-url-fetch.ts`;
- `manual-news-bilingual-semantic.ts` must not import V11 or canonical-json-v2.

PR-A1 moves authoritative logic only. It must not alter URL policy, V10 proof
format, canonicalization, error codes, or public behavior.

## PR-A2: complete V10 leaf projection extraction

PR-A2 owns complete V10 projection APIs, including:

- `projectManualNewsV10AssessmentLeaf`;
- `normalizeManualNewsV10ProvenanceShape` (structural/policy-only, no response
  HMAC verification);
- V10 provenance, verification, and canonical-payload projectors;
- `canonicalJsonV10`, preserving legacy V10 ordering and escaping exactly.

`manual-news-leads.ts` remains the V10 lifecycle and trust owner. It retains
proof creation/currentness, verification and response-key lookup,
cryptographic response-HMAC and excerpt checks, persisted reload, prior
resolution, confirm, freeze, and finalize behavior.

The trust boundary is explicit: projectors describe and normalize data; V10
lifecycle code decides when it is cryptographically trusted. A2 must not move
keyring access, persistence, provider interaction, or lifecycle control into a
pure module.

## PR-B: V11 leaf compiler

PR-B consumes A1/A2 shared objects and applies `canonicalJsonV2`, not V10
legacy canonical JSON. It owns exact V11 leaf schemas, leaf commitment
recomputation, evidence-derived response-key IDs, prior graph binding, and V11
cross-link validation.

Cryptographic provenance verification is a precondition to V11 leaf acceptance:

1. the caller verifies the response HMAC with controlled key material;
2. the caller verifies proof-excerpt hash, UTF-8 byte count, and code-point
   count;
3. only then may the compiler receive the provenance for structural leaf
   validation.

The compiler must never treat a TypeScript assertion or a `verified` marker as
cryptographic proof. PR-B may expose pure external-HMAC verification, but does
not connect production keyrings or providers without a separately approved
activation design.

## Frozen V10 compatibility gates

Before A1 and again before A2 merge, literal baseline fixtures must prove:

- exact V10 canonical payload UTF-8 bytes;
- canonical SHA-256 and V10 HMAC literals, with the existing ASCII-hex key
  interpretation;
- legacy `canonicalJson` behavior, including key ordering, escaping, evidence
  ordering, and null/omission behavior;
- error precedence for malformed provenance, unavailable keys, response-HMAC
  failure, excerpt failure, and semantic-contract failure;
- fail-closed tamper behavior for assessment, evidence, audit, bilingual
  semantic slots, verification, and prior context;
- lifecycle behavior for proof create, reload, persisted validation, prior
  recursion, confirm, pre-freeze, freeze, and finalize.

These goldens run in both Node and workerd. Build metafile/import-closure gates
must prove that the pure bundle does not acquire a provider, D1, keyring, Env,
or fetch implementation dependency.

## Exact write sets

| PR | Permitted write set |
| --- | --- |
| PR-A | Unicode/canonical-json-v2 files; `.gitattributes`; Unicode provenance/audit support including this Addendum v8; `manual-news-v11-domain.*`; V11 workerd and feature-off tests only |
| PR-A1 | the four named pure modules; import/re-export/call replacements only in `safe-url-fetch.ts` and `manual-news-leads.ts`; compatibility tests |
| PR-A2 | V10 leaf projection module/tests; `manual-news-leads.ts` call replacement; Node/workerd/lifecycle goldens |
| PR-B | V11 leaf compiler and its Node/workerd tests; no V10 production lifecycle rewrite |

None of these PRs may modify D1 migrations, routes, UI, scoring, providers,
production feature selection, or keyring behavior.

## Merge and rollback

- **PR-A:** merge only with envelope-only names/documentation, actual workerd
  A/P/V/H byte/digest/HMAC evidence, feature-off closure evidence, and no
  N01–N18 completion claim.
- **PR-A1:** merge only when Node/workerd V10 byte, SHA, HMAC, error-precedence,
  tamper, lifecycle, and metafile-closure goldens are unchanged.
- **PR-A2:** merge only when the same V10 matrix remains unchanged and the
  complete signed `fetch_audit` and bilingual semantic contract are covered by
  projection goldens.
- **PR-B:** merge only when full executable N01–N18 coverage, pre-acceptance
  cryptographic provenance verification, and V11 cross-runtime goldens pass.

Each phase is independently rollbackable as a whole. No phase above adds a
schema migration or changes persisted wire formats, so rollback creates no data
migration obligation. V11 remains feature-off until a separate activation
decision is approved.
