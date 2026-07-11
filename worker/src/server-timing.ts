export type ServerTimingMetric = 'd1' | 'map' | 'json' | 'total';

export type ServerTimings = Partial<Record<ServerTimingMetric, number>>;

export type Clock = () => number;

const METRIC_ORDER: readonly ServerTimingMetric[] = ['d1', 'map', 'json', 'total'];
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function formatDuration(value: number): string {
  return value.toFixed(3).replace(/\.?(?:0+)$/, '');
}

export function formatServerTiming(timings: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const metric of METRIC_ORDER) {
    if (!Object.hasOwn(timings, metric)) continue;
    const value = timings[metric];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
    parts.push(`${metric};dur=${formatDuration(value)}`);
  }
  return parts.join(', ');
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

export function elapsed(start: number, end: number): number {
  const value = end - start;
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : 0;
}
