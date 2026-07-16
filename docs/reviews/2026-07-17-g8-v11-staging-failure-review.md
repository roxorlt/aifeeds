# G8 v11 perf-staging failure review

Operation: `g8-v11-7230809-perf-staging`

## Outcome

G8 v11 passed Worker zero-percent override validation, promotion, five consecutive
live-version checks, Pages deployment, Worker/Pages contracts, the rank-dominant
synthetic feed seed, account login, and the stateful API gate. The five-device browser
gate then reported two failures. The exact automatic rollback restored the fixed Worker
and Pages baselines and removed the owned D1, R2, and cookie state. Production and
`main` were not changed.

## Evidence

- Candidate Worker version: `1648f3fd-1e9b-4c30-887e-37856cf467b5`.
- Candidate Pages deployment: `1dffed04-9e6c-4052-9067-e7124962b7f0`, asset
  `/assets/index-CQa652af.js`.
- Browser result: 12 passed, 2 failed, 31 skipped in 2.3 minutes. All 31 were expected
  conditional skips from device-specific cases and the disabled standalone collector
  self-tests; the pass distribution confirms that the WebKit and Android swipe cases ran.
- iPhone Chromium failed the owned blog first-card assertion because `currentSrc`
  remained empty for the eight-second poll. The helper had not yet called
  `HTMLImageElement.decode()`.
- iPhone WebKit failed because the shared assertion required warm-navigation
  `workerStartMs > 0`; the measured value was 0.
- A minimal localhost Service Worker control proved the engine difference using the
  repository-pinned browsers. Chromium returned `workerStart=0.7`, `transferSize=0`,
  `controller=true`, and Playwright `Response.fromServiceWorker()=true`. WebKit served
  the same synthetic navigation from the Worker and also reported
  `Response.fromServiceWorker()=true`, but returned `workerStart=0`, `fetchStart=0`,
  `responseStart=0`, `transferSize=0`, and `controller=true`.
- Rollback status: `pass`; summary SHA-256
  `383796b14720bd607d3fe245446b81f655efc2b3f6ddf744da2b14471cec229f`.
- Restored Worker version: `95070a90-999a-421d-868b-ec5e9677caec`.
- Restored Pages deployment: `89f3f473-961a-4d12-97be-d1102276653d`, asset
  `/assets/index-yt3d2G1n.js`.

## Root cause

The WebKit failure is a confirmed acceptance-contract defect. The image failure is
isolated to the acceptance synchronization/order path; the next sealed staging run must
still confirm that the revised assertion passes against the candidate application.

1. `PerformanceNavigationTiming.workerStart` is a valid Chromium signal but the pinned
   Playwright WebKit engine does not expose Service Worker navigation timestamps. The
   gate incorrectly treated that Chromium-only measurement as a universal requirement.
2. The exact-image helper read `currentSrc` before awaiting decode. During the newly
   mounted mobile channel, iPhone Chromium did not finish source selection within the
   generic poll, so the helper never reached its stronger decode check. The API seed
   gate had already proved the owned blog fixture was the first exact UI row, and the
   prior assertion passed on the other mobile engines. This supports a synchronization
   diagnosis but does not replace remote validation of the revised decode-first order.

## Corrective action

The warm-navigation gate now always requires the navigation response's direct
Playwright `fromServiceWorker()` proof, an active Service Worker controller, and zero
navigation transfer bytes. Chromium additionally retains `workerStartMs > 0`; WebKit
does not claim a timestamp it cannot report. The owned image gate is stricter: both X
and blog fixtures must be rank one, already visible in the first viewport, and
`loading="eager"`; it awaits successful decode before checking the exact responsive
variant path. It no longer scrolls a lower-ranked image into view and accidentally
passes a first-screen regression. The revised image order remains pending the next
sealed remote staging run.

A repository contract test was observed red before the fix and green afterward. The
next sealed packet must bind these revised browser assertions and retain the unchanged
automatic rollback boundaries.
