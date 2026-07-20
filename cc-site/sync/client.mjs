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
    const response = await this.#get('/api/cc-sync/page', [
      ['item_id', itemId],
      ['content_hash', contentHash],
    ]);
    return Buffer.from(await response.arrayBuffer());
  }

  async #getJson(pathname, query) {
    const response = await this.#get(pathname, query);
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`invalid JSON from ${pathname}`, { cause: error });
    }
  }

  async #get(pathname, query) {
    const url = new URL(pathname, `${this.baseUrl}/`);
    for (const [key, value] of query) url.searchParams.append(key, value);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('cc sync request timeout')),
      this.requestTimeoutMs,
    );

    let response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: signedHeaders({
          secret: this.secret,
          method: 'GET',
          url,
        }),
        signal: controller.signal,
      });
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

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 256).trim();
      throw new Error(
        `cc sync request failed: ${response.status} ${detail || response.statusText}`,
      );
    }
    return response;
  }
}
