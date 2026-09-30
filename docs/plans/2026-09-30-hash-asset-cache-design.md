# Hash asset browser caching

Status: publishing authorized; validation and deployment receipts are recorded
in the task handoff. Only the static asset cache change is authorized here.

The public production main/API chunks and CSS currently return `public,
max-age=0, must-revalidate`. Read-only inspection of the production frontend
nginx vhost found its fallback proxies Pages without overriding Cache-Control.
The existing Pages `_routes.json` excludes `/assets/*` from Functions. Pages
static `_headers` therefore supplies the browser policy; Functions and HTML
response policies are outside this change.

The Vite build emits exact `_headers` entries for its hashed JS/CSS output names:
`public, max-age=31536000, immutable`. It deliberately has no wildcard, HTML,
API, public-directory asset, source-map, or Service Worker rule. Unexpected
unhashed JS/CSS output names and more than 100 rules stop the build. Every rule
must refer to a file in that build. A content change must produce a new hash;
never replace bytes behind a previously published hash.

This improves reuse of unchanged assets where HTTP caching is used. It does
not reduce first-visit resource bytes or prove any mainland LCP improvement;
the existing Service Worker already provides a separate return-visit cache.
The downloaded dependencies were copied from the existing local project for
offline validation, with no environment or credential files copied.

## Validation

- Dashboard production build, TypeScript check, and home build identity check.
- Asset policy and home build identity tests: seven passed.
- Targeted ESLint for the Vite config and cache policy module.
- Full dashboard lint and unit suite: 383 passed.
- Built artifact: 30 exact rules; each matches an existing JS/CSS output;
  `/assets/*` remains excluded from Functions.
- No UI code changed. The existing five-device E2E gate must pass before
  production deployment. Initial local execution was blocked by absent pinned
  browser binaries; use the exact pinned binaries or CI, never count it as passed.

After a separately approved release, check a known built resource on both
Pages and the public domain for the expected header, verify HTML/API/sw.js
policies are unchanged, and check an absent asset is not immutable-cached.
Existing nginx cached responses may need to expire before the new upstream
header is visible. Do not purge or alter the proxy as part of this local patch.
Rollback removes the build plugin on the next approved release; previously
cached immutable files remain valid because their names identify their bytes.

## Follow-up boundaries

Anonymous API caching needs a separately reviewed allowlist of GET query shapes,
credential handling, complete cache keys, CORS variants, freshness requirements,
and error-response handling. Never share auth or personalized responses.
Same-origin API routing affects cookies, auth, and proxy identity and must follow
the existing staging experiment. SSR must preserve canonical, view preference,
fallback, freshness, and hydration contracts. Neither is changed here.

Mainland acceptance requires unauthenticated cold and warm visits on unproxied
China Telecom, Unicom, and Mobile networks, measuring TLS/TTFB, LCP, resource
waterfall, and API timing separately. TUN measurements are not acceptance data.

Official header behavior and rule limits:
https://developers.cloudflare.com/pages/configuration/headers/
