export type RequestPurpose = "critical" | "background";
export type RequestPurposeSource = RequestPurpose | (() => RequestPurpose);

export type ItemsPathQuery = {
  source_type?: string | readonly string[];
  since?: string;
  until?: string;
  relevant?: number;
  limit?: number;
  cursor?: string;
  sort?: string;
  category?: string;
  include_suspicious?: boolean;
  city?: string;
  when?: string;
  form?: string;
};

const ITEM_PARAM_ORDER = [
  "source_type",
  "since",
  "until",
  "relevant",
  "limit",
  "cursor",
  "sort",
  "category",
  "include_suspicious",
  "city",
  "when",
  "form",
] as const;

function normalizeSourceType(value: string | readonly string[]): string {
  const values = (typeof value === "string" ? value.split(",") : [...value])
    .map((part) => String(part).trim())
    .filter(Boolean);
  return values.length > 1 ? values.sort().join(",") : (values[0] ?? "");
}

export function buildItemsPath(query: ItemsPathQuery = {}): string {
  const params = new URLSearchParams();
  for (const key of ITEM_PARAM_ORDER) {
    const value = query[key];
    if (value === undefined || value === null) continue;
    if (key === "source_type") {
      const sourceType = normalizeSourceType(value as string | readonly string[]);
      if (sourceType) params.set(key, sourceType);
      continue;
    }
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `/api/items?${encoded}` : "/api/items";
}

export function itemsPathMatchesSource(path: string, sourceType: string): boolean {
  const queryIndex = path.indexOf("?");
  if (queryIndex < 0) return false;
  const pathSource = new URLSearchParams(path.slice(queryIndex + 1)).get("source_type");
  if (!pathSource) return false;
  return normalizeSourceType(pathSource) === normalizeSourceType(sourceType);
}

export function getImmediateColumnCount(width: number): number {
  if (width < 768) return 1;
  if (width < 1024) return 2;
  return 3;
}

export function loadMoreLimitForViewport(width: number): 12 | 16 {
  return width < 768 ? 12 : 16;
}

export function shouldPollFeed({
  sourceType,
  feedVisible,
  documentVisible,
  online,
}: {
  sourceType: string;
  feedVisible: boolean;
  documentVisible: boolean;
  online: boolean;
}): boolean {
  return sourceType.split(",").includes("x_list")
    && feedVisible
    && documentVisible
    && online;
}

export type AdjacentIntentDirection = "previous" | "next";

export function adjacentSourceForIntent(
  current: string,
  direction: AdjacentIntentDirection,
  orderedSources: readonly string[],
): string | null {
  const ordered = [...new Set(orderedSources.filter(Boolean))];
  const currentIndex = ordered.indexOf(current);
  if (currentIndex < 0) return null;
  const targetIndex = currentIndex + (direction === "next" ? 1 : -1);
  return ordered[targetIndex] ?? null;
}

type IntentPrefetchTask = (sourceType: string) => Promise<unknown> | unknown;
type IntentScheduleHandle = ReturnType<typeof setTimeout> | unknown;

export type IntentPrefetchController = {
  request(sourceType: string, task: IntentPrefetchTask): boolean;
  cancel(): void;
  dispose(): void;
};

export function createIntentPrefetchController({
  schedule = (callback) => setTimeout(callback, 0),
  cancelScheduled = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}: {
  schedule?: (callback: () => void) => IntentScheduleHandle;
  cancelScheduled?: (handle: IntentScheduleHandle) => void;
} = {}): IntentPrefetchController {
  type QueuedIntent = {
    sourceType: string;
    task: IntentPrefetchTask;
    handle: IntentScheduleHandle | null;
  };
  let queued: QueuedIntent | null = null;
  let activeSource: string | null = null;
  let disposed = false;

  const clearQueued = () => {
    if (queued?.handle !== null && queued?.handle !== undefined) {
      cancelScheduled(queued.handle);
    }
    queued = null;
  };
  const startQueued = () => {
    if (disposed || activeSource || !queued || queued.handle !== null) return;
    const intent = queued;
    intent.handle = schedule(() => {
      if (disposed || queued !== intent) return;
      queued = null;
      activeSource = intent.sourceType;
      void Promise.resolve(intent.task(intent.sourceType))
        .catch(() => {
          // Intent prefetch is best-effort; the mounted Feed remains authoritative.
        })
        .finally(() => {
          if (activeSource === intent.sourceType) activeSource = null;
          startQueued();
        });
    });
  };

  return {
    request(sourceType, task) {
      if (
        disposed
        || !sourceType
        || activeSource === sourceType
        || queued?.sourceType === sourceType
      ) return false;
      clearQueued();
      queued = { sourceType, task, handle: null };
      startQueued();
      return true;
    },
    cancel() {
      clearQueued();
    },
    dispose() {
      disposed = true;
      clearQueued();
    },
  };
}

export function createSingleFlightRegistry(options: { successRetentionMs?: number } = {}) {
  type Entry = {
    request: Promise<unknown>;
    priority: { current?: RequestPurpose };
    clearTimer?: ReturnType<typeof setTimeout>;
  };
  const inFlight = new Map<string, Entry>();
  const successRetentionMs = Math.max(0, options.successRetentionMs ?? 0);

  function run<T>(path: string, factory: () => Promise<T>): Promise<T>;
  function run<T>(
    path: string,
    purpose: RequestPurpose,
    factory: (readPurpose: () => RequestPurpose) => Promise<T>,
  ): Promise<T>;
  function run<T>(
    path: string,
    purposeOrFactory: RequestPurpose | (() => Promise<T>),
    prioritizedFactory?: (readPurpose: () => RequestPurpose) => Promise<T>,
  ): Promise<T> {
    const purpose = typeof purposeOrFactory === "function" ? undefined : purposeOrFactory;
    const factory = typeof purposeOrFactory === "function"
      ? purposeOrFactory
      : prioritizedFactory;

    const existing = inFlight.get(path);
    if (existing) {
      // A visible/interactive consumer upgrades work that was originally
      // scheduled as background. Promotion is one-way: a later background
      // join can never reduce the active request's retry budget.
      if (purpose === "critical") existing.priority.current = "critical";
      return existing.request as Promise<T>;
    }

    if (!factory) {
      return Promise.reject(new TypeError("single-flight factory is required"));
    }

    const priority: Entry["priority"] = { current: purpose };
    const readPurpose = () => priority.current ?? "background";
    let request: Promise<T>;
    try {
      request = purpose === undefined
        ? (factory as () => Promise<T>)()
        : (factory as (readPurpose: () => RequestPurpose) => Promise<T>)(readPurpose);
    } catch (error) {
      return Promise.reject(error);
    }
    const entry: Entry = { request, priority };
    inFlight.set(path, entry);
    const clear = () => {
      if (inFlight.get(path) === entry) inFlight.delete(path);
    };
    const clearAfterSuccess = () => {
      if (successRetentionMs === 0) {
        clear();
        return;
      }
      const timer = setTimeout(clear, successRetentionMs);
      if (inFlight.get(path) === entry) entry.clearTimer = timer;
    };
    // Failures are never retained. A successful result may stay joinable for a
    // short consumer handoff window (used by route-local detail providers).
    void request.then(clearAfterSuccess, clear);
    return request;
  }

  return {
    run,
    has(path: string): boolean {
      return inFlight.has(path);
    },
    hasAny(): boolean {
      return inFlight.size > 0;
    },
    some(predicate: (path: string) => boolean): boolean {
      for (const path of inFlight.keys()) {
        if (predicate(path)) return true;
      }
      return false;
    },
    clear(path: string): void {
      const entry = inFlight.get(path);
      if (entry?.clearTimer) clearTimeout(entry.clearTimer);
      inFlight.delete(path);
    },
  };
}

const listSingleFlight = createSingleFlightRegistry();

export function runListSingleFlight<T>(
  path: string,
  purpose: RequestPurpose,
  factory: (readPurpose: () => RequestPurpose) => Promise<T>,
): Promise<T> {
  return listSingleFlight.run(path, purpose, factory);
}

export function hasListRequestInFlight(path: string): boolean {
  return listSingleFlight.has(path);
}

export function hasAnyListRequestInFlight(): boolean {
  return listSingleFlight.hasAny();
}

export function hasListRequestForSource(sourceType: string): boolean {
  return listSingleFlight.some((path) => itemsPathMatchesSource(path, sourceType));
}

export type ConnectionInfo = {
  saveData?: boolean;
  effectiveType?: string;
};

export function isBackgroundPrefetchDisabled(connection?: ConnectionInfo): boolean {
  if (connection?.saveData) return true;
  const effectiveType = connection?.effectiveType?.toLowerCase();
  return effectiveType === "slow-2g" || effectiveType === "2g" || effectiveType === "3g";
}

export function canStartBackgroundPrefetch(
  readConnection: () => ConnectionInfo | undefined,
): boolean {
  return !isBackgroundPrefetchDisabled(readConnection());
}

type BackgroundTask = () => Promise<void>;

export type BackgroundQueue = {
  enqueue(task: BackgroundTask): Promise<void>;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
};

export function createBackgroundQueue(): BackgroundQueue {
  const pending: Array<{
    task: BackgroundTask;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  let paused = false;
  let running = false;

  const drain = async (): Promise<void> => {
    if (running || paused) return;
    const next = pending.shift();
    if (!next) return;
    running = true;
    try {
      await next.task();
      next.resolve();
    } catch (error) {
      next.reject(error);
    } finally {
      running = false;
      void drain();
    }
  };

  return {
    enqueue(task) {
      const result = new Promise<void>((resolve, reject) => {
        pending.push({ task, resolve, reject });
      });
      void drain();
      return result;
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      void drain();
    },
    isPaused() {
      return paused;
    },
  };
}

type VisibilitySource = EventTarget & { hidden: boolean };

export function bindQueueToVisibility(
  queue: BackgroundQueue,
  source: VisibilitySource,
): () => void {
  const sync = () => {
    if (source.hidden) queue.pause();
    else queue.resume();
  };
  sync();
  source.addEventListener("visibilitychange", sync);
  return () => source.removeEventListener("visibilitychange", sync);
}

type TimerHandle = ReturnType<typeof setTimeout> | number;

type ReadinessOptions = {
  target?: EventTarget;
  getReadyState?: () => string;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  signal?: AbortSignal;
};

export type BackgroundReadinessReason = "lcp" | "interaction" | "fallback";

export function waitForBackgroundReadiness({
  target = window,
  getReadyState = () => document.readyState,
  setTimer = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer = (handle) => window.clearTimeout(handle),
  signal,
}: ReadinessOptions = {}): Promise<BackgroundReadinessReason> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: TimerHandle | null = null;

    const cleanup = () => {
      target.removeEventListener("aifeeds:lcp-settled", onLcp);
      target.removeEventListener("pointerdown", onInteraction);
      target.removeEventListener("keydown", onInteraction);
      target.removeEventListener("load", onLoad);
      signal?.removeEventListener("abort", onAbort);
      if (timer !== null) clearTimer(timer);
    };
    const finish = (reason: BackgroundReadinessReason) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(reason);
    };
    const onLcp = () => finish("lcp");
    const onInteraction = () => finish("interaction");
    const startFallback = () => {
      if (timer !== null || settled) return;
      timer = setTimer(() => finish("fallback"), 8_000);
    };
    const onLoad = () => startFallback();
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    target.addEventListener("aifeeds:lcp-settled", onLcp);
    target.addEventListener("pointerdown", onInteraction, { once: true });
    target.addEventListener("keydown", onInteraction, { once: true });
    if (getReadyState() === "complete") startFallback();
    else target.addEventListener("load", onLoad, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const mountedFeedCounts = new Map<string, number>();

export function registerMountedFeed(sourceType: string): () => void {
  mountedFeedCounts.set(sourceType, (mountedFeedCounts.get(sourceType) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const next = (mountedFeedCounts.get(sourceType) ?? 1) - 1;
    if (next > 0) mountedFeedCounts.set(sourceType, next);
    else mountedFeedCounts.delete(sourceType);
  };
}

export function isFeedMounted(sourceType: string): boolean {
  return (mountedFeedCounts.get(sourceType) ?? 0) > 0;
}

export function getRequestAttemptBudget(method: string, purpose: RequestPurpose): number {
  const normalizedMethod = method.toUpperCase();
  const isRead = normalizedMethod === "GET" || normalizedMethod === "HEAD";
  return isRead && purpose === "critical" ? 2 : 1;
}

type RequestPolicyOptions<T> = {
  method: string;
  purpose: RequestPurposeSource;
  signal?: AbortSignal;
  attempt: (attemptNumber: number) => Promise<T>;
  isRetryableResult?: (result: T) => boolean;
  shouldStopOnError?: (error: unknown) => boolean;
  sleep?: (delay: number) => Promise<void>;
  onFinalResult?: (result: T, attempts: number) => void;
  onFinalError?: (error: unknown, attempts: number) => void;
};

const CRITICAL_RETRY_DELAY_MS = 400;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("aborted", "AbortError");
}

function waitWithSignal(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      () => {
        cleanup();
        resolve();
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export async function executeRequestWithPolicy<T>({
  method,
  purpose,
  signal,
  attempt,
  isRetryableResult = () => false,
  shouldStopOnError = () => false,
  sleep = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  onFinalResult,
  onFinalError,
}: RequestPolicyOptions<T>): Promise<T> {
  const readPurpose = typeof purpose === "function" ? purpose : () => purpose;
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    if (signal?.aborted) throw abortReason(signal);
    let result: T;
    try {
      result = await attempt(attemptNumber);
    } catch (error) {
      const budget = getRequestAttemptBudget(method, readPurpose());
      if (shouldStopOnError(error) || attemptNumber >= budget) {
        onFinalError?.(error, attemptNumber);
        throw error;
      }
      await waitWithSignal(sleep(CRITICAL_RETRY_DELAY_MS), signal);
      continue;
    }
    const budget = getRequestAttemptBudget(method, readPurpose());
    if (attemptNumber < budget && isRetryableResult(result)) {
      await waitWithSignal(sleep(CRITICAL_RETRY_DELAY_MS), signal);
      continue;
    }
    onFinalResult?.(result, attemptNumber);
    return result;
  }
}
