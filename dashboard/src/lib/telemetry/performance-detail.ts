export type ResourceKind =
  | 'r2'
  | 'img_proxy'
  | 'static_asset'
  | 'third_party_hf'
  | 'third_party_hdx'
  | 'other_third_party'
  | 'none';

export type ResourceOriginClass = 'api' | 'same_origin' | 'third_party' | 'none';

export interface ResourceClassification {
  kind: ResourceKind;
  origin_class: ResourceOriginClass;
}

export type SafeLcpTag = 'img' | 'video' | 'text' | 'other';
export type MediaPriority = 'high' | 'eager' | 'lazy';

export interface SafeLcpDetail {
  tag: SafeLcpTag;
  resource_kind: ResourceKind;
  source_type?: string;
  media_priority?: MediaPriority;
}

interface AttributeReader {
  getAttribute?: (name: string) => string | null;
}

interface ElementLike extends AttributeReader {
  tagName?: string | null;
  closest?: (selector: string) => AttributeReader | null;
}

export interface LcpEntryLike {
  element?: ElementLike | null;
  url?: string | null;
}

interface MetricWithEntries {
  entries?: LcpEntryLike[] | readonly LcpEntryLike[];
}

const API_HOSTS = new Set(['api.ai-feeds.com', 'staging-api.ai-feeds.com']);
const SAFE_SOURCE_TYPES = new Set([
  'x_list',
  'github',
  'product_hunt',
  'clawhub',
  'hf_paper',
  'huodongxing',
  'blog',
  'podcast',
  'blog,podcast',
  'youtube',
]);
const TEXT_TAGS = new Set([
  'P', 'SPAN', 'DIV', 'ARTICLE', 'SECTION', 'MAIN',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
]);

function browserOrigin(): string | undefined {
  return typeof window === 'undefined' ? undefined : window.location.origin;
}

