import { parseManualNewsKeyring } from './manual-news-keyring';

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_TEXT_CHARACTERS = 1_000_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_SEARCH_MAX_BYTES = 256 * 1024;
const ARTICLE_TEXT_MAX_BYTES = 28_000;
const ARTICLE_TEXT_MAX_CHARACTERS = 28_000;
const ARTICLE_TEXT_PROTOCOL_V2 = 'article_text_v2';
const PROOF_EXCERPT_RESPONSE_PROFILE = 'proof_excerpt_v1';
const PROOF_EXCERPT_RESPONSE_HMAC_CONTRACT = 'hmac-sha256-canonical-json-all-fields-except-response_hmac-v1';
const PROOF_EXCERPT_CONTRACT = 'proof_excerpt_v1';
const PROOF_EXCERPT_ALGORITHM = 'utf8-nfc-ws1-codepoint-prefix-v1';
const PROOF_EXCERPT_MAX_CODE_POINTS = 3_000;
const PROOF_EXCERPT_MAX_UTF8_BYTES = 12_000;
const ARTICLE_TEXT_V2_MAX_SKEW_MS = 5 * 60_000;
const ARTICLE_TEXT_V2_MAX_FUTURE_MS = 30_000;
const ARTICLE_TEXT_V2_MIN_CHROMIUM_MAJOR = 149;

const ALLOWED_SOURCE_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'text/plain', 'application/json', 'application/pdf',
]);

export type TrustedGatewayFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface TrustedResearchService {
  /** Exact HTTPS origin of the peer-pinning research gateway. Paths, query, and fragments are forbidden. */
  origin: string;
  /** Server-side token. It is never returned to or accepted from browser/user input. */
  token: string;
  /** Independent 32-byte hex key used only to authenticate document responses. */
  responseSecret?: string;
  /** Explicit ID for the current response key plus optional retained historical keys. */
  responseKeyId?: string;
  responseKeyringJson?: string;
  fetcher?: TrustedGatewayFetcher;
  /** Test seams; production callers leave these unset. */
  protocolNow?: () => number;
  nonceFactory?: () => string;
}

export interface PublicDocument {
  url: string;
  content_type: string;
  extraction: 'html' | 'article_text' | 'text' | 'json' | 'pdf_text';
  excerpt: string;
  redirects: number;
  fetch_audit: DocumentFetchAudit;
  response_key_id: string;
  title?: string;
  published_at?: string | null;
  selection?: 'article' | 'main';
  content_complete?: true;
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
  document?: {
    title: string;
    published_at: string | null;
    selection: 'article' | 'main';
    content_complete: true;
  };
  protocol_version?: 'article_text_v2';
  request_nonce?: string;
  request_timestamp?: string;
  extracted_at?: string;
  final_url?: string;
  body_sha256?: string;
  response_profile?: 'proof_excerpt_v1';
  response_hmac_contract?: 'hmac-sha256-canonical-json-all-fields-except-response_hmac-v1';
  proof_excerpt?: {
    contract: 'proof_excerpt_v1';
    algorithm: 'utf8-nfc-ws1-codepoint-prefix-v1';
    max_code_points: 3000;
    sha256: string;
    utf8_bytes: number;
    code_points: number;
  };
  response_hmac?: string;
}

const PROOF_EXCERPT_WHITESPACE =
  /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu;

export function deriveManualNewsProofExcerpt(value: string): string {
  const normalized = value.normalize('NFC')
    .replace(PROOF_EXCERPT_WHITESPACE, ' ')
    .replace(/^ +| +$/gu, '');
  return Array.from(normalized).slice(0, PROOF_EXCERPT_MAX_CODE_POINTS).join('').replace(/ +$/gu, '');
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
  return {
    url: new URL(path, origin), fetcher: service.fetcher, token: service.token,
    responseSecret: service.responseSecret,
    protocolNow: service.protocolNow,
    nonceFactory: service.nonceFactory,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function canonicalIsoTimestamp(value: unknown): { value: string; timestamp: number } | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  return normalized === value ? { value: normalized, timestamp } : null;
}

function randomRequestNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validRequestNonce(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[a-f0-9]{32,128}|[A-Za-z0-9_-]{22,171})$/.test(value);
}

function hexBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  return bytes;
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) mismatch |= (left[index] || 0) ^ (right[index] || 0);
  return mismatch === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyResponseHmac(secret: string, unsigned: Record<string, unknown>, supplied: string): Promise<boolean> {
  const key = await crypto.subtle.importKey('raw', hexBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalJson(unsigned))));
  return constantTimeBytesEqual(signature, hexBytes(supplied));
}

