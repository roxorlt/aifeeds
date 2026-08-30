const MAX_SAFE_ERROR_CODE_POINTS = 500;
const SECRET_MARKER = '\u0000';

function normalizeWhitespace(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function configuredSecrets(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
    .sort((left, right) => right.length - left.length || (left < right ? -1 : left > right ? 1 : 0));
}

function containsConfiguredSecret(value: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => value.includes(secret));
}

function safeStableCategory(candidates: readonly string[], secrets: readonly string[]): string {
  return candidates.find((candidate) => !containsConfiguredSecret(candidate, secrets)) || '';
}

// Delivery failures cross persistence, alerts, and the authenticated review API.
// Keep only stable diagnostics: raw HK HTTP bodies and credential-bearing URLs
// are never useful enough to justify retaining their contents.
export function safeDailyDeliveryError(
  error: unknown,
  secrets: readonly (string | null | undefined)[] = [],
  max = 500,
): string {
  const raw = error instanceof Error ? error.message : String(error);
  const exactSecrets = configuredSecrets(secrets);
  let sanitized = raw
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\bBearer\s+[^\s,;]+/gi, ' ');
  for (const secret of exactSecrets) {
    sanitized = sanitized.split(secret).join(SECRET_MARKER);
  }
  const maskedCategory = /(?:^|\s)[^\s:\u0000]*\u0000[^\s:]*\s*:/u.test(sanitized);
  sanitized = normalizeWhitespace(sanitized.split(SECRET_MARKER).join(' '));

  const httpStatus = sanitized.match(/\bhttp_([1-5]\d{2})\b/i);
  let output = sanitized;
  if (httpStatus) {
    const derived = `http_${httpStatus[1]}`;
    output = containsConfiguredSecret(derived, exactSecrets)
      ? safeStableCategory(['http_error', 'upstream_error', 'delivery_error'], exactSecrets)
      : derived;
  } else if (maskedCategory || /^(?::|http_\s*:)/i.test(sanitized)) {
    output = safeStableCategory(['http_error', 'upstream_error', 'delivery_error'], exactSecrets);
  } else if (!output) {
    output = safeStableCategory(['unknown_error', 'delivery_error', 'error'], exactSecrets);
  }

  const requestedMax = Number.isFinite(max) ? Math.floor(max) : MAX_SAFE_ERROR_CODE_POINTS;
  const boundedMax = Math.max(0, Math.min(MAX_SAFE_ERROR_CODE_POINTS, requestedMax));
  return Array.from(normalizeWhitespace(output)).slice(0, boundedMax).join('');
}
