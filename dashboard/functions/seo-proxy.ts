const STAGING_PAGES_HOSTNAME = "staging.ai-feeds.com";
const STAGING_WORKER_ORIGIN = "https://staging-api.ai-feeds.com";

type Fetcher = (request: Request) => Promise<Response>;

function isSeoProxyPath(pathname: string): boolean {
  return pathname === "/daily" ||
    pathname.startsWith("/daily/") ||
    pathname.startsWith("/video/daily/") ||
    pathname === "/sitemap-daily.xml" ||
    pathname === "/video-sitemap.xml";
}

export function isStagingSeoProxyRequest(request: Request): boolean {
  const url = new URL(request.url);
  return url.hostname === STAGING_PAGES_HOSTNAME && isSeoProxyPath(url.pathname);
}

export function proxyStagingSeoRequest(
  request: Request,
  fetcher: Fetcher = fetch,
): Promise<Response> {
  const destination = new URL(request.url);
  destination.protocol = "https:";
  destination.host = new URL(STAGING_WORKER_ORIGIN).host;
  return fetcher(new Request(destination, request));
}

export function maybeProxyStagingSeoRequest(
  request: Request,
  fetcher: Fetcher = fetch,
): Promise<Response | null> {
  if (!isStagingSeoProxyRequest(request)) return Promise.resolve(null);
  return proxyStagingSeoRequest(request, fetcher);
}
