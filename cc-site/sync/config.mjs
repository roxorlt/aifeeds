const DEFAULTS = Object.freeze({
  baseUrl: 'https://api.ai-feeds.com',
  siteRoot: '/www/wwwroot/ai-feeds.cc',
  stateDir: '/var/lib/aifeeds-cc-sync',
  concurrency: 8,
  pageLimit: 200,
  requestTimeoutMs: 15_000,
});

function positiveInteger(value, fallback, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(String(value))) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} is out of range`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const secret = env.CC_SYNC_SECRET;
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('CC_SYNC_SECRET is required');
  }

  const rawBaseUrl = env.CC_SYNC_BASE_URL ?? DEFAULTS.baseUrl;
  let baseUrl;
  try {
    const parsed = new URL(rawBaseUrl);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) {
      throw new Error('unsupported URL');
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    baseUrl = parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error('CC_SYNC_BASE_URL must be a valid HTTP(S) URL');
  }

  return {
    baseUrl,
    secret,
    siteRoot: env.CC_SITE_ROOT ?? DEFAULTS.siteRoot,
    stateDir: env.CC_SYNC_STATE_DIR ?? DEFAULTS.stateDir,
    concurrency: positiveInteger(
      env.CC_SYNC_CONCURRENCY,
      DEFAULTS.concurrency,
      'CC_SYNC_CONCURRENCY',
      64,
    ),
    pageLimit: positiveInteger(
      env.CC_SYNC_PAGE_LIMIT,
      DEFAULTS.pageLimit,
      'CC_SYNC_PAGE_LIMIT',
      500,
    ),
    requestTimeoutMs: positiveInteger(
      env.CC_SYNC_REQUEST_TIMEOUT_MS,
      DEFAULTS.requestTimeoutMs,
      'CC_SYNC_REQUEST_TIMEOUT_MS',
      300_000,
    ),
  };
}

export { DEFAULTS };
