const KEY_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const KEY_SECRET_RE = /^[a-f0-9]{64}$/;
const MAX_HISTORICAL_KEYS = 8;
const MAX_KEYRING_JSON_BYTES = 8 * 1024;

export interface ManualNewsKeyEntry {
  id: string;
  secret: string;
}

export interface ManualNewsKeyring {
  currentKeyId: string;
  keys: ReadonlyMap<string, string>;
}

function unavailable(code: string): never {
  throw new Error(code);
}

function exactKeyEntry(value: unknown): value is ManualNewsKeyEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('id') || !keys.includes('secret')) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string' && KEY_ID_RE.test(entry.id)
    && typeof entry.secret === 'string' && KEY_SECRET_RE.test(entry.secret);
}

export function parseManualNewsKeyring(
  input: { keyId: unknown; secret: unknown; keyringJson?: unknown },
  errorCode = 'manual_news_keys_unavailable',
): ManualNewsKeyring {
  if (typeof input.keyId !== 'string' || !KEY_ID_RE.test(input.keyId)
    || typeof input.secret !== 'string' || !KEY_SECRET_RE.test(input.secret)) {
    return unavailable(errorCode);
  }
  let historical: unknown[] = [];
  if (input.keyringJson !== undefined && input.keyringJson !== null && input.keyringJson !== '') {
    if (typeof input.keyringJson !== 'string'
      || new TextEncoder().encode(input.keyringJson).byteLength > MAX_KEYRING_JSON_BYTES) {
      return unavailable(errorCode);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(input.keyringJson); } catch { return unavailable(errorCode); }
    if (!Array.isArray(parsed) || parsed.length > MAX_HISTORICAL_KEYS) return unavailable(errorCode);
    historical = parsed;
  }
  const entries: ManualNewsKeyEntry[] = [{ id: input.keyId, secret: input.secret }];
  for (const value of historical) {
    if (!exactKeyEntry(value)) return unavailable(errorCode);
    entries.push(value);
  }
  const ids = new Set<string>();
  const secrets = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id) || secrets.has(entry.secret)) return unavailable(errorCode);
    ids.add(entry.id);
    secrets.add(entry.secret);
  }
  return {
    currentKeyId: input.keyId,
    keys: new Map(entries.map((entry) => [entry.id, entry.secret])),
  };
}

export function manualNewsResponseKeyring(env: {
  MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID?: string;
  MANUAL_NEWS_RESEARCH_RESPONSE_SECRET?: string;
  MANUAL_NEWS_RESEARCH_RESPONSE_KEYRING_JSON?: string;
}): ManualNewsKeyring {
  return parseManualNewsKeyring({
    keyId: env.MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID,
    secret: env.MANUAL_NEWS_RESEARCH_RESPONSE_SECRET,
    keyringJson: env.MANUAL_NEWS_RESEARCH_RESPONSE_KEYRING_JSON,
  }, 'manual_news_response_keys_unavailable');
}

export function manualNewsVerificationKeyring(env: {
  MANUAL_NEWS_VERIFICATION_KEY_ID?: string;
  MANUAL_NEWS_VERIFICATION_SECRET?: string;
  MANUAL_NEWS_VERIFICATION_KEYRING_JSON?: string;
}): ManualNewsKeyring {
  return parseManualNewsKeyring({
    keyId: env.MANUAL_NEWS_VERIFICATION_KEY_ID,
    secret: env.MANUAL_NEWS_VERIFICATION_SECRET,
    keyringJson: env.MANUAL_NEWS_VERIFICATION_KEYRING_JSON,
  }, 'manual_news_verification_keys_unavailable');
}
