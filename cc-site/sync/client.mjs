import { signedHeaders } from './auth.mjs';

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
    ], async (response) => Buffer.from(await response.arrayBuffer()));
  }

  async #getJson(pathname, query) {
    return this.#get(pathname, query, async (response) => {
      try {
        return await response.json();
      } catch (error) {
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
        const detail = (await response.text()).slice(0, 256).trim();
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
