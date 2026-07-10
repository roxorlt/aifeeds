type FeedResponseLike = { items?: unknown };

const HTML_PREFETCH_RESPONSES = new WeakSet<object>();

function isValidFeedResponse(value: unknown): value is FeedResponseLike & object {
  return typeof value === 'object' && value !== null && Array.isArray((value as FeedResponseLike).items);
}

export async function consumeFeedPrefetch<T extends FeedResponseLike & object>(
  prefetch: Promise<T | null>,
  fallback: () => Promise<T>,
  timeoutMs: number = 4_500,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
    });
    const candidate = await Promise.race([prefetch, timeout]);
    if (isValidFeedResponse(candidate)) {
      HTML_PREFETCH_RESPONSES.add(candidate);
      return candidate as T;
    }
  } catch {
    // Rejected prefetch is equivalent to a miss; the normal API path remains authoritative.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  return fallback();
}

export function feedResponseNetworkSource(response: object): 'html_prefetch' | 'network' {
  return HTML_PREFETCH_RESPONSES.has(response) ? 'html_prefetch' : 'network';
}