function parseUrl(raw: string, pageOrigin?: string): URL | null {
  if (!raw || (raw[0] !== '/' && !/^[a-z][a-z\d+.-]*:\/\//i.test(raw))) return null;
  try {
    return new URL(raw, pageOrigin || browserOrigin());
  } catch {
    return null;
  }
}

function isHostOrSubdomain(hostname: string, parent: string): boolean {
  return hostname === parent || hostname.endsWith(`.${parent}`);
}

export function classifyResourceUrl(raw: string | null | undefined, pageOrigin?: string): ResourceClassification {
  const url = parseUrl(raw || '', pageOrigin);
  if (!url) return { kind: 'none', origin_class: 'none' };

  const origin = pageOrigin || browserOrigin();
  const originClass: ResourceOriginClass = API_HOSTS.has(url.hostname)
    ? 'api'
    : origin && url.origin === origin
      ? 'same_origin'
      : 'third_party';

  if (url.pathname === '/r' || url.pathname.startsWith('/r/')) {
    return { kind: 'r2', origin_class: originClass };
  }
  if (url.pathname === '/img' || url.pathname.startsWith('/img/')) {
    return { kind: 'img_proxy', origin_class: originClass };
  }
  if (isHostOrSubdomain(url.hostname, 'huggingface.co')) {
    return { kind: 'third_party_hf', origin_class: 'third_party' };
  }
  if (isHostOrSubdomain(url.hostname, 'huodongxing.com')) {
    return { kind: 'third_party_hdx', origin_class: 'third_party' };
  }
  if (originClass === 'same_origin') {
    return { kind: 'static_asset', origin_class: 'same_origin' };
  }
  if (originClass === 'third_party') {
    return { kind: 'other_third_party', origin_class: 'third_party' };
  }
  return { kind: 'none', origin_class: originClass };
}

function safeAttribute(node: AttributeReader | null | undefined, name: string): string | null {
  try {
    return node?.getAttribute?.(name) ?? null;
  } catch {
    return null;
  }
}

function safeClosest(element: ElementLike | null | undefined): AttributeReader | null {
  try {
    return element?.closest?.('[data-feed-source]') ?? null;
  } catch {
    return null;
  }
}

export function safeLcpDescriptor(entry: LcpEntryLike, pageOrigin?: string): SafeLcpDetail {
  const element = entry.element;
  const tagName = typeof element?.tagName === 'string' ? element.tagName.toUpperCase() : '';
  const tag: SafeLcpTag = tagName === 'IMG'
    ? 'img'
    : tagName === 'VIDEO'
      ? 'video'
      : TEXT_TAGS.has(tagName)
        ? 'text'
        : 'other';
  const detail: SafeLcpDetail = {
    tag,
    resource_kind: classifyResourceUrl(entry.url, pageOrigin).kind,
  };

  const sourceType = safeAttribute(safeClosest(element), 'data-feed-source');
  if (sourceType && SAFE_SOURCE_TYPES.has(sourceType)) detail.source_type = sourceType;

  let priority = safeAttribute(element, 'data-media-priority');
  if (priority !== 'high' && priority !== 'eager' && priority !== 'lazy') {
    // Production cards already emit these native attributes. Read only their bounded
    // enum values; never inspect src/alt/title or any element text.
    priority = safeAttribute(element, 'fetchpriority') === 'high'
      ? 'high'
      : safeAttribute(element, 'loading');
  }
  if (priority === 'high' || priority === 'eager' || priority === 'lazy') {
    detail.media_priority = priority;
  }
  return detail;
}

export function safeLcpDescriptorFromMetric(metric: MetricWithEntries, pageOrigin?: string): SafeLcpDetail {
  const entries = metric.entries ?? [];
  return safeLcpDescriptor(entries[entries.length - 1] ?? {}, pageOrigin);
}

export type ApiEndpointCategory = 'items' | 'feed_manifest' | 'sources' | 'stats' | 'auth_me';

const API_ENDPOINTS = new Map<string, ApiEndpointCategory>([
  ['/api/items', 'items'],
  ['/api/feed-manifest', 'feed_manifest'],
  ['/api/sources', 'sources'],
  ['/api/stats', 'stats'],
  ['/api/auth/me', 'auth_me'],
]);

export function classifyApiEndpoint(raw: string): ApiEndpointCategory | null {
  const url = parseUrl(raw);
  return url ? API_ENDPOINTS.get(url.pathname) ?? null : null;
}

export interface ResourceTimingLike {
  name: string;
  initiatorType?: string;
  startTime: number;
  domainLookupStart: number;
  domainLookupEnd: number;
  connectStart: number;
  secureConnectionStart: number;
  connectEnd: number;
  requestStart: number;
  responseStart: number;
  responseEnd: number;
  transferSize?: number;
}

export interface ApiTimingDetail {
  endpoint: ApiEndpointCategory;
  dns: number;
  connect: number;
  tls: number;
  request: number;
  response: number;
  total: number;
  transfer_kb: number;
  initiator: 'fetch';
  same_origin: boolean;
}

function nonNegativeRounded(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function buildApiTimingDetail(entry: ResourceTimingLike, pageOrigin?: string): ApiTimingDetail | null {
  const endpoint = classifyApiEndpoint(entry.name);
  const url = parseUrl(entry.name);
  if (!endpoint || !url) return null;
  const origin = pageOrigin || browserOrigin();
  return {
    endpoint,
    dns: nonNegativeRounded(entry.domainLookupEnd - entry.domainLookupStart),
    connect: nonNegativeRounded(entry.connectEnd - entry.connectStart),
    tls: entry.secureConnectionStart > 0
      ? nonNegativeRounded(entry.connectEnd - entry.secureConnectionStart)
      : 0,
    request: nonNegativeRounded(entry.responseStart - entry.requestStart),
    response: nonNegativeRounded(entry.responseEnd - entry.responseStart),
    total: nonNegativeRounded(entry.responseEnd - entry.startTime),
    transfer_kb: nonNegativeRounded((entry.transferSize || 0) / 1024),
    initiator: 'fetch',
    same_origin: Boolean(origin && url.origin === origin),
  };
}

interface ResourceEntryListLike {
  getEntries: () => ResourceTimingLike[] | readonly ResourceTimingLike[];
}

interface ResourceObserverLike {
  observe: (options: { type: string; buffered: boolean }) => void;
  disconnect: () => void;
}

type ResourceObserverCtor = new (
  callback: (list: ResourceEntryListLike) => void,
) => ResourceObserverLike;

interface ApiResourceObserverOptions {
  ObserverCtor?: ResourceObserverCtor | null;
  pageOrigin?: string;
  deviceMeta?: () => Record<string, unknown>;
  report: (detail: ApiTimingDetail & Record<string, unknown>) => void;
}

export function installApiResourceObserver(options: ApiResourceObserverOptions): () => void {
  const ObserverCtor = options.ObserverCtor === undefined
    ? (typeof PerformanceObserver === 'undefined'
        ? null
        : PerformanceObserver as unknown as ResourceObserverCtor)
    : options.ObserverCtor;
  if (!ObserverCtor) return () => {};

  try {
    const observer = new ObserverCtor((list) => {
      for (const entry of list.getEntries()) {
        if (entry.initiatorType !== 'fetch') continue;
        const detail = buildApiTimingDetail(entry, options.pageOrigin);
        if (!detail) continue;
        options.report({ ...detail, ...(options.deviceMeta?.() ?? {}) });
      }
    });
    observer.observe({ type: 'resource', buffered: true });
    return () => observer.disconnect();
  } catch {
    return () => {};
  }
}

export type FeedReadyDataSource = 'memory_cache' | 'local_snapshot' | 'html_prefetch' | 'network';

export interface FeedReadyPayload {
  source_type: string;
  item_count: number;
  data_source: FeedReadyDataSource;
  query_time_ms?: number;
  [key: string]: unknown;
}

interface FeedReadySchedulerOptions {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  report: (payload: FeedReadyPayload) => void;
}

export interface FeedReadyScheduler {
  schedule: (payload: FeedReadyPayload, isEligible?: () => boolean) => () => void;
}

export function createFeedReadyScheduler(options: FeedReadySchedulerOptions): FeedReadyScheduler {
  let reported = false;
  return {
    schedule(payload, isEligible = () => true) {
      if (reported) return () => {};
      let cancelled = false;
      const frameId = options.requestFrame(() => {
        if (cancelled || reported || !isEligible()) return;
        reported = true;
        options.report(payload);
      });
      return () => {
        if (cancelled) return;
        cancelled = true;
        options.cancelFrame(frameId);
      };
    },
  };
}

interface FeedReadyContenderOptions {
  scheduler: FeedReadyScheduler;
  isEligible: () => boolean;
}

export function createFeedReadyContender(options: FeedReadyContenderOptions): {
  setup: (payload: FeedReadyPayload) => () => void;
} {
  let active = false;
  return {
    setup(payload) {
      if (active || !options.isEligible()) return () => {};
      active = true;
      const cancel = options.scheduler.schedule(payload, options.isEligible);
      return () => {
        if (!active) return;
        active = false;
        cancel();
      };
    },
  };
}

interface FeedRootLike {
  getBoundingClientRect: () => {
    top: number;
    bottom: number;
    left: number;
    right: number;
    width: number;
    height: number;
  };
}

interface FeedViewportState {
  documentVisible: boolean;
  viewportWidth: number;
  viewportHeight: number;
}

export function isFeedRootEligible(
  root: FeedRootLike | null | undefined,
  viewport: FeedViewportState,
): boolean {
  if (!root || !viewport.documentVisible) return false;
  if (!(viewport.viewportWidth > 0) || !(viewport.viewportHeight > 0)) return false;
  try {
    const rect = root.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0)) return false;
    return rect.bottom > 0
      && rect.right > 0
      && rect.top < viewport.viewportHeight
      && rect.left < viewport.viewportWidth;
  } catch {
    return false;
  }
}