export async function verifyDocumentFetchAuditResponseHmac(
  audit: DocumentFetchAudit,
  responseSecret: string,
): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(responseSecret)
    || !/^[a-f0-9]{64}$/.test(audit.response_hmac || '')) return false;
  const { response_hmac: suppliedHmac, ...unsignedAudit } = audit;
  return verifyResponseHmac(responseSecret, unsignedAudit, suppliedHmac!);
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
  protocol: { nonce: string; requestTimestamp: string; now: number },
): DocumentFetchAudit {
  const encoded = response.headers.get('X-AIFeeds-Fetch-Audit') || '';
  if (!encoded || encoded.length > 8_192) throw new Error('unsafe_gateway_audit:missing');
  let raw: unknown;
  try { raw = JSON.parse(decodeURIComponent(encoded)); } catch { throw new Error('unsafe_gateway_audit:invalid_json'); }
  const auditKeys = [
    'hops', 'source_content_type', 'extraction', 'requested_limits', 'applied_limits',
    'actual_sizes', 'truncation', 'parser', 'protocol_version', 'request_nonce',
    'request_timestamp', 'extracted_at', 'final_url', 'body_sha256', 'response_profile',
    'response_hmac_contract', 'proof_excerpt', 'response_hmac',
  ];
  if ((raw as { extraction?: unknown })?.extraction === 'article_text') auditKeys.push('document');
  if (!strictObject(raw, auditKeys) || !Array.isArray(raw.hops)) {
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
  const requestTimestamp = canonicalIsoTimestamp(raw.request_timestamp);
  const extractedAt = canonicalIsoTimestamp(raw.extracted_at);
  if (raw.protocol_version !== ARTICLE_TEXT_PROTOCOL_V2
    || raw.request_nonce !== protocol.nonce
    || raw.request_timestamp !== protocol.requestTimestamp
    || !requestTimestamp || !extractedAt
    || extractedAt.timestamp < requestTimestamp.timestamp - ARTICLE_TEXT_V2_MAX_FUTURE_MS
    || extractedAt.timestamp > protocol.now + ARTICLE_TEXT_V2_MAX_FUTURE_MS
    || protocol.now - extractedAt.timestamp > ARTICLE_TEXT_V2_MAX_SKEW_MS
    || typeof raw.body_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.body_sha256)
    || typeof raw.response_hmac !== 'string' || !/^[a-f0-9]{64}$/.test(raw.response_hmac)) {
    throw new Error('unsafe_gateway_audit:protocol');
  }
  if (raw.response_profile !== PROOF_EXCERPT_RESPONSE_PROFILE
    || raw.response_hmac_contract !== PROOF_EXCERPT_RESPONSE_HMAC_CONTRACT
    || !strictObject(raw.proof_excerpt, [
      'contract', 'algorithm', 'max_code_points', 'sha256', 'utf8_bytes', 'code_points',
    ])
    || raw.proof_excerpt.contract !== PROOF_EXCERPT_CONTRACT
    || raw.proof_excerpt.algorithm !== PROOF_EXCERPT_ALGORITHM
    || raw.proof_excerpt.max_code_points !== PROOF_EXCERPT_MAX_CODE_POINTS
    || typeof raw.proof_excerpt.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(raw.proof_excerpt.sha256)
    || !Number.isSafeInteger(raw.proof_excerpt.utf8_bytes)
    || Number(raw.proof_excerpt.utf8_bytes) < 0
    || Number(raw.proof_excerpt.utf8_bytes) > PROOF_EXCERPT_MAX_UTF8_BYTES
    || !Number.isSafeInteger(raw.proof_excerpt.code_points)
    || Number(raw.proof_excerpt.code_points) < 0
    || Number(raw.proof_excerpt.code_points) > PROOF_EXCERPT_MAX_CODE_POINTS) {
    throw new Error('unsafe_gateway_audit:proof_excerpt');
  }
  if (typeof raw.source_content_type !== 'string' || !ALLOWED_SOURCE_TYPES.has(raw.source_content_type)) {
    throw new Error('unsafe_gateway_audit:content_type');
  }
  if (typeof raw.extraction !== 'string') throw new Error('unsafe_gateway_audit:extraction');
  if (raw.source_content_type === 'application/pdf' && raw.extraction !== 'pdf_text') {
    throw new Error('invalid_pdf_extraction');
  }
  if (!['article_text', 'text', 'json', 'pdf_text'].includes(raw.extraction)) {
    throw new Error('unsafe_gateway_audit:extraction');
  }
  const extraction = raw.extraction as PublicDocument['extraction'];
  const expectedExtraction: Record<string, PublicDocument['extraction']> = {
    'text/html': 'article_text', 'application/xhtml+xml': 'article_text', 'text/plain': 'text',
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
  let documentMetadata: DocumentFetchAudit['document'];
  if (extraction === 'article_text') {
    if (!strictObject(raw.document, ['title', 'published_at', 'selection', 'content_complete'])
      || typeof raw.document.title !== 'string' || raw.document.title !== raw.document.title.trim()
      || !raw.document.title || Array.from(raw.document.title).length > 220
      || new TextEncoder().encode(raw.document.title).byteLength > 1_024
      || !['article', 'main'].includes(String(raw.document.selection))
      || raw.document.content_complete !== true
      || !/^chromium\/\d+\.\d+\.\d+\.\d+$/.test(raw.parser.version)
      || appliedLimits.extracted_text_bytes > ARTICLE_TEXT_MAX_BYTES
      || appliedLimits.extracted_text_characters > ARTICLE_TEXT_MAX_CHARACTERS) {
      throw new Error('unsafe_gateway_audit:article_metadata');
    }
    const chromiumMajor = Number(/^chromium\/(\d+)/.exec(raw.parser.version)?.[1] || 0);
    if (chromiumMajor < ARTICLE_TEXT_V2_MIN_CHROMIUM_MAJOR) {
      throw new Error('unsafe_gateway_audit:chromium_version');
    }
    const publishedAt = normalizedPublishedAt(raw.document.published_at);
    if (publishedAt === undefined || publishedAt !== raw.document.published_at) {
      throw new Error('unsafe_gateway_audit:article_metadata');
    }
    documentMetadata = {
      title: raw.document.title,
      published_at: publishedAt,
      selection: raw.document.selection as 'article' | 'main',
      content_complete: true,
    };
  }
  let finalUrl: string;
  try { finalUrl = validatePublicHttpUrl(String(raw.final_url)).toString(); } catch {
    throw new Error('unsafe_gateway_audit:final_url');
  }
  if (finalUrl !== hops.at(-1)!.url) throw new Error('unsafe_gateway_audit:final_url');
  return {
    hops,
    source_content_type: raw.source_content_type,
    extraction,
    requested_limits: requestedLimits,
    applied_limits: appliedLimits,
    actual_sizes: actualSizes,
    truncation: { source: raw.truncation.source, extracted_text: raw.truncation.extracted_text },
    parser: { result: 'success', version: raw.parser.version },
    ...(documentMetadata ? { document: documentMetadata } : {}),
    protocol_version: ARTICLE_TEXT_PROTOCOL_V2,
    request_nonce: protocol.nonce,
    request_timestamp: protocol.requestTimestamp,
    extracted_at: extractedAt.value,
    final_url: finalUrl,
    body_sha256: raw.body_sha256,
    response_profile: PROOF_EXCERPT_RESPONSE_PROFILE,
    response_hmac_contract: PROOF_EXCERPT_RESPONSE_HMAC_CONTRACT,
    proof_excerpt: {
      contract: PROOF_EXCERPT_CONTRACT,
      algorithm: PROOF_EXCERPT_ALGORITHM,
      max_code_points: PROOF_EXCERPT_MAX_CODE_POINTS,
      sha256: raw.proof_excerpt.sha256,
      utf8_bytes: Number(raw.proof_excerpt.utf8_bytes),
      code_points: Number(raw.proof_excerpt.code_points),
    },
    response_hmac: raw.response_hmac,
  };
}

export function validateCompleteArticleText(value: string, bytes: number): void {
  const characters = Array.from(value);
  if (!characters.length) throw new Error('unsafe_gateway_article_text:empty');
  if (bytes > ARTICLE_TEXT_MAX_BYTES || characters.length > ARTICLE_TEXT_MAX_CHARACTERS) {
    throw new Error('unsafe_gateway_article_text:too_large');
  }
  let allowedIgnorables = 0;
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character === '\ufeff') continue;
    if (!/\p{Default_Ignorable_Code_Point}/u.test(character)) continue;
    const previous = characters[index - 1] || '';
    const next = characters[index + 1] || '';
    const contextualJoiner = character === '\u200d'
      && ((/[\p{L}\p{M}]/u.test(previous) && /[\p{L}\p{M}]/u.test(next))
        || (/\p{Extended_Pictographic}/u.test(previous) && /\p{Extended_Pictographic}/u.test(next)));
    const contextualNonJoiner = character === '\u200c'
      && /[\p{L}\p{M}]/u.test(previous) && /[\p{L}\p{M}]/u.test(next);
    const contextualVariation = /^[\ufe00-\ufe0f]$/u.test(character)
      && /\p{Extended_Pictographic}/u.test(previous);
    if (!contextualJoiner && !contextualNonJoiner && !contextualVariation) {
      throw new Error('unsafe_gateway_article_text:unsafe_unicode');
    }
    allowedIgnorables += 1;
  }
  if (allowedIgnorables > 8 && allowedIgnorables / characters.length > 0.02) {
    throw new Error('unsafe_gateway_article_text:unsafe_unicode');
  }
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
  // Preserve a decoded U+FEFF so the frozen proof-excerpt whitespace contract,
  // signed code-point count, and body digest all see the same complete text.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
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
  const init: RequestInit = {
    method: 'POST', redirect: 'manual', signal: controller.signal,
    headers: {
      Accept: path === '/v1/search' ? 'application/json' : 'text/plain',
      Authorization: `Bearer ${endpoint.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'ai-feeds-manual-news-lead/2.0',
    },
    body: JSON.stringify(payload),
  };
  const injectedFetcher = endpoint.fetcher;
  const pending = injectedFetcher ? injectedFetcher(endpoint.url, init) : fetch(endpoint.url, init);
  const response = await withinDeadline(pending, deadline, controller);
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
  // Preserve the base trusted-origin dependency/error contract before applying
  // the v2-only response-authentication dependency.
  trustedEndpoint(deps.service, '/v1/document');
  const responseKeys = parseManualNewsKeyring({
    keyId: deps.service?.responseKeyId,
    secret: deps.service?.responseSecret,
    keyringJson: deps.service?.responseKeyringJson,
  }, 'trusted_research_response_keys_unavailable');
  const protocolNow = deps.service?.protocolNow || Date.now;
  const requestNow = protocolNow();
  if (!Number.isFinite(requestNow)) throw new Error('invalid_trusted_research_clock');
  const requestNonce = (deps.service?.nonceFactory || randomRequestNonce)();
  if (!validRequestNonce(requestNonce)) throw new Error('invalid_trusted_research_nonce');
  const requestTimestamp = new Date(requestNow).toISOString();
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
      extraction_mode: ARTICLE_TEXT_PROTOCOL_V2,
      response_profile: PROOF_EXCERPT_RESPONSE_PROFILE,
      request_nonce: requestNonce,
      request_timestamp: requestTimestamp,
    }, timeoutMs,
  );
  try {
    const transportType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (transportType !== 'text/plain') throw new Error('invalid_gateway_content_type');
    const audit = parseFetchAudit(response, target, maxRedirects, requestedLimits, {
      nonce: requestNonce,
      requestTimestamp,
      now: protocolNow(),
    });
    const body = await readBoundedBody(response, maxBytes, deadline, controller);
    let responseKeyId: string | null = null;
    for (const [keyId, secret] of responseKeys.keys) {
      if (await verifyDocumentFetchAuditResponseHmac(audit, secret)) {
        responseKeyId = keyId;
        break;
      }
    }
    if (!responseKeyId) {
      throw new Error('unsafe_gateway_audit:response_hmac');
    }
    const bodyCharacters = Array.from(body.text).length;
    if (audit.actual_sizes.extracted_text_bytes !== body.bytes
      || audit.actual_sizes.extracted_text_characters !== bodyCharacters) {
      throw new Error('unsafe_gateway_audit:body_size_mismatch');
    }
    if (await sha256Hex(body.text) !== audit.body_sha256) {
      throw new Error('unsafe_gateway_audit:body_digest');
    }
    if (audit.extraction === 'article_text') validateCompleteArticleText(body.text, body.bytes);
    const excerpt = deriveManualNewsProofExcerpt(body.text);
    body.text = '';
    const excerptBytes = new TextEncoder().encode(excerpt).byteLength;
    const excerptCodePoints = Array.from(excerpt).length;
    if (await sha256Hex(excerpt) !== audit.proof_excerpt!.sha256
      || excerptBytes !== audit.proof_excerpt!.utf8_bytes
      || excerptCodePoints !== audit.proof_excerpt!.code_points) {
      throw new Error('unsafe_gateway_audit:proof_excerpt');
    }
    return {
      url: audit.hops.at(-1)!.url,
      content_type: audit.source_content_type,
      extraction: audit.extraction,
      excerpt,
      redirects: audit.hops.length - 1,
      fetch_audit: audit,
      response_key_id: responseKeyId,
      ...(audit.document ? {
        title: audit.document.title,
        published_at: audit.document.published_at,
        selection: audit.document.selection,
        content_complete: true as const,
      } : {}),
    };
  } finally {
    controller.abort();
  }
}

function normalizedPublishedAt(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? value : undefined;
  }
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
