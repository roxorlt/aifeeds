const TIMESTAMP_HEADER = "X-CC-Timestamp";
const SIGNATURE_HEADER = "X-CC-Signature";
const SIGNATURE_RE = /^[0-9a-f]{64}$/;
const CANONICAL_TIMESTAMP_RE = /^(0|[1-9][0-9]*)$/;
const MAX_CLOCK_SKEW_SECONDS = 60;
export const CC_SYNC_MAX_BODY_BYTES = 64 * 1024;

export type CcSyncAuthResult =
  | { ok: true }
  | { ok: false; response: Response };

class CcSyncBodyTooLargeError extends Error {
  constructor() {
    super("cc sync request body exceeds limit");
    this.name = "CcSyncBodyTooLargeError";
  }
}

export function canonicalizeCcSyncQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(
    ([key, value], index) => ({ key, value, index }),
  );
  pairs.sort((left, right) => {
    const keyOrder = compareCodeUnits(left.key, right.key);
    if (keyOrder !== 0) return keyOrder;
    const valueOrder = compareCodeUnits(left.value, right.value);
    return valueOrder !== 0 ? valueOrder : left.index - right.index;
  });
  return pairs
    .map(({ key, value }) =>
      `${encodeRfc3986Component(key)}=${encodeRfc3986Component(value)}`
    )
    .join("&");
}

export async function buildCcSyncCanonicalRequest(
  request: Request,
  timestamp: string,
): Promise<string> {
  const body = await readBoundedBody(request.clone());
  return buildCanonicalRequest(request, timestamp, body);
}

async function buildCanonicalRequest(
  request: Request,
  timestamp: string,
  body: Uint8Array,
): Promise<string> {
  const url = new URL(request.url);
  return [
    timestamp,
    request.method.toUpperCase(),
    url.pathname,
    canonicalizeCcSyncQuery(url),
  ].join("\n") + `\n${await sha256Hex(body)}`;
}

export async function signCcSyncRequest(
  request: Request,
  secret: string,
  timestamp: string,
): Promise<string> {
  const canonical = await buildCcSyncCanonicalRequest(request, timestamp);
  return signCanonicalRequest(canonical, secret);
}

async function signCanonicalRequest(
  canonical: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonical),
  );
  return bytesToHex(new Uint8Array(bytes));
}

export async function verifyCcSyncRequest(
  request: Request,
  secret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CcSyncAuthResult> {
  if (!secret) {
    return {
      ok: false,
      response: authError(503, "sync unavailable"),
    };
  }

  if (advertisedBodyTooLarge(request.headers)) {
    return { ok: false, response: authError(413, "payload too large") };
  }

  const timestamp = request.headers.get(TIMESTAMP_HEADER) ?? "";
  const signature = request.headers.get(SIGNATURE_HEADER) ?? "";
  if (
    !isCanonicalTimestamp(timestamp)
    || !SIGNATURE_RE.test(signature)
  ) {
    return { ok: false, response: authError(401, "unauthorized") };
  }

  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(nowSeconds)
    || Math.abs(nowSeconds - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS
  ) {
    return { ok: false, response: authError(401, "unauthorized") };
  }

  let body: Uint8Array;
  try {
    // The sync handler never needs a request body after authentication.
    // Consume the original stream here to avoid Request.clone() tee buffering
    // untrusted bytes while still enforcing the byte limit chunk by chunk.
    body = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof CcSyncBodyTooLargeError) {
      return { ok: false, response: authError(413, "payload too large") };
    }
    return { ok: false, response: authError(401, "unauthorized") };
  }

  const canonical = await buildCanonicalRequest(request, timestamp, body);
  const expected = await signCanonicalRequest(canonical, secret);
  if (!constantTimeHexEqual(signature, expected)) {
    return { ok: false, response: authError(401, "unauthorized") };
  }
  return { ok: true };
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  if (advertisedBodyTooLarge(request.headers)) {
    throw new CcSyncBodyTooLargeError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
      if (total + chunk.byteLength > CC_SYNC_MAX_BODY_BYTES) {
        try {
          await reader.cancel("payload too large");
        } catch {
          // Cancellation is best-effort; the response still fails closed.
        }
        throw new CcSyncBodyTooLargeError();
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Some test/runtime readers are already detached after cancellation.
    }
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function advertisedBodyTooLarge(headers: Headers): boolean {
  const value = headers.get("Content-Length");
  if (value === null || !CANONICAL_TIMESTAMP_RE.test(value)) return false;
  const limit = String(CC_SYNC_MAX_BODY_BYTES);
  return value.length > limit.length
    || (value.length === limit.length && value > limit);
}

export async function sha256Hex(
  value: string | ArrayBuffer | Uint8Array,
): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
    ? value
    : new Uint8Array(value);
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  );
}

function isCanonicalTimestamp(value: string): boolean {
  if (!CANONICAL_TIMESTAMP_RE.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && String(parsed) === value;
}

function encodeRfc3986Component(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function constantTimeHexEqual(left: string, right: string): boolean {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function authError(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
