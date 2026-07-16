export type ServerTimingMetric = 'd1' | 'thread_d1';

export type ServerTimings = Partial<Record<ServerTimingMetric, number>>;

const METRIC_ORDER: readonly ServerTimingMetric[] = ['d1', 'thread_d1'];
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function normalizeDuration(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Number(value.toFixed(3));
}

function formatDuration(value: number): string {
  return value.toFixed(3).replace(/\.?(?:0+)$/, '');
}

export function formatServerTiming(timings: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const metric of METRIC_ORDER) {
    if (!Object.hasOwn(timings, metric)) continue;
    const value = normalizeDuration(timings[metric]);
    if (value === null) continue;
    parts.push(`${metric};dur=${formatDuration(value)}`);
  }
  return parts.join(', ');
}

export function d1DurationMs(result: unknown): number {
  if (!result || typeof result !== 'object') return 0;
  const meta = (result as Record<string, unknown>).meta;
  if (!meta || typeof meta !== 'object') return 0;
  const metaRecord = meta as Record<string, unknown>;
  const timings = metaRecord.timings;
  if (timings && typeof timings === 'object') {
    const precise = normalizeDuration(
      (timings as Record<string, unknown>).sql_duration_ms,
    );
    if (precise !== null) return precise;
  }
  return normalizeDuration(metaRecord.duration) ?? 0;
}

export function isValidRequestId(value: string | null | undefined): value is string {
  return typeof value === 'string' && REQUEST_ID_RE.test(value);
}

export function resolveRequestId(
  incoming: string | null | undefined,
  generate: () => string = () => crypto.randomUUID(),
): string {
  if (isValidRequestId(incoming)) return incoming;
  const generated = generate();
  if (isValidRequestId(generated)) return generated;
  return crypto.randomUUID();
}
