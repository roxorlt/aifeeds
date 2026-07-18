import type { Item, ItemExtra, SourceType } from "../types";

export type HomeContentFamily =
  | "dynamic"
  | "project"
  | "research"
  | "official"
  | "event"
  | "video";

export type ExposureKind = "impression" | "consumed";
export type ShadowDisposition = "none" | "soft_demote" | "hide";
export type ShadowReason =
  | "none"
  | "impression_cooldown"
  | "consumed_cooldown"
  | "event_expired";

export interface ExposureEntry {
  itemId: string;
  family: HomeContentFamily;
  impressionAt?: number;
  consumedAt?: number;
}

export interface ExposureHistory {
  version: 1;
  entries: ExposureEntry[];
}

export interface ShadowDecision {
  disposition: ShadowDisposition;
  family: HomeContentFamily;
  reason: ShadowReason;
  ruleVersion: typeof EXPOSURE_SHADOW_RULE_VERSION;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ExposurePolicy {
  impressionCooldownMs: number;
  impressionDisposition: Exclude<ShadowDisposition, "none">;
  consumedCooldownMs: number;
  consumedDisposition: Exclude<ShadowDisposition, "none">;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const HISTORY_TTL_MS = 30 * DAY_MS;

export const EXPOSURE_SHADOW_RULE_VERSION = "waterfall-exposure-shadow-v1";
export const EXPOSURE_SHADOW_STORAGE_KEY = "aifeeds_waterfall_exposure_shadow_v1";
export const EXPOSURE_SHADOW_MAX_ITEMS = 256;

const POLICIES: Record<HomeContentFamily, ExposurePolicy> = {
  dynamic: {
    impressionCooldownMs: 1 * DAY_MS,
    impressionDisposition: "hide",
    consumedCooldownMs: 7 * DAY_MS,
    consumedDisposition: "hide",
  },
  project: {
    impressionCooldownMs: 3 * DAY_MS,
    impressionDisposition: "soft_demote",
    consumedCooldownMs: 14 * DAY_MS,
    consumedDisposition: "hide",
  },
  research: {
    impressionCooldownMs: 7 * DAY_MS,
    impressionDisposition: "soft_demote",
    consumedCooldownMs: 30 * DAY_MS,
    consumedDisposition: "hide",
  },
  official: {
    impressionCooldownMs: 7 * DAY_MS,
    impressionDisposition: "soft_demote",
    consumedCooldownMs: 30 * DAY_MS,
    consumedDisposition: "hide",
  },
  event: {
    impressionCooldownMs: 1 * DAY_MS,
    impressionDisposition: "soft_demote",
    consumedCooldownMs: 1 * DAY_MS,
    consumedDisposition: "soft_demote",
  },
  video: {
    impressionCooldownMs: 7 * DAY_MS,
    impressionDisposition: "soft_demote",
    consumedCooldownMs: 30 * DAY_MS,
    consumedDisposition: "hide",
  },
};

export function homeFamilyForSource(source: SourceType | string): HomeContentFamily {
  switch (source) {
    case "github":
    case "product_hunt":
    case "clawhub":
      return "project";
    case "hf_paper":
    case "arxiv":
      return "research";
    case "blog":
    case "podcast":
      return "official";
    case "huodongxing":
      return "event";
    case "youtube":
      return "video";
    case "x_list":
    default:
      return "dynamic";
  }
}

export function createExposureHistory(): ExposureHistory {
  return { version: 1, entries: [] };
}

function latestTimestamp(entry: ExposureEntry): number {
  return Math.max(entry.impressionAt ?? 0, entry.consumedAt ?? 0);
}

function pruneEntries(entries: ExposureEntry[], now: number): ExposureEntry[] {
  return entries
    .filter((entry) => now - latestTimestamp(entry) < HISTORY_TTL_MS)
    .sort((left, right) => latestTimestamp(right) - latestTimestamp(left))
    .slice(0, EXPOSURE_SHADOW_MAX_ITEMS);
}

export function recordExposure(
  history: ExposureHistory,
  input: {
    at: number;
    family: HomeContentFamily;
    itemId: string;
    kind: ExposureKind;
  },
): ExposureHistory {
  const existing = history.entries.find((entry) => entry.itemId === input.itemId);
  const updated: ExposureEntry = {
    itemId: input.itemId,
    family: input.family,
    impressionAt: existing?.impressionAt,
    consumedAt: existing?.consumedAt,
  };
  if (input.kind === "impression") updated.impressionAt = input.at;
  if (input.kind === "consumed") updated.consumedAt = input.at;

  return {
    version: 1,
    entries: pruneEntries([
      updated,
      ...history.entries.filter((entry) => entry.itemId !== input.itemId),
    ], input.at),
  };
}

function parseExtra(extra: Item["extra"]): ItemExtra {
  if (!extra) return {};
  if (typeof extra === "object") return extra;
  try {
    const parsed = JSON.parse(extra);
    return parsed && typeof parsed === "object" ? parsed as ItemExtra : {};
  } catch {
    return {};
  }
}

function activeWithin(timestamp: number | undefined, cooldownMs: number, now: number): boolean {
  return typeof timestamp === "number"
    && Number.isFinite(timestamp)
    && now - timestamp >= 0
    && now - timestamp < cooldownMs;
}

function isExpiredEvent(extra: ItemExtra, now: number): boolean {
  if (!extra.detail_enriched_at && !extra.start_time && !extra.end_time) return false;
  if (extra.status === "historical") return true;
  const start = extra.start_time ? Date.parse(extra.start_time) : Number.NaN;
  const end = extra.end_time ? Date.parse(extra.end_time) : Number.NaN;
  if (Number.isFinite(end) && end < now) return true;
  return Number.isFinite(start)
    && start <= now
    && !Number.isFinite(end)
    && now - start >= DAY_MS;
}

export function evaluateExposureShadow(
  item: Pick<Item, "id" | "source_type" | "extra">,
  history: ExposureHistory,
  now = Date.now(),
): ShadowDecision {
  const family = homeFamilyForSource(item.source_type);
  const base = {
    family,
    ruleVersion: EXPOSURE_SHADOW_RULE_VERSION,
  } as const;

  if (family === "event") {
    if (isExpiredEvent(parseExtra(item.extra), now)) {
      return { ...base, disposition: "hide", reason: "event_expired" };
    }
  }

  const entry = history.entries.find((candidate) => candidate.itemId === item.id);
  if (!entry) return { ...base, disposition: "none", reason: "none" };

  const policy = POLICIES[family];
  if (activeWithin(entry.consumedAt, policy.consumedCooldownMs, now)) {
    return {
      ...base,
      disposition: policy.consumedDisposition,
      reason: "consumed_cooldown",
    };
  }
  if (activeWithin(entry.impressionAt, policy.impressionCooldownMs, now)) {
    return {
      ...base,
      disposition: policy.impressionDisposition,
      reason: "impression_cooldown",
    };
  }
  return { ...base, disposition: "none", reason: "none" };
}

function isFamily(value: unknown): value is HomeContentFamily {
  return typeof value === "string" && Object.hasOwn(POLICIES, value);
}

function parseEntry(value: unknown): ExposureEntry | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ExposureEntry>;
  if (typeof candidate.itemId !== "string" || !isFamily(candidate.family)) return null;
  const impressionAt = typeof candidate.impressionAt === "number" && Number.isFinite(candidate.impressionAt)
    ? candidate.impressionAt
    : undefined;
  const consumedAt = typeof candidate.consumedAt === "number" && Number.isFinite(candidate.consumedAt)
    ? candidate.consumedAt
    : undefined;
  if (impressionAt === undefined && consumedAt === undefined) return null;
  return {
    itemId: candidate.itemId,
    family: candidate.family,
    impressionAt,
    consumedAt,
  };
}

export function loadExposureHistory(storage: StorageLike, now = Date.now()): ExposureHistory {
  try {
    const raw = storage.getItem(EXPOSURE_SHADOW_STORAGE_KEY);
    if (!raw) return createExposureHistory();
    const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return createExposureHistory();
    }
    return {
      version: 1,
      entries: pruneEntries(
        parsed.entries.map(parseEntry).filter((entry): entry is ExposureEntry => entry !== null),
        now,
      ),
    };
  } catch {
    return createExposureHistory();
  }
}

export function saveExposureHistory(storage: StorageLike, history: ExposureHistory): void {
  try {
    storage.setItem(EXPOSURE_SHADOW_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Tracking must remain fail-open when storage is blocked or full.
  }
}

export function evaluateAndRecordExposure(
  storage: StorageLike,
  item: Pick<Item, "id" | "source_type" | "extra">,
  kind: ExposureKind,
  now = Date.now(),
): ShadowDecision {
  const history = loadExposureHistory(storage, now);
  const decision = evaluateExposureShadow(item, history, now);
  const next = recordExposure(history, {
    at: now,
    family: decision.family,
    itemId: item.id,
    kind,
  });
  saveExposureHistory(storage, next);
  return decision;
}
