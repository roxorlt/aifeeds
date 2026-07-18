const STATIC_PAGE_PATHS = new Set([
  '/',
  '/search',
  '/settings',
  '/settings/account',
  '/feedback',
  '/subscribe',
  '/me/subscription',
  '/daily',
  '/privacy',
  '/terms',
]);

const SEARCH_REFERRER_HOSTS = [
  'google.com',
  'google.cn',
  'google.co.uk',
  'bing.com',
  'baidu.com',
  'baidu.cn',
  'so.com',
  'sogou.com',
  'duckduckgo.com',
];

const SOCIAL_REFERRER_HOSTS = [
  'x.com',
  'twitter.com',
  't.co',
  'weixin.qq.com',
  'mp.weixin.qq.com',
  'facebook.com',
  'linkedin.com',
];

function parseUrl(raw: string): URL | null {
  const value = raw.trim().slice(0, 2048);
  if (!value) return null;
  try {
    return new URL(value, 'https://telemetry.invalid');
  } catch {
    return null;
  }
}

function isHostOrSubdomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * Convert a possibly user-bearing URL into a finite route template. Query strings,
 * fragments, share tokens, repository names and content identifiers never leave the
 * browser as telemetry dimensions.
 */
export function sanitizePagePath(raw: string): string {
  const url = parseUrl(raw);
  if (!url) return '/:other';

  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (STATIC_PAGE_PATHS.has(pathname)) return pathname;

  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 2 && ['t', 'c', 'h', 'e', 'o', 'y', 's'].includes(parts[0])) {
    return parts[0] === 's' ? '/s/:token' : `/${parts[0]}/:id`;
  }
  if (parts.length === 3 && parts[0] === 'g') return '/g/:owner/:repo';
  if (parts.length === 3 && parts[0] === 'ph') return '/ph/:slug/:date';
  if (parts.length === 2 && parts[0] === 'daily') return '/daily/:page';

  return '/:other';
}

/** Keep API diagnostics useful without retaining cursor, query, token or item ids. */
export function safeApiEndpoint(raw: string): string {
  const url = parseUrl(raw);
  if (!url) return 'other_api';
  const parts = url.pathname.split('/').filter(Boolean);
  const apiIndex = parts.indexOf('api');
  const route = apiIndex >= 0 ? parts.slice(apiIndex + 1) : parts;
  const root = route[0] ?? '';

  if (root === 'items') return route.length > 1 ? 'item_detail' : 'items';
  if (root === 'feed-manifest' || root === 'feed_manifest') return 'feed_manifest';
  if (root === 'sources') return 'sources';
  if (root === 'stats') return 'stats';
  if (root === 'search') return 'search';
  if (root === 'auth') return 'auth';
  if (root === 'favorites') return 'favorites';
  if (root === 'subscriptions') return 'subscriptions';
  if (root === 'feedback') return 'feedback';
  if (root === 'share') return 'share';
  if (root === 'refresh') return 'refresh';
  if (root === 'track') return 'track';
  return 'other_api';
}

export type ReferrerCategory = 'direct' | 'same_origin' | 'search' | 'social' | 'external';

/** Reduce document.referrer to a non-identifying acquisition category. */
export function classifyReferrer(raw: string, pageOrigin?: string): ReferrerCategory {
  if (!raw.trim()) return 'direct';
  const referrer = parseUrl(raw);
  if (!referrer) return 'external';

  if (pageOrigin) {
    try {
      if (referrer.origin === new URL(pageOrigin).origin) return 'same_origin';
    } catch {
      // An invalid page origin cannot make an untrusted referrer safe.
    }
  }

  const hostname = referrer.hostname.toLowerCase();
  if (SEARCH_REFERRER_HOSTS.some((host) => isHostOrSubdomain(hostname, host))) {
    return 'search';
  }
  if (SOCIAL_REFERRER_HOSTS.some((host) => isHostOrSubdomain(hostname, host))) {
    return 'social';
  }
  return 'external';
}

const ATTRIBUTION_SOURCES = new Set([
  'newsletter',
  'email',
  'search',
  'social',
  'github',
  'product_hunt',
  'direct',
]);

/** Only explicitly supported campaign source labels are accepted. */
export function safeAttributionSource(raw: string | null | undefined): string | undefined {
  const normalized = raw?.trim().toLowerCase().replace(/[\s-]+/g, '_') ?? '';
  if (!normalized) return undefined;
  return ATTRIBUTION_SOURCES.has(normalized) ? normalized : 'other';
}
