export const OPTIMISTIC_FEED_START = true;

export const DEFAULT_LIVE_CHANNELS = [
  "x_list",
  "blog,podcast",
  "product_hunt",
  "github",
  "hf_paper",
  "huodongxing",
  "clawhub",
] as const;

export type FeedMetadataState = "pending" | "resolved" | "failed";

type InitialAvailabilityOptions = {
  enabled?: boolean;
};

type ResolveAvailabilityOptions = InitialAvailabilityOptions & {
  metadataState: FeedMetadataState;
  live: ReadonlySet<string>;
};

type FeedRenderStateInput = {
  enabled: boolean;
  metadataPlaceholder: boolean;
  itemCount: number;
  hadRenderedItems: boolean;
};

type FeedRenderState = {
  placeholder: boolean;
  nextHadRenderedItems: boolean;
};

const DEFAULT_LIVE_CHANNEL_SET = new Set<string>(DEFAULT_LIVE_CHANNELS);

function metadataHasChannel(live: ReadonlySet<string>, channel: string): boolean {
  return channel.split(",").some((sourceType) => live.has(sourceType));
}

export function isInitiallyLive(
  channel: string,
  { enabled = OPTIMISTIC_FEED_START }: InitialAvailabilityOptions = {},
): boolean {
  return enabled && DEFAULT_LIVE_CHANNEL_SET.has(channel);
}

export function resolveChannelLive(
  channel: string,
  {
    enabled = OPTIMISTIC_FEED_START,
    metadataState,
    live,
  }: ResolveAvailabilityOptions,
): boolean {
  if (enabled && metadataState !== "resolved") {
    return isInitiallyLive(channel, { enabled });
  }
  return metadataHasChannel(live, channel);
}

export function resolveFeedRenderState({
  enabled,
  metadataPlaceholder,
  itemCount,
  hadRenderedItems,
}: FeedRenderStateInput): FeedRenderState {
  if (!enabled) {
    return {
      placeholder: metadataPlaceholder,
      nextHadRenderedItems: false,
    };
  }

  const currentRenderCanLatch = !metadataPlaceholder && itemCount > 0;
  const nextHadRenderedItems = hadRenderedItems || currentRenderCanLatch;
  return {
    placeholder: metadataPlaceholder && !hadRenderedItems,
    nextHadRenderedItems,
  };
}
