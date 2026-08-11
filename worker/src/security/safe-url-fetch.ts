const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

const ALLOWED_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/json',
  'application/pdf',
]);

export type PublicHostResolver = (hostname: string) => Promise<string[]>;
export type PublicDocumentFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PublicDocument {
  url: string;
  content_type: string;
  body: string;
  redirects: number;
  bytes: number;
}

function unsafe(reason: string): Error {
  return new Error(`unsafe_url:${reason}`);
}

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
      (a === 203 && b === 0) ||
      a >= 224
    ) return false;
    return true;
  }
  if (!host.includes(':')) return false;
  const ipv6 = parseIpv6(host);
  if (!ipv6) return false;
  if (ipv6.every((part) => part === 0) || (ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1)) return false;
  if ((ipv6[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((ipv6[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((ipv6[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (ipv6[0] === 0x2001 && ipv6[1] === 0x0db8) return false; // documentation prefix
  const embeddedV4 = ipv6.slice(0, 5).every((part) => part === 0) && (ipv6[5] === 0 || ipv6[5] === 0xffff);
  if (embeddedV4) {
    return isPublicIpAddress(`${ipv6[6] >> 8}.${ipv6[6] & 255}.${ipv6[7] >> 8}.${ipv6[7] & 255}`);
  }
  return true;
}

export function validatePublicHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw unsafe('invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw unsafe('protocol');
  if (url.username || url.password) throw unsafe('credentials');
  if (url.port && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'))) {
    throw unsafe('port');
  }
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw unsafe('host');
  if (parseIpv4(hostname) || hostname.includes(':')) {
    if (!isPublicIpAddress(hostname)) throw unsafe('literal_address');
  }
  url.hostname = url.hostname.replace(/\.+$/, '');
  return url;
}

function normalizedAddressSet(addresses: readonly string[]): string[] {
  return [...new Set(addresses.map(normalizedHostname).filter(Boolean))].sort();
}

async function assertStablePublicResolution(hostname: string, resolver: PublicHostResolver): Promise<string[]> {
  const first = normalizedAddressSet(await resolver(hostname));
  if (!first.length || first.some((address) => !isPublicIpAddress(address))) {
    throw unsafe('unsafe_resolved_address');
  }
  const second = normalizedAddressSet(await resolver(hostname));
  if (!second.length || second.some((address) => !isPublicIpAddress(address))) {
    throw unsafe('unsafe_resolved_address');
  }
  if (first.length !== second.length || first.some((address, index) => address !== second[index])) {
    throw unsafe('dns_rebinding_detected');
  }
  return first;
}

export async function resolveHostWithCloudflareDns(
  hostname: string,
  fetcher: PublicDocumentFetcher = fetch,
): Promise<string[]> {
  const answers: string[] = [];
  for (const type of ['A', 'AAAA']) {
    const endpoint = new URL('https://cloudflare-dns.com/dns-query');
    endpoint.searchParams.set('name', hostname);
    endpoint.searchParams.set('type', type);
    const response = await fetcher(endpoint, {
      headers: { Accept: 'application/dns-json' },
      redirect: 'error',
    });
    if (!response.ok) continue;
    const payload = await response.json() as { Answer?: Array<{ data?: unknown }> };
    for (const answer of payload.Answer || []) {
      if (typeof answer.data === 'string' && (parseIpv4(answer.data) || answer.data.includes(':'))) {
        answers.push(answer.data);
      }
    }
  }
  return answers;
}

export async function fetchPublicDocument(
  input: string,
  deps: {
    resolveHost?: PublicHostResolver;
    fetcher?: PublicDocumentFetcher;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
  } = {},
): Promise<PublicDocument> {
  const fetcher = deps.fetcher ?? fetch;
  const resolveHost = deps.resolveHost ?? ((hostname) => resolveHostWithCloudflareDns(hostname, fetcher));
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = deps.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = validatePublicHttpUrl(input);
  let redirects = 0;

  while (true) {
    await assertStablePublicResolution(normalizedHostname(current.hostname), resolveHost);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetcher(current, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'text/html,application/xhtml+xml,text/plain,application/json,application/pdf;q=0.8',
          'User-Agent': 'ai-feeds-manual-news-lead/1.0',
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      if (redirects >= maxRedirects) throw unsafe('too_many_redirects');
      const location = response.headers.get('Location');
      if (!location) throw unsafe('redirect_without_location');
      current = validatePublicHttpUrl(new URL(location, current).toString());
      redirects += 1;
      continue;
    }
    if (!response.ok) throw new Error(`upstream_http_${response.status}`);
    const contentType = (response.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new Error('unsupported_content_type');
    const declaredLength = Number(response.headers.get('Content-Length') || 0);
    if (declaredLength > maxBytes) throw new Error('response_too_large');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > maxBytes) throw new Error('response_too_large');
    return {
      url: current.toString(),
      content_type: contentType,
      body: new TextDecoder().decode(bytes),
      redirects,
      bytes: bytes.byteLength,
    };
  }
}
