const STAGING_PAGES_HOSTNAME = "staging.ai-feeds.com";
const STAGING_WORKER_ORIGIN = "https://staging-api.ai-feeds.com";
const PRODUCTION_WORKER_ORIGIN = "https://api.ai-feeds.com";

const SEO_PROXY_ORIGINS = new Map<string, string>([
  [STAGING_PAGES_HOSTNAME, STAGING_WORKER_ORIGIN],
  ["xlist-dashboard.pages.dev", PRODUCTION_WORKER_ORIGIN],
  ["ai-feeds.com", PRODUCTION_WORKER_ORIGIN],
  ["www.ai-feeds.com", PRODUCTION_WORKER_ORIGIN],
]);

type Fetcher = (request: Request) => Promise<Response>;

function isSeoProxyPath(pathname: string): boolean {
  return pathname === "/daily" ||
    pathname.startsWith("/daily/") ||
    pathname.startsWith("/video/daily/") ||
    pathname === "/sitemap-daily.xml" ||
    pathname === "/video-sitemap.xml";
}

function seoProxyOrigin(request: Request): string | null {
  const url = new URL(request.url);
  if (!isSeoProxyPath(url.pathname)) return null;
  return SEO_PROXY_ORIGINS.get(url.hostname) ?? null;
}

function proxySeoRequestToOrigin(
  request: Request,
  origin: string,
  fetcher: Fetcher,
): Promise<Response> {
  const destination = new URL(request.url);
  destination.protocol = "https:";
  destination.host = new URL(origin).host;
  return fetcher(new Request(destination, request));
}

export function isSeoProxyRequest(request: Request): boolean {
  return seoProxyOrigin(request) !== null;
}

export function proxySeoRequest(
  request: Request,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  const origin = seoProxyOrigin(request);
  if (!origin) {
    throw new TypeError("request is not eligible for the SEO proxy");
  }
  return proxySeoRequestToOrigin(request, origin, fetcher);
}

export function maybeProxySeoRequest(
  request: Request,
  fetcher: Fetcher = fetch,
): Promise<Response | null> {
  if (!isSeoProxyRequest(request)) return Promise.resolve(null);
  return proxySeoRequest(request, fetcher);
}

export function isStagingSeoProxyRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.hostname === STAGING_PAGES_HOSTNAME && isSeoProxyPath(url.pathname);
}

export function proxyStagingSeoRequest(
  request: Request,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  return proxySeoRequestToOrigin(request, STAGING_WORKER_ORIGIN, fetcher);
}

export function maybeProxyStagingSeoRequest(
  request: Request,
  fetcher: Fetcher = fetch,
): Promise<Response | null> {
  if (!isStagingSeoProxyRequest(request)) return Promise.resolve(null);
  return proxyStagingSeoRequest(request, fetcher);
}
