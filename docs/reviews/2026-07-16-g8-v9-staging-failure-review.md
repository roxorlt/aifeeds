# G8 v9 staging failure review

Date: 2026-07-16

Operation: `g8-v9-4dd3ac7-perf-staging`

Commit: `4dd3ac76e511dab530cb4dae469261fa27bf76ef`

## Outcome

G8 v9 did not pass staging and did not reach the account/browser functional phase. The forward command
deployed a Worker candidate and an isolated perf-staging Pages candidate, then failed the `/media` Range
contract after 24 attempts. Automatic rollback restored the Worker and Pages live state, removed the two
owned feed fixtures, and left no owned account rows, but the rollback command exited `rollback_failed`
after a repeated Pages rollback request returned HTTP 400.

`main` and production were not changed.

The original rollback summary remains authoritative for the script result. A separate forensic
reconciliation records the later read-only observation that the remote runtime is safely back on the
baseline; it does not rewrite `rollback_failed` into `pass`.

## Evidence-backed findings

### `/media` forward failure

- The candidate source synthesizes `Accept-Ranges: bytes` when a video origin returns a valid 206 response
  with `Content-Range` but omits `Accept-Ranges`.
- The unit contract passes, and local Wrangler against the same public Twitter MP4 returned 206, 1024
  bytes, the expected Range headers, `video/mp4`, and `no-store`.
- The pre-attempt and post-rollback staging baseline returns the same valid 206 response but omits
  `Accept-Ranges`.
- The staging loop exhausted all 24 attempts between Pages activation and rollback. Because the v9
  cleanup removed its private raw directory and did not publish a sanitized response summary, the exact
  failing header set is no longer recoverable.

The application handler is therefore not proven faulty. The proven release-process defect is that v9
promoted a new Worker to 100% before it could identify which Worker version served the contract request.
It then inferred activation from the control-plane deployment list, while the data-plane response carried
no version identity. The precise edge-level cause of the mismatch remains unproven and must not be stated
as certainty.

### Pages rollback failure

The rollback loop permits another POST after an earlier successful POST whenever the live hostname still
shows the candidate asset during edge propagation. Cloudflare returned HTTP 400 on that repeated request,
and the script failed immediately instead of continuing read-only observation. The later read-only check
showed:

- Worker current version equals the exact baseline version.
- Perf-staging live asset equals the exact baseline asset and differs from the candidate asset.
- Candidate and baseline Pages deployments both remain successful inventory records; project
  `latest_deployment` still points at the candidate and is not proof of what the live alias serves.
- Owned account rows and both owned feed fixtures are zero.

This is a rollback-state-machine defect: after one accepted mutation, propagation must be polled without a
second mutation. A rerun that already sees the baseline must also converge by observation rather than POST
again merely because historical candidate inventory remains.

## Required changes before another attempt

1. Bind Cloudflare version metadata and return the exact version ID on `/media` responses.
2. Upload the Worker candidate without traffic, create a 100% baseline / 0% candidate deployment, and use
   `Cloudflare-Workers-Version-Overrides` on the real staging custom domain to test the candidate.
3. Promote to 100% only after the overridden request matches both the candidate version ID and the full
   media contract; then require consecutive unoverridden matches before continuing.
4. Publish a sanitized per-attempt media JSON containing only status, byte count, allowed contract headers,
   expected version, checks, attempt number, and timestamp.
5. Allow at most one Pages rollback POST per invocation. After it succeeds, poll only. Treat consecutive
   baseline live observations as convergence, including an idempotent recovery rerun.
6. Preserve non-2xx Cloudflare response bodies as private evidence instead of deleting the only diagnostic.

## Acceptance rule

No new staging attempt may proceed from a direct 100% Worker deploy. The new packet must test the exact
candidate at 0% on the real staging domain, prove the version header, retain sanitized failure evidence,
and pass the no-duplicate-POST rollback policy tests before it is sealed for approval.
