import { getFeedDefByKey } from "../feeds/registry";
import type {
  CcSourcePolicy,
  EditorialType,
  FeedKind,
} from "../feeds/types";

export interface CcSourceDecision {
  policy: CcSourcePolicy;
  editorialType: EditorialType | "platform";
  reason: string;
  sourceKey?: string;
}

const PLATFORM_SOURCE_TYPES = new Set([
  "github",
  "product_hunt",
  "hf_paper",
  "x_list",
]);

const UNKNOWN_SOURCE: CcSourceDecision = {
  policy: "deny",
  editorialType: "platform",
  reason: "unknown-source",
};

function readRegistryKey(
  sourceType: FeedKind,
  extra: string | null | undefined,
): string | undefined {
  if (typeof extra !== "string") return undefined;

  try {
    const parsed: unknown = JSON.parse(extra);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const keyName = sourceType === "blog" ? "feed_key" : "show_key";
    const key = (parsed as Record<string, unknown>)[keyName];
    return typeof key === "string" && key.length > 0 ? key : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCcSourcePolicy(row: {
  source_type: string;
  extra?: string | null;
}): CcSourceDecision {
  if (PLATFORM_SOURCE_TYPES.has(row.source_type)) {
    return {
      policy: "allow",
      editorialType: "platform",
      reason: "platform-candidate-per-item-review-required",
      sourceKey: row.source_type,
    };
  }

  if (row.source_type !== "blog" && row.source_type !== "podcast") {
    return { ...UNKNOWN_SOURCE };
  }

  const sourceKey = readRegistryKey(row.source_type, row.extra);
  if (!sourceKey) return { ...UNKNOWN_SOURCE };

  const feed = getFeedDefByKey(row.source_type, sourceKey);
  if (!feed) return { ...UNKNOWN_SOURCE };

  return {
    policy: feed.cc_policy,
    editorialType: feed.editorial_type,
    reason: `registry-policy:${feed.cc_policy}`,
    sourceKey: feed.key,
  };
}
