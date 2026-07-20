import path from 'node:path';

const DEFAULTS = Object.freeze({
  baseUrl: 'https://api.ai-feeds.com',
  siteRoot: '/www/wwwroot/ai-feeds.cc',
  stateDir: '/var/lib/aifeeds-cc-sync',
  concurrency: 8,
  pageLimit: 200,
  requestTimeoutMs: 15_000,
});

function canonicalAbsolutePath(value, name) {
  if (
    typeof value !== 'string'
    || !path.isAbsolute(value)
    || value !== path.resolve(value)
    || value === path.parse(value).root
  ) {
    throw new Error(`${name} must be a canonical absolute non-root path`);
  }
  return value;
}

function isLoopback(hostname) {
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost'
    || normalized === '[::1]'
    || normalized === '::1'
  ) {
    return true;
  }
  const match = /^127\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(
    normalized,
  );
  return Boolean(
    match
    && match.slice(1).every((part) => Number(part) <= 255),
  );
}

function canonicalBaseUrl(rawBaseUrl, allowInsecureLocalhost) {
  try {
    const parsed = new URL(rawBaseUrl);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || parsed.pathname !== '/'
      || (
        parsed.protocol !== 'https:'
        && !(allowInsecureLocalhost && isLoopback(parsed.hostname))
      )
    ) {
      throw new Error('unsupported URL');
    }
    return parsed.origin;
  } catch {
    throw new Error(
      'CC_SYNC_BASE_URL must be an origin-only HTTPS URL'
        + ' (HTTP is test-only for explicitly enabled loopback)',
    );
  }
}

export function assertSecureConfig(config) {
  const baseUrl = canonicalBaseUrl(
    config?.baseUrl,
    config?.allowInsecureLocalhost === true,
  );
  if (baseUrl !== config.baseUrl) {
    throw new Error('CC_SYNC_BASE_URL must use its canonical origin form');
  }
  canonicalAbsolutePath(config.siteRoot, 'CC_SITE_ROOT');
  canonicalAbsolutePath(config.stateDir, 'CC_SYNC_STATE_DIR');
}

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
  const allowInsecureLocalhost = (
    env.CC_SYNC_ALLOW_INSECURE_LOCALHOST === '1'
  );
  const baseUrl = canonicalBaseUrl(rawBaseUrl, allowInsecureLocalhost);

  return {
    baseUrl,
    secret,
    siteRoot: canonicalAbsolutePath(
      env.CC_SITE_ROOT ?? DEFAULTS.siteRoot,
      'CC_SITE_ROOT',
    ),
    stateDir: canonicalAbsolutePath(
      env.CC_SYNC_STATE_DIR ?? DEFAULTS.stateDir,
      'CC_SYNC_STATE_DIR',
    ),
    allowInsecureLocalhost,
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
