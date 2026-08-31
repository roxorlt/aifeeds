# Daily page stale-authorization recovery

## Incident

The 2026-08-31 video upload failed with `PUBLICATION_FORMAL_AUTHORIZATION_STALE`.
The current page head was structurally complete and published, but its stored formal-news
authorization snapshot no longer matched the live source rows. `generateDailyPage()` tried to
repair the page through `loadCurrentDailyReleaseForBuild()`, which performs the same outward
authorization check, creating a recovery deadlock.

## Classification

High risk: this touches the production publication authority boundary. The change must stay
limited to the page-rebuild input path and must not weaken outward reads, video upload, release
promotion, review-batch guards, formal-news guards, object integrity, or head CAS.

## Threat and failure model

Assets and trust boundaries:

- The current `daily_release_heads` row and append-only page/video publications are immutable
  release history.
- Formal-news authorization and the current review batch are live publication authority.
- R2 bytes, manifest digests, publication state, and the release-head tuple are integrity inputs.

Failure path:

1. A current page is validly published.
2. A source row or review authority changes, making the old page fail the outward guard.
3. Page regeneration tries to load that old page through the outward guard and cannot create a
   replacement, so video upload and SEO publication remain permanently blocked.

Required invariants:

1. Public page/video reads and daily-video upload keep using the strict outward-authorized loader.
2. Only the internal daily-page rebuild path may read a stale-authority head as a base.
3. The rebuild loader accepts only an exact, complete, published head whose page/video object
   states and manifest bindings are intact.
4. The replacement page must be built from freshly authorized current content and review state.
5. Promotion keeps the existing final formal guard, review guard, object verification, and exact
   base-head CAS; a concurrent head change fails closed.
6. Existing video reuse is allowed only from the exact current complete head and may not remove or
   substitute a video.

Explicit exclusions:

- No mutation of historical authorization snapshots.
- No bypass in `readAuthorizedDailyPage`, `readAuthorizedDailyVideo`, daily-video upload, or
  `promoteDailyRelease`.
- No D1 migration, R2 delete, manual head edit, or direct production data repair.

## Acceptance tests

1. Strict current-release loading still rejects a stale formal authorization snapshot.
2. The page-rebuild-only loader can recover the exact complete current head and its bound video.
3. A stale page can be replaced with a newly authorized page through normal reservation, PUT, and
   promotion.
4. Incomplete/mismatched heads and concurrent head changes remain rejected.
5. Daily-video upload still rejects the stale page before repair and succeeds only after the normal
   page replacement.
6. Focused publication and daily-page tests, TypeScript, and the required repository gates pass.
