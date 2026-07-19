export type WaterfallMediaPolicy = Readonly<{
  loading: "eager" | "lazy";
  fetchPriority: "high" | "auto";
}>;

export function rankWaterfallMedia(
  hasMedia: readonly boolean[],
): Array<number | null> {
  let mediaRank = 0;
  return hasMedia.map((present) => {
    if (!present) return null;
    const rank = mediaRank;
    mediaRank += 1;
    return rank;
  });
}

export function waterfallMediaPolicy(
  mediaRank: number | null,
): WaterfallMediaPolicy {
  if (mediaRank === 0) {
    return { loading: "eager", fetchPriority: "high" };
  }
  if (mediaRank === 1) {
    return { loading: "eager", fetchPriority: "auto" };
  }
  return { loading: "lazy", fetchPriority: "auto" };
}
