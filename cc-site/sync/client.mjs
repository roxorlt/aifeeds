import { signedHeaders } from './auth.mjs';

export const RESPONSE_LIMITS = Object.freeze({
  json: 1024 * 1024,
  page: 8 * 1024 * 1024,
  error: 8 * 1024,
});

class ResponseTooLargeError extends Error {
  constructor(label, limit) {
    super(`${label} response body is too large (limit ${limit} bytes)`);
    this.name = 'ResponseTooLargeError';
  }
}

function declaredBodyTooLarge(response, limit) {
  const value = response.headers.get('Content-Length');
  if (value === null) return false;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error('invalid response Content-Length');
  }
  const maximum = String(limit);
  return value.length > maximum.length
    || (value.length === maximum.length && value > maximum);
}

export async function readBoundedResponse(response, limit, label) {
  if (declaredBodyTooLarge(response, limit)) {
    await response.body?.cancel('declared response body too large').catch(
      () => {},
    );
    throw new ResponseTooLargeError(label, limit);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
      if (total + chunk.byteLength > limit) {
        await reader.cancel('response body too large').catch(() => {});
        throw new ResponseTooLargeError(label, limit);
      }
      chunks.push(Buffer.from(chunk));
      total += chunk.byteLength;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Cancellation may already detach a runtime-specific reader.
    }
  }
  return Buffer.concat(chunks, total);
}

export class SyncClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = config.baseUrl;
    this.secret = config.secret;
    this.requestTimeoutMs = config.requestTimeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async bootstrap({ afterItemId, limit, watermark }) {
    return this.#getJson('/api/cc-sync/bootstrap', [
      ['after_item_id', afterItemId],
      ['limit', String(limit)],
      ['watermark', watermark === null ? '' : String(watermark)],
    ]);
  }

  async changes({ afterSeq, limit }) {
    return this.#getJson('/api/cc-sync/changes', [
      ['after_seq', String(afterSeq)],
      ['limit', String(limit)],
    ]);
  }

  async page({ itemId, contentHash }) {
    return this.#get('/api/cc-sync/page', [
      ['item_id', itemId],
      ['content_hash', contentHash],
    ], (response) => (
      readBoundedResponse(response, RESPONSE_LIMITS.page, 'page')
    ));
  }

  async #getJson(pathname, query) {
    return this.#get(pathname, query, async (response) => {
      try {
        const bytes = await readBoundedResponse(
          response,
          RESPONSE_LIMITS.json,
          'JSON',
        );
        return JSON.parse(bytes.toString('utf8'));
      } catch (error) {
        if (error instanceof ResponseTooLargeError) throw error;
        throw new Error(`invalid JSON from ${pathname}`, { cause: error });
      }
    });
  }

  async #get(pathname, query, consume) {
    const url = new URL(pathname, `${this.baseUrl}/`);
    for (const [key, value] of query) url.searchParams.append(key, value);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('cc sync request timeout')),
      this.requestTimeoutMs,
    );

    try {
      const response = await this.fetchImpl(url, {
        method: 'GET',
        headers: signedHeaders({
          secret: this.secret,
          method: 'GET',
          url,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        let detail;
        try {
          detail = (
            await readBoundedResponse(
              response,
              RESPONSE_LIMITS.error,
              'error',
            )
          ).toString('utf8').slice(0, 256).trim();
        } catch (error) {
          if (error instanceof ResponseTooLargeError) {
            throw new Error(
              `cc sync error response too large: ${response.status}`,
              { cause: error },
            );
          }
          throw error;
        }
        throw new Error(
          `cc sync request failed: ${response.status} ${detail || response.statusText}`,
        );
      }
      return await consume(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `cc sync request timeout after ${this.requestTimeoutMs}ms: ${pathname}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
