const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_SEARCH_MAX_BYTES = 256 * 1024;

const ALLOWED_SOURCE_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'text/plain', 'application/json', 'application/pdf',
]);

export type TrustedGatewayFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TrustedResearchService {
  /** Exact HTTPS origin of the peer-pinning research gateway. Paths, query, and fragments are forbidden. */
  origin: string;
  /** Server-side token. It is never returned to or accepted from browser/user input. */
  token: string;
  fetcher?: TrustedGatewayFetcher;
}

export interface PublicDocument {
  url: string;
  content_type: string;
  extraction: 'html' | 'text' | 'json' | 'pdf_text';
  body: string;
  redirects: number;
  bytes: number;
}

export interface PublicWebSearchResult {
  url: string;
  title: string;
  snippet: string;
  published_at: string | null;
}

interface FetchAuditHop {
  url: string;
  validated_ip: string;
  connected_ip: string;
}

interface FetchAudit {
  hops: FetchAuditHop[];
  source_content_type: string;
  extraction: PublicDocument['extraction'];
}

function unsafe(reason: string): Error { return new Error(`unsafe_url:${reason}`); }

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.+$/, '');
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
}

function parseIpv6(value: string): number[] | null {
  let host = normalizedHostname(value);
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted) {
    const ipv4 = parseIpv4(dotted[2]);
    if (!ipv4) return null;
    host = `${dotted[1]}${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/i.test(host) || (host.match(/::/g) || []).length > 1) return null;
  const [leftPart, rightPart = ''] = host.split('::');
  const left = leftPart ? leftPart.split(':') : [];
  const right = rightPart ? rightPart.split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const omitted = 8 - left.length - right.length;
  if ((host.includes('::') && omitted < 1) || (!host.includes('::') && omitted !== 0)) return null;
  return [...left, ...Array(Math.max(0, omitted)).fill('0'), ...right].map((part) => parseInt(part, 16));
}

export function isPublicIpAddress(value: string): boolean {
  const host = normalizedHostname(value);
  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) || a >= 224
    ) return false;
    return true;
  }
  if (!host.includes(':')) return false;
  const ipv6 = parseIpv6(host);
  if (!ipv6) return false;
  if (ipv6.every((part) => part === 0) || (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1)) return false;
  if ((ipv6[0] & 0xfe00) === 0xfc00) return false;
  if ((ipv6[0] & 0xffc0) === 0xfe80) return false;
  if ((ipv6[0] & 0xff00) === 0xff00) return false;
  if (ipv6[0] === 0x2001 && ipv6[1] === 0x0db8) return false;
  const embeddedV4 = ipv6.slice(0, 5).every((part) => part === 0) && (ipv6[5] === 0 || ipv6[5] === 0xffff);
  if (embeddedV4) {
    return isPublicIpAddress(`${ipv6[6] >> 8}.${ipv6[6] & 255}.${ipv6[7] >> 8}.${ipv6[7] & 255}`);
  }
  return true;
}

export function validatePublicHttpUrl(input: string): URL {
  let url: URL;
  try { url = new URL(String(input || '').trim()); } catch { throw unsafe('invalid'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw unsafe('protocol');
  if (url.username || url.password) throw unsafe('credentials');
  if (url.port && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'))) {
    throw unsafe('port');
  }
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw unsafe('host');
  if ((parseIpv4(hostname) || hostname.includes(':')) && !isPublicIpAddress(hostname)) throw unsafe('literal_address');
  url.hostname = url.hostname.replace(/\.+$/, '');
  return url;
}

function trustedEndpoint(service: TrustedResearchService | undefined, path: '/v1/document' | '/v1/search') {
  if (!service) throw new Error('trusted_research_service_required');
  let origin: URL;
  try { origin = validatePublicHttpUrl(service.origin); } catch { throw new Error('invalid_trusted_research_origin'); }
  if (
    origin.protocol !== 'https:' || origin.username || origin.password || origin.port ||
    (origin.pathname !== '/' && origin.pathname !== '') || origin.search || origin.hash
  ) throw new Error('invalid_trusted_research_origin');
  if (!service.token || service.token.length > 512) throw new Error('invalid_trusted_research_token');
  return { url: new URL(path, origin), fetcher: service.fetcher ?? fetch, token: service.token };
}

function strictObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function parseFetchAudit(response: Response, requested: URL, maxRedirects: number): FetchAudit {
  const encoded = response.headers.get('X-AIFeeds-Fetch-Audit') || '';
  if (!encoded || encoded.length > 8_192) throw new Error('unsafe_gateway_audit:missing');
  let raw: unknown;
  try { raw = JSON.parse(decodeURIComponent(encoded)); } catch { throw new Error('unsafe_gateway_audit:invalid_json'); }
  if (!strictObject(raw, ['hops', 'source_content_type', 'extraction']) || !Array.isArray(raw.hops)) {
    throw new Error('unsafe_gateway_audit:invalid_schema');
  }
  if (raw.hops.length < 1) throw new Error('unsafe_gateway_audit:missing_hop');
  if (raw.hops.length - 1 > maxRedirects) throw new Error('too_many_redirects');
  const hops: FetchAuditHop[] = [];
  for (const value of raw.hops) {
    if (!strictObject(value, ['url', 'validated_ip', 'connected_ip'])
      || typeof value.url !== 'string' || typeof value.validated_ip !== 'string' || typeof value.connected_ip !== 'string') {
      throw new Error('unsafe_gateway_audit:invalid_hop');
    }
    const url = validatePublicHttpUrl(value.url).toString();
    const validated = normalizedHostname(value.validated_ip);
    const connected = normalizedHostname(value.connected_ip);
    if (!isPublicIpAddress(validated) || !isPublicIpAddress(connected) || validated !== connected) {
      throw new Error('unsafe_gateway_audit:peer_mismatch');
    }
    hops.push({ url, validated_ip: validated, connected_ip: connected });
  }
  if (hops[0].url !== requested.toString()) throw new Error('unsafe_gateway_audit:request_mismatch');
  if (typeof raw.source_content_type !== 'string' || !ALLOWED_SOURCE_TYPES.has(raw.source_content_type)) {
    throw new Error('unsafe_gateway_audit:content_type');
  }
  if (raw.source_content_type === 'application/pdf' && raw.extraction !== 'pdf_text') {
    throw new Error('invalid_pdf_extraction');
  }
  if (!['html', 'text', 'json', 'pdf_text'].includes(String(raw.extraction))) {
    throw new Error('unsafe_gateway_audit:extraction');
  }
  const extraction = raw.extraction as PublicDocument['extraction'];
  const expectedExtraction: Record<string, PublicDocument['extraction']> = {
    'text/html': 'html', 'application/xhtml+xml': 'html', 'text/plain': 'text',
    'application/json': 'json', 'application/pdf': 'pdf_text',
  };
  if (expectedExtraction[raw.source_content_type] !== extraction) throw new Error('unsafe_gateway_audit:extraction_mismatch');
  return { hops, source_content_type: raw.source_content_type, extraction };
}

async function withinDeadline<T>(promise: Promise<T>, deadline: number, controller: AbortController): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    controller.abort();
    throw new Error('gateway_timeout');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('gateway_timeout'));
        }, remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  deadline: number,
  controller: AbortController,
): Promise<{ text: string; bytes: number }> {
  const declared = Number(response.headers.get('Content-Length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response_too_large');
  if (!response.body) return { text: '', bytes: 0 };
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const chunk = await withinDeadline(reader.read(), deadline, controller);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel('response_too_large');
        throw new Error('response_too_large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { text, bytes };
  } catch (error) {
    try { await reader.cancel(); } catch { /* already closed */ }
    if (error instanceof TypeError) throw new Error('invalid_gateway_utf8');
    throw error;
  }
}

async function postTrusted(
  service: TrustedResearchService | undefined,
  path: '/v1/document' | '/v1/search',
  payload: unknown,
  timeoutMs: number,
): Promise<{ response: Response; deadline: number; controller: AbortController }> {
  const endpoint = trustedEndpoint(service, path);
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const response = await withinDeadline(endpoint.fetcher(endpoint.url, {
    method: 'POST', redirect: 'error', signal: controller.signal,
    headers: {
      Accept: path === '/v1/search' ? 'application/json' : 'text/plain',
      Authorization: `Bearer ${endpoint.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ai-feeds-manual-news-lead/2.0',
    },
    body: JSON.stringify(payload),
  }), deadline, controller);
  if (!response.ok) {
    controller.abort();
    throw new Error(`trusted_gateway_http_${response.status}`);
  }
  return { response, deadline, controller };
}

