const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARACTERS = 1_000_000;
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
  fetch_audit: DocumentFetchAudit;
}

export interface PublicWebSearchResult {
  url: string;
  title: string;
  snippet: string;
  published_at: string | null;
}

export interface FetchAuditHop {
  url: string;
  validated_ip: string;
  connected_ip: string;
}

export interface DocumentExtractionLimits {
  source_bytes: number;
  extracted_text_bytes: number;
  extracted_text_characters: number;
}

export interface DocumentFetchAudit {
  hops: FetchAuditHop[];
  source_content_type: string;
  extraction: PublicDocument['extraction'];
  requested_limits: DocumentExtractionLimits;
  applied_limits: DocumentExtractionLimits;
  actual_sizes: DocumentExtractionLimits;
  truncation: { source: boolean; extracted_text: boolean };
  parser: { result: 'success'; version: string };
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

interface SpecialIpv4Range { cidr: string; reason: string; }

// IANA IPv4 Special-Purpose Address Registry ranges. Treat the whole registry
// as non-targetable: even globally routed anycast/protocol assignments are not
// ordinary origin peers and must fail closed at this research boundary.
const SPECIAL_IPV4_RANGES: readonly SpecialIpv4Range[] = [
  { cidr: '0.0.0.0/8', reason: 'this-network' },
  { cidr: '10.0.0.0/8', reason: 'private-use' },
  { cidr: '100.64.0.0/10', reason: 'shared-address-space' },
  { cidr: '127.0.0.0/8', reason: 'loopback' },
  { cidr: '169.254.0.0/16', reason: 'link-local' },
  { cidr: '172.16.0.0/12', reason: 'private-use' },
  { cidr: '192.0.0.0/24', reason: 'ietf-protocol-assignments' },
  { cidr: '192.0.2.0/24', reason: 'documentation' },
  { cidr: '192.31.196.0/24', reason: 'as112-v4' },
  { cidr: '192.52.193.0/24', reason: 'amt' },
  { cidr: '192.88.99.0/24', reason: 'deprecated-6to4-relay' },
  { cidr: '192.168.0.0/16', reason: 'private-use' },
  { cidr: '192.175.48.0/24', reason: 'as112-direct-delegation' },
  { cidr: '198.18.0.0/15', reason: 'benchmarking' },
  { cidr: '198.51.100.0/24', reason: 'documentation' },
  { cidr: '203.0.113.0/24', reason: 'documentation' },
  { cidr: '224.0.0.0/4', reason: 'multicast' },
  { cidr: '240.0.0.0/4', reason: 'reserved' },
] as const;

function ipv4Number(octets: readonly number[]): number {
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

const COMPILED_SPECIAL_IPV4_RANGES = SPECIAL_IPV4_RANGES.map((range) => {
  const [address, prefixText] = range.cidr.split('/');
  const octets = parseIpv4(address)!;
  const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { ...range, network: ipv4Number(octets) & mask, mask };
});

function isGlobalUnicastIpv4(octets: readonly number[]): boolean {
  const address = ipv4Number(octets);
  return !COMPILED_SPECIAL_IPV4_RANGES.some((range) => (address & range.mask) === range.network);
}

function ipv6Bytes(words: readonly number[]): number[] {
  return words.flatMap((word) => [word >>> 8, word & 0xff]);
}

function bytesMatchPrefix(bytes: readonly number[], prefix: readonly number[], prefixBits: number): boolean {
  const fullBytes = Math.floor(prefixBits / 8);
  for (let index = 0; index < fullBytes; index++) if (bytes[index] !== prefix[index]) return false;
  const remaining = prefixBits % 8;
  if (!remaining) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

function embeddedIpv4IsGlobal(bytes: readonly number[]): boolean {
  return bytes.length === 4 && isGlobalUnicastIpv4(bytes);
}

export function isPublicIpAddress(value: string): boolean {
  const host = normalizedHostname(value);
  const ipv4 = parseIpv4(host);
  if (ipv4) return isGlobalUnicastIpv4(ipv4);
  if (!host.includes(':')) return false;
  const ipv6 = parseIpv6(host);
  if (!ipv6) return false;
  const bytes = ipv6Bytes(ipv6);

  // IPv4-compatible and IPv4-mapped forms.
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return embeddedIpv4IsGlobal(bytes.slice(12));
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return embeddedIpv4IsGlobal(bytes.slice(12));
  }
  // RFC 6052 well-known NAT64 /96.
  if (bytesMatchPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) {
    return embeddedIpv4IsGlobal(bytes.slice(12));
  }
  // RFC 8215 local-use NAT64 /48. For a /48 prefix, the IPv4 bits occupy
  // bytes 6,7,9,10 and byte 8 is the required zero u-octet (RFC 6052).
  if (bytesMatchPrefix(bytes, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) {
    return bytes[8] === 0 && embeddedIpv4IsGlobal([bytes[6], bytes[7], bytes[9], bytes[10]]);
  }
  // 6to4 carries the origin IPv4 directly after 2002::/16.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return embeddedIpv4IsGlobal(bytes.slice(2, 6));
  // Teredo carries a server IPv4 and an obfuscated client IPv4. Both peers must
  // be global unicast; accepting only one would permit a private rebinding path.
  if (bytesMatchPrefix(bytes, [0x20, 0x01, 0x00, 0x00], 32)) {
    const client = bytes.slice(12, 16).map((byte) => byte ^ 0xff);
    return embeddedIpv4IsGlobal(bytes.slice(4, 8)) && embeddedIpv4IsGlobal(client);
  }

  // Current ordinary IPv6 global unicast is 2000::/3. Reject future/reserved
  // address space until IANA explicitly makes it targetable.
  if ((bytes[0] & 0xe0) !== 0x20) return false;
  const specialIpv6Prefixes: Array<{ bytes: number[]; bits: number }> = [
    { bytes: [0x20, 0x01, 0x00, 0x00], bits: 23 }, // IETF protocol assignments
    { bytes: [0x20, 0x01, 0x0d, 0xb8], bits: 32 }, // documentation
    { bytes: [0x26, 0x20, 0x00, 0x4f, 0x80, 0x00], bits: 48 }, // AS112
    { bytes: [0x3f, 0xff, 0x00], bits: 20 }, // documentation
  ];
  return !specialIpv6Prefixes.some((range) => bytesMatchPrefix(bytes, range.bytes, range.bits));
}

function canonicalIpAddress(value: string): string | null {
  const host = normalizedHostname(value);
  const ipv4 = parseIpv4(host);
  if (ipv4) return ipv4.join('.');
  const ipv6 = parseIpv6(host);
  return ipv6 ? ipv6.map((word) => word.toString(16).padStart(4, '0')).join(':') : null;
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

function parseLimits(value: unknown, error: string, allowZero: boolean): DocumentExtractionLimits {
  if (!strictObject(value, ['source_bytes', 'extracted_text_bytes', 'extracted_text_characters'])) {
    throw new Error(error);
  }
  const entries = [value.source_bytes, value.extracted_text_bytes, value.extracted_text_characters];
  if (entries.some((entry) => !Number.isSafeInteger(entry) || (allowZero ? Number(entry) < 0 : Number(entry) <= 0))) {
    throw new Error(error);
  }
  return {
    source_bytes: value.source_bytes as number,
    extracted_text_bytes: value.extracted_text_bytes as number,
    extracted_text_characters: value.extracted_text_characters as number,
  };
}

function sameLimits(left: DocumentExtractionLimits, right: DocumentExtractionLimits): boolean {
  return left.source_bytes === right.source_bytes
    && left.extracted_text_bytes === right.extracted_text_bytes
    && left.extracted_text_characters === right.extracted_text_characters;
}

function parseFetchAudit(
  response: Response,
  requested: URL,
  maxRedirects: number,
  expectedLimits: DocumentExtractionLimits,
): DocumentFetchAudit {
  const encoded = response.headers.get('X-AIFeeds-Fetch-Audit') || '';
  if (!encoded || encoded.length > 8_192) throw new Error('unsafe_gateway_audit:missing');
  let raw: unknown;
  try { raw = JSON.parse(decodeURIComponent(encoded)); } catch { throw new Error('unsafe_gateway_audit:invalid_json'); }
  if (!strictObject(raw, [
    'hops', 'source_content_type', 'extraction', 'requested_limits', 'applied_limits',
    'actual_sizes', 'truncation', 'parser',
  ]) || !Array.isArray(raw.hops)) {
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
    const validated = canonicalIpAddress(value.validated_ip);
    const connected = canonicalIpAddress(value.connected_ip);
    if (!validated || !connected || !isPublicIpAddress(validated) || !isPublicIpAddress(connected) || validated !== connected) {
      throw new Error('unsafe_gateway_audit:peer_mismatch');
    }
    hops.push({ url, validated_ip: validated, connected_ip: connected });
  }
  if (hops[0].url !== requested.toString()) throw new Error('unsafe_gateway_audit:request_mismatch');
  if (typeof raw.source_content_type !== 'string' || !ALLOWED_SOURCE_TYPES.has(raw.source_content_type)) {
    throw new Error('unsafe_gateway_audit:content_type');
  }
  if (typeof raw.extraction !== 'string') throw new Error('unsafe_gateway_audit:extraction');
  if (raw.source_content_type === 'application/pdf' && raw.extraction !== 'pdf_text') {
    throw new Error('invalid_pdf_extraction');
  }
  if (!['html', 'text', 'json', 'pdf_text'].includes(raw.extraction)) {
    throw new Error('unsafe_gateway_audit:extraction');
  }
  const extraction = raw.extraction as PublicDocument['extraction'];
  const expectedExtraction: Record<string, PublicDocument['extraction']> = {
    'text/html': 'html', 'application/xhtml+xml': 'html', 'text/plain': 'text',
    'application/json': 'json', 'application/pdf': 'pdf_text',
  };
  if (expectedExtraction[raw.source_content_type] !== extraction) throw new Error('unsafe_gateway_audit:extraction_mismatch');
  const requestedLimits = parseLimits(raw.requested_limits, 'unsafe_gateway_audit:invalid_schema', false);
  const appliedLimits = parseLimits(raw.applied_limits, 'unsafe_gateway_audit:invalid_schema', false);
  const actualSizes = parseLimits(raw.actual_sizes, 'unsafe_gateway_audit:invalid_schema', true);
  if (!sameLimits(requestedLimits, expectedLimits)
    || appliedLimits.source_bytes > requestedLimits.source_bytes
    || appliedLimits.extracted_text_bytes > requestedLimits.extracted_text_bytes
    || appliedLimits.extracted_text_characters > requestedLimits.extracted_text_characters) {
    throw new Error('unsafe_gateway_audit:limit_mismatch');
  }
  if (actualSizes.source_bytes > appliedLimits.source_bytes
    || actualSizes.extracted_text_bytes > appliedLimits.extracted_text_bytes
    || actualSizes.extracted_text_characters > appliedLimits.extracted_text_characters) {
    throw new Error('unsafe_gateway_audit:actual_size');
  }
  if (!strictObject(raw.truncation, ['source', 'extracted_text'])
    || typeof raw.truncation.source !== 'boolean' || typeof raw.truncation.extracted_text !== 'boolean') {
    throw new Error('unsafe_gateway_audit:invalid_schema');
  }
  if (raw.truncation.source || raw.truncation.extracted_text) {
    throw new Error('unsafe_gateway_audit:truncated');
  }
  if (!strictObject(raw.parser, ['result', 'version'])
    || (raw.parser.result !== 'success' && raw.parser.result !== 'failed')
    || typeof raw.parser.version !== 'string'
    || !raw.parser.version.trim()
    || raw.parser.version.length > 120) {
    throw new Error('unsafe_gateway_audit:invalid_schema');
  }
  if (raw.parser.result !== 'success') throw new Error('unsafe_gateway_audit:parser_failed');
  return {
    hops,
    source_content_type: raw.source_content_type,
    extraction,
    requested_limits: requestedLimits,
    applied_limits: appliedLimits,
    actual_sizes: actualSizes,
    truncation: { source: raw.truncation.source, extracted_text: raw.truncation.extracted_text },
    parser: { result: 'success', version: raw.parser.version },
  };
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
    maxSourceBytes?: number;
    maxTextCharacters?: number;
    maxRedirects?: number;
  } = {},
): Promise<PublicDocument> {
  const target = validatePublicHttpUrl(input);
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxSourceBytes = deps.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const maxTextCharacters = deps.maxTextCharacters ?? DEFAULT_MAX_TEXT_CHARACTERS;
  const maxRedirects = deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const requestedLimits: DocumentExtractionLimits = {
    source_bytes: maxSourceBytes,
    extracted_text_bytes: maxBytes,
    extracted_text_characters: maxTextCharacters,
  };
  if (Object.values(requestedLimits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error('invalid_document_limits');
  }
  const { response, deadline, controller } = await postTrusted(
    deps.service, '/v1/document', {
      url: target.toString(), limits: requestedLimits, max_redirects: maxRedirects,
    }, timeoutMs,
  );
  try {
    const transportType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (transportType !== 'text/plain') throw new Error('invalid_gateway_content_type');
    const audit = parseFetchAudit(response, target, maxRedirects, requestedLimits);
    const body = await readBoundedBody(response, maxBytes, deadline, controller);
    const bodyCharacters = Array.from(body.text).length;
    if (audit.actual_sizes.extracted_text_bytes !== body.bytes
      || audit.actual_sizes.extracted_text_characters !== bodyCharacters) {
      throw new Error('unsafe_gateway_audit:body_size_mismatch');
    }
    return {
      url: audit.hops.at(-1)!.url,
      content_type: audit.source_content_type,
      extraction: audit.extraction,
      body: body.text,
      redirects: audit.hops.length - 1,
      bytes: body.bytes,
      fetch_audit: audit,
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
