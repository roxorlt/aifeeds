type FeedResponseLike = { items?: unknown };

export type CancellableFeedPrefetch<T> = {
  promise: Promise<T | null>;
  cancel: () => Promise<void>;
};

function isCancellableFeedPrefetch<T>(
  value: Promise<T | null> | CancellableFeedPrefetch<T>,
): value is CancellableFeedPrefetch<T> {
  return "promise" in value;
}

const HTML_PREFETCH_RESPONSES = new WeakSet<object>();

function isValidFeedResponse(value: unknown): value is FeedResponseLike & object {
  return typeof value === 'object' && value !== null && Array.isArray((value as FeedResponseLike).items);
}

export async function consumeFeedPrefetch<T extends FeedResponseLike & object>(
  prefetchInput: Promise<T | null> | CancellableFeedPrefetch<T>,
  fallback: () => Promise<T>,
  timeoutMs: number = 4_500,
): Promise<T> {
  let cancellable: CancellableFeedPrefetch<T> | null;
  let prefetch: Promise<T | null>;
  if (isCancellableFeedPrefetch(prefetchInput)) {
    cancellable = prefetchInput;
    prefetch = prefetchInput.promise;
  } else {
    cancellable = null;
    prefetch = prefetchInput;
  }
  const timeoutMarker = Symbol("html-feed-prefetch-timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const timeout = new Promise<typeof timeoutMarker>((resolve) => {
      timer = setTimeout(() => resolve(timeoutMarker), Math.max(0, timeoutMs));
    });
    const candidate = await Promise.race([prefetch, timeout]);
    if (candidate === timeoutMarker) {
      timedOut = true;
    }
    if (isValidFeedResponse(candidate)) {
      HTML_PREFETCH_RESPONSES.add(candidate);
      return candidate as T;
    }
  } catch {
    // Rejected prefetch is equivalent to a miss; the normal API path remains authoritative.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  if (timedOut && cancellable) {
    // Abort is an internal optimization hand-off, not an API failure. Await the
    // raw request's absorbed settlement before starting the identical fallback,
    // so the browser never has two normalized list requests in flight together.
    try {
      await cancellable.cancel();
    } catch {
      // The original promise below remains the settlement source of truth.
    }
    await prefetch.then(
      () => undefined,
      () => undefined,
    );
  }
  return fallback();
}

export function feedResponseNetworkSource(response: object): 'html_prefetch' | 'network' {
  return HTML_PREFETCH_RESPONSES.has(response) ? 'html_prefetch' : 'network';
}