/**
 * Security invariant: this Worker never issues fetch() to a user-controlled host.
 * The only network peer is an exact configured HTTPS research-service origin. That
 * service must pin DNS validation to the connected peer on every hop and returns
 * a hop audit; this function rejects any private or mismatched validated/connected
 * address before consuming the body.
 */
export async function fetchPublicDocument(
  input: string,
  deps: {
    service?: TrustedResearchService;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
  } = {},
): Promise<PublicDocument> {
  const target = validatePublicHttpUrl(input);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const { response, deadline, controller } = await postTrusted(
    deps.service, '/v1/document', { url: target.toString(), max_bytes: maxBytes, max_redirects: maxRedirects }, timeoutMs,
  );
  try {
    const transportType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (transportType !== 'text/plain') throw new Error('invalid_gateway_content_type');
    const audit = parseFetchAudit(response, target, maxRedirects);
    const body = await readBoundedBody(response, maxBytes, deadline, controller);
    return {
      url: audit.hops.at(-1)!.url,
      content_type: audit.source_content_type,
      extraction: audit.extraction,
      body: body.text,
      redirects: audit.hops.length - 1,
      bytes: body.bytes,
    };
  } finally {
    controller.abort();
  }
}

function normalizedPublishedAt(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export async function searchPublicWeb(
  input: { text: string; date: string },
  deps: { service?: TrustedResearchService; timeoutMs?: number; maxBytes?: number } = {},
): Promise<PublicWebSearchResult[]> {
  const text = input.text.trim();
  if (!text || Array.from(text).length > 4_000 || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error('invalid_search_request');
  }
  const { response, deadline, controller } = await postTrusted(
    deps.service, '/v1/search', { query: text, date: input.date, limit: 8 }, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw new Error('invalid_search_response:content_type');
    const body = await readBoundedBody(response, deps.maxBytes ?? DEFAULT_SEARCH_MAX_BYTES, deadline, controller);
    let raw: unknown;
    try { raw = JSON.parse(body.text); } catch { throw new Error('invalid_search_response:json'); }
    if (!strictObject(raw, ['results']) || !Array.isArray(raw.results) || raw.results.length > 8) {
      throw new Error('invalid_search_response:schema');
    }
    return raw.results.map((value) => {
      if (!strictObject(value, ['url', 'title', 'snippet', 'published_at'])
        || typeof value.url !== 'string' || typeof value.title !== 'string' || typeof value.snippet !== 'string') {
        throw new Error('invalid_search_response:item');
      }
      const publishedAt = normalizedPublishedAt(value.published_at);
      if (publishedAt === undefined || !value.title.trim() || !value.snippet.trim()
        || Array.from(value.title).length > 220 || Array.from(value.snippet).length > 1_500) {
        throw new Error('invalid_search_response:item');
      }
      let url: string;
      try { url = validatePublicHttpUrl(value.url).toString(); } catch { throw new Error('invalid_search_response:url'); }
      return { url, title: value.title.trim(), snippet: value.snippet.trim(), published_at: publishedAt };
    });
  } finally {
    controller.abort();
  }
}
