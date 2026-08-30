function compact(value: unknown, max: number): string {
  return Array.from(String(value || '').replace(/\s+/g, ' ').trim()).slice(0, max).join('');
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
  const httpStatus = raw.match(/\bhttp_([1-5]\d{2})\b/i);
  if (httpStatus) return `http_${httpStatus[1]}`;

  let message = raw.replace(/https?:\/\/\S+/gi, '[url]');
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join('[redacted]');
  }
  message = message.replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]');
  return compact(message, max) || 'unknown_error';
}
