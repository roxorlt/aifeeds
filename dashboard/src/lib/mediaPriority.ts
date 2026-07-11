export type MediaLoadPolicy = Readonly<{
  loading: "eager" | "lazy";
  fetchPriority: "high" | "auto";
}>;

export type MediaPriorityTelemetryLabel = "high" | "eager" | "lazy";

type MediaPolicyPosition = {
  columnIndex: number;
  rowIndex: number;
  immediate: boolean;
};

export const HIGH_MEDIA_LOAD_POLICY: MediaLoadPolicy = Object.freeze({
  loading: "eager",
  fetchPriority: "high",
});

export const EAGER_MEDIA_LOAD_POLICY: MediaLoadPolicy = Object.freeze({
  loading: "eager",
  fetchPriority: "auto",
});

export const LAZY_MEDIA_LOAD_POLICY: MediaLoadPolicy = Object.freeze({
  loading: "lazy",
  fetchPriority: "auto",
});

/**
 * Page-level media budget. Only column 0 / row 0 may compete for LCP; other
 * cards in the responsive first row can start eagerly without being promoted.
 */
export function getMediaLoadPolicy({
  columnIndex,
  rowIndex,
  immediate,
}: MediaPolicyPosition): MediaLoadPolicy {
  if (!immediate || rowIndex !== 0) return LAZY_MEDIA_LOAD_POLICY;
  return columnIndex === 0
    ? HIGH_MEDIA_LOAD_POLICY
    : EAGER_MEDIA_LOAD_POLICY;
}

/** Secondary/quoted/link media must not consume the card's primary budget. */
export function demoteMediaLoadPolicy(policy: MediaLoadPolicy): MediaLoadPolicy {
  void policy;
  return LAZY_MEDIA_LOAD_POLICY;
}

export function getMediaPriorityTelemetryLabel(
  policy: MediaLoadPolicy,
): MediaPriorityTelemetryLabel {
  return policy.fetchPriority === "high" ? "high" : policy.loading;
}
