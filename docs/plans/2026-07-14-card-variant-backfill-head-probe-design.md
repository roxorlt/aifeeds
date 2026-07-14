# Card variant backfill HEAD probe design

## Context

The staging card-image variant spike resolved both a stored blog cover and an
X image back to their external source URLs, but produced no variants. The
normal `/img` path successfully produced a 400px WebP in the same Worker and
account. The important path difference is that backfill does not know the
source MIME type: `generateCardImageVariants` sends a preliminary `HEAD` and
currently returns immediately when that probe is rejected.

After making `HEAD` advisory and deploying it to staging, a connected Worker
tail exposed the second edge-runtime incompatibility: Workers rejects
`redirect: 'error'` before issuing either transformed request. The runtime
requires `follow` or `manual`. The existing `/img` path already uses `manual`
and validates every response instead of following it.

Some image origins serve `GET` correctly while rejecting or mishandling
`HEAD`, especially when the request comes from an edge network. Treating a
failed `HEAD` as proof that the source is not an image therefore creates a
false negative before Cloudflare Image Resizing receives the real request.

## Chosen design

Keep `HEAD`, but make it advisory. A successful probe with an explicit MIME
type remains authoritative: unsupported types such as GIF, SVG, audio, video,
or HTML are rejected before transformation. A non-2xx probe, a network error,
or a successful response without a MIME type is inconclusive and proceeds to
the existing bounded transformation loop.

Use `redirect: 'manual'` for both the advisory probe and transformed GETs.
Neither request follows a redirect: a 3xx response is not `ok`, so the probe
remains inconclusive and each transformed width is skipped. This preserves the
original no-redirect security boundary while using an option supported by the
Cloudflare edge runtime.

The transformation loop remains the final safety and correctness boundary:

- the source must already pass the HTTPS, self-host, Worker-host, loopback, and
  private-IP-literal eligibility checks;
- redirects remain disabled;
- the response must be a successful `image/webp`;
- each body is limited to 512 KiB;
- actual WebP dimensions are parsed when possible;
- objects are content-addressed and the original image remains the fallback.

This is intentionally smaller than deleting `HEAD` entirely and avoids an R2
metadata migration for existing objects.

## Verification

Add a regression test in which `HEAD` returns 405 while the two transformed
GET requests return valid WebP responses; both variants must be stored and all
three requests must use `redirect: 'manual'`. Keep
the existing extensionless-GIF test to prove that a successful, explicit
unsupported MIME probe still rejects the source. Run the focused test red
before implementation, then the Worker suite and the full release G0 after
the minimal source change.
