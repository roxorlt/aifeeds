// Shared crawler classification for browser telemetry and admin analytics.
// Keep browser automation (HeadlessChrome / Playwright) out of this list:
// approved performance probes are identified by explicit synthetic markers and
// must remain available in the admin synthetic cohort.

const ANALYTICS_CRAWLER_UA_RE = /bot|spider|crawler|meta-externalagent|facebookexternalhit|python-requests|python-urllib|curl\/|wget\/|go-http-client|okhttp/i;

export function isAnalyticsCrawlerUserAgent(ua: string): boolean {
  return !ua.trim() || ANALYTICS_CRAWLER_UA_RE.test(ua);
}

export function analyticsCrawlerUaSql(column: string = 'ua'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column)) {
    throw new Error('invalid analytics UA SQL column');
  }
  const ua = `lower(COALESCE(${column},''))`;
  return `(
    trim(${ua}) = ''
    OR ${ua} LIKE '%bot%'
    OR ${ua} LIKE '%spider%'
    OR ${ua} LIKE '%crawler%'
    OR ${ua} LIKE '%meta-externalagent%'
    OR ${ua} LIKE '%facebookexternalhit%'
    OR ${ua} LIKE '%python-requests%'
    OR ${ua} LIKE '%python-urllib%'
    OR ${ua} LIKE 'curl/%'
    OR ${ua} LIKE 'wget/%'
    OR ${ua} LIKE 'go-http-client%'
    OR ${ua} LIKE 'okhttp%'
  )`;
}

export function analyticsNonHumanUaSql(column: string = 'ua'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(column)) {
    throw new Error('invalid analytics UA SQL column');
  }
  const ua = `lower(COALESCE(${column},''))`;
  return `(
    ${analyticsCrawlerUaSql(column)}
    OR ${ua} LIKE '%headlesschrome%'
    OR ${ua} LIKE '%playwright%'
    OR ${ua} LIKE '%puppeteer%'
    OR ${ua} LIKE '%phantomjs%'
  )`;
}
