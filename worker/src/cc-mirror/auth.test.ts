import { describe, expect, it } from "vitest";
import {
  buildCcSyncCanonicalRequest,
  CC_SYNC_MAX_BODY_BYTES,
  canonicalizeCcSyncQuery,
  signCcSyncRequest,
  verifyCcSyncRequest,
} from "./auth";

const SECRET = "task-7-fixture-secret";
const NOW_SECONDS = 1_753_000_000;

function fakeStreamingRequest(
  chunks: Uint8Array[],
  headers = new Headers(),
  method = "GET",
) {
  const reads = { original: 0, clone: 0 };
  const cancels = { original: 0, clone: 0 };
  const url = "https://api.ai-feeds.com/api/cc-sync/health";

  function body(kind: "original" | "clone") {
    let index = 0;
    return {
      getReader() {
        return {
          async read() {
            reads[kind] += 1;
            if (index >= chunks.length) {
              return { done: true, value: undefined };
            }
            return { done: false, value: chunks[index++] };
          },
          async cancel() {
            cancels[kind] += 1;
          },
          releaseLock() {},
        };
      },
    };
  }

  const request = {
    url,
    method,
    headers,
    body: body("original"),
    clone() {
      return {
        url,
        method,
        headers,
        body: body("clone"),
      };
    },
  } as unknown as Request;

  return { request, reads, cancels };
}

function request(
  path: string,
  init: RequestInit = {},
): Request {
  return new Request(`https://api.ai-feeds.com${path}`, init);
}

async function signedRequest(
  path: string,
  init: RequestInit = {},
  timestamp = String(NOW_SECONDS),
): Promise<Request> {
  const unsigned = request(path, init);
  const signature = await signCcSyncRequest(unsigned, SECRET, timestamp);
  const headers = new Headers(unsigned.headers);
  headers.set("X-CC-Timestamp", timestamp);
  headers.set("X-CC-Signature", signature);
  return new Request(unsigned, { headers });
}

