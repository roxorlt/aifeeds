# G8 v10 perf-staging failure review

Operation: `g8-v10-d85e7f2-perf-staging`

## Outcome

G8 v10 proved the sealed Worker activation design: the candidate version passed the
zero-percent version override media contract, was promoted to 100 percent, produced
five consecutive unoverridden candidate responses, and passed the Worker/Pages base
contract. The subsequent functional gate failed before account creation or browser
execution. The automatic rollback restored the fixed Worker and Pages baselines and
removed all owned D1/R2/cookie state. Production and `main` were not changed.

## Evidence

- Candidate Worker version: `4502f21f-94dd-4ef3-b16a-b12bc7a12cdc`.
- Rollback summary status: `pass`.
- Restored Worker version: `95070a90-999a-421d-868b-ec5e9677caec`.
- Restored Pages deployment: `89f3f473-961a-4d12-97be-d1102276653d`.
- The D1 post-seed query proved both owned rows existed with the required media and
  synthetic ownership fields.
- nginx recorded the X list request at `20:41:50Z` as HTTP 200 with 1,898 bytes and
  the news list request at `20:41:52Z` as HTTP 200 with 20,338 bytes. Because the
  second request ran, the preceding X fixture assertion had already passed.

## Root cause

The owned blog fixture was fresh but had none of the fields used by the live
`blog,podcast` composite ranking beyond freshness. Its expected score was about 48.
The endpoint ranks by relevance, freshness, source authority, impact, heat,
completeness, and named-industry-person signals before applying `limit=12`. Existing
staging news therefore displaced the owned fixture from the exact UI response. The
gate correctly failed its fixture-visibility assertion, but this was an acceptance
fixture defect rather than a candidate application regression.

## Corrective action

The next packet must seed a rank-dominant owned news fixture with the maximum bounded
ranking signals (`model-release`, `OpenAI`, complete summary/body, high synthetic
likes, and a title containing the fixed launch/model/person terms). It must assert the
owned fixture is the first row of the exact UI list before continuing. A repository
contract test freezes those signals so future packet assembly cannot silently return
to a freshness-only fixture.

No production-code ranking change is required.