describe("cc sync canonical request", () => {
  it("sorts decoded duplicate query pairs and applies strict RFC3986 encoding", () => {
    const url = new URL(
      "https://api.ai-feeds.com/api/cc-sync/page"
        + "?z=&a=space+value&a=%21%27%28%29%2A&a=space%20value&%C3%A9=%2F",
    );

    expect(canonicalizeCcSyncQuery(url)).toBe(
      "a=%21%27%28%29%2A&a=space%20value&a=space%20value"
        + "&z=&%C3%A9=%2F",
    );
  });

  it("keeps the fixed cross-runtime signing fixture stable", async () => {
    const req = request(
      "/api/cc-sync/page?item_id=x_list%3A42&content_hash="
        + "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    const canonical = await buildCcSyncCanonicalRequest(req, "1753000000");

    expect(canonical).toBe(
      "1753000000\n"
        + "GET\n"
        + "/api/cc-sync/page\n"
        + "content_hash=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        + "&item_id=x_list%3A42\n"
        + "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await signCcSyncRequest(req, SECRET, "1753000000")).toBe(
      "6453e5535a85f8d9e403e2ab5cfec0df97a597afdcd0d105fb8f43e0dae83909",
    );
  });

  it("hashes even a non-standard GET body through clone without consuming it", async () => {
    const timestamp = String(NOW_SECONDS);
    const bodyA = fakeStreamingRequest([
      new TextEncoder().encode("body A"),
    ]);
    const signatureA = await signCcSyncRequest(
      bodyA.request,
      SECRET,
      timestamp,
    );
    expect(bodyA.reads.original).toBe(0);
    expect(bodyA.reads.clone).toBeGreaterThan(0);

    const headers = new Headers({
      "X-CC-Timestamp": timestamp,
      "X-CC-Signature": signatureA,
    });
    const bodyB = fakeStreamingRequest([
      new TextEncoder().encode("body B"),
    ], headers);
    const result = await verifyCcSyncRequest(
      bodyB.request,
      SECRET,
      NOW_SECONDS,
    );
    expect(result.ok).toBe(false);
    expect(bodyB.reads.original).toBeGreaterThan(0);
    expect(bodyB.reads.clone).toBe(0);
  });
});

describe("verifyCcSyncRequest", () => {
  it("accepts a valid signature at both inclusive 60 second boundaries", async () => {
    for (const timestamp of [
      String(NOW_SECONDS - 60),
      String(NOW_SECONDS + 60),
    ]) {
      const req = await signedRequest(
        "/api/cc-sync/changes?after_seq=12&limit=200",
        {},
        timestamp,
      );
      await expect(
        verifyCcSyncRequest(req, SECRET, NOW_SECONDS),
      ).resolves.toEqual({ ok: true });
    }
  });

  it("rejects missing secret with 503 and auth failures with 401/no-store", async () => {
    const valid = await signedRequest("/api/cc-sync/health");
    const missingSecret = await verifyCcSyncRequest(valid, undefined, NOW_SECONDS);
    expect(missingSecret.ok).toBe(false);
    if (!missingSecret.ok) {
      expect(missingSecret.response.status).toBe(503);
      expect(missingSecret.response.headers.get("Cache-Control")).toBe("no-store");
    }

    for (const req of [
      request("/api/cc-sync/health"),
      await signedRequest(
        "/api/cc-sync/health",
        {},
        String(NOW_SECONDS - 61),
      ),
      await signedRequest(
        "/api/cc-sync/health",
        {},
        String(NOW_SECONDS + 61),
      ),
    ]) {
      const result = await verifyCcSyncRequest(req, SECRET, NOW_SECONDS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(401);
        expect(result.response.headers.get("Cache-Control")).toBe("no-store");
      }
    }
  });

  it("rejects non-canonical timestamps and malformed signatures", async () => {
    for (const timestamp of [
      "01753000000",
      "+1753000000",
      "1753000000.0",
      "NaN",
      "",
    ]) {
      const req = await signedRequest(
        "/api/cc-sync/health",
        {},
        timestamp || "1753000000",
      );
      const headers = new Headers(req.headers);
      headers.set("X-CC-Timestamp", timestamp);
      const altered = new Request(req, { headers });
      const result = await verifyCcSyncRequest(altered, SECRET, NOW_SECONDS);
      expect(result.ok, timestamp).toBe(false);
    }

    const valid = await signedRequest("/api/cc-sync/health");
    for (const signature of [
      "0".repeat(63),
      "0".repeat(65),
      "G".repeat(64),
      "A".repeat(64),
    ]) {
      const headers = new Headers(valid.headers);
      headers.set("X-CC-Signature", signature);
      const result = await verifyCcSyncRequest(
        new Request(valid, { headers }),
        SECRET,
        NOW_SECONDS,
      );
      expect(result.ok, signature).toBe(false);
    }
  });

  it("binds method, path, duplicate query values, and body into the signature", async () => {
    const original = await signedRequest(
      "/api/cc-sync/unknown?a=1&a=2",
      { method: "POST", body: "payload" },
    );
    const signature = original.headers.get("X-CC-Signature")!;
    const timestamp = original.headers.get("X-CC-Timestamp")!;
    const variants = [
      request("/api/cc-sync/unknown?a=1&a=2", { method: "PUT", body: "payload" }),
      request("/api/cc-sync/other?a=1&a=2", { method: "POST", body: "payload" }),
      request("/api/cc-sync/unknown?a=1&a=3", { method: "POST", body: "payload" }),
      request("/api/cc-sync/unknown?a=1&a=2", { method: "POST", body: "changed" }),
    ];

    for (const variant of variants) {
      const headers = new Headers(variant.headers);
      headers.set("X-CC-Timestamp", timestamp);
      headers.set("X-CC-Signature", signature);
      const result = await verifyCcSyncRequest(
        new Request(variant, { headers }),
        SECRET,
        NOW_SECONDS,
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects an oversized Content-Length before reading the stream", async () => {
    const signature = "a".repeat(64);
    for (const contentLength of [
      String(CC_SYNC_MAX_BODY_BYTES + 1),
      "9".repeat(100),
    ]) {
      const headers = new Headers({
        "Content-Length": contentLength,
        "X-CC-Timestamp": String(NOW_SECONDS),
        "X-CC-Signature": signature,
      });
      const oversized = fakeStreamingRequest([
        new Uint8Array([1]),
      ], headers);

      const result = await verifyCcSyncRequest(
        oversized.request,
        SECRET,
        NOW_SECONDS,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(413);
        expect(result.response.headers.get("Cache-Control")).toBe("no-store");
        const body = await result.response.text();
        expect(body).not.toContain(SECRET);
        expect(body).not.toContain(signature);
      }
      expect(oversized.reads.original).toBe(0);
      expect(oversized.cancels.original).toBe(0);
    }
  });

  it("cancels a chunked/falsely-small body as soon as it crosses the limit", async () => {
    for (const contentLength of [null, "1"]) {
      const headers = new Headers({
        "X-CC-Timestamp": String(NOW_SECONDS),
        "X-CC-Signature": "b".repeat(64),
      });
      if (contentLength !== null) {
        headers.set("Content-Length", contentLength);
      }
      const oversized = fakeStreamingRequest([
        new Uint8Array(40 * 1024),
        new Uint8Array(24 * 1024),
        new Uint8Array(1),
        new Uint8Array(8 * 1024),
      ], headers);

      const result = await verifyCcSyncRequest(
        oversized.request,
        SECRET,
        NOW_SECONDS,
      );
      expect(result.ok, String(contentLength)).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(413);
        expect(result.response.headers.get("Cache-Control")).toBe("no-store");
      }
      expect(oversized.reads.original).toBe(3);
      expect(oversized.cancels.original).toBe(1);
      expect(oversized.reads.clone).toBe(0);
    }
  });

  it("signs and verifies a body exactly at the byte limit", async () => {
    const bytes = new Uint8Array(CC_SYNC_MAX_BODY_BYTES);
    bytes.fill(97);
    const timestamp = String(NOW_SECONDS);
    const signingRequest = fakeStreamingRequest([bytes]);
    const signature = await signCcSyncRequest(
      signingRequest.request,
      SECRET,
      timestamp,
    );
    expect(signingRequest.reads.original).toBe(0);
    expect(signingRequest.reads.clone).toBeGreaterThan(0);

    const headers = new Headers({
      "Content-Length": String(CC_SYNC_MAX_BODY_BYTES),
      "X-CC-Timestamp": timestamp,
      "X-CC-Signature": signature,
    });
    const verifyingRequest = fakeStreamingRequest([bytes], headers);
    await expect(
      verifyCcSyncRequest(verifyingRequest.request, SECRET, NOW_SECONDS),
    ).resolves.toEqual({ ok: true });
    expect(verifyingRequest.reads.original).toBeGreaterThan(0);
    expect(verifyingRequest.reads.clone).toBe(0);
  });
});
