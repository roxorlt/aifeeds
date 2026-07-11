import type { CardImageVariant } from "../types";
import type { MediaLoadPolicy } from "./mediaPriority";
import { resolveAssetUrl } from "./asset.ts";
import { proxyImg } from "./utils.ts";

const VIDEO_POSTER_WIDTH = 400;
const CLIPPED_OVERFLOW = new Set(["auto", "scroll", "hidden", "clip"]);

export function shouldLoadVideoPosterImmediately(policy: MediaLoadPolicy): boolean {
  return policy.loading === "eager" || policy.fetchPriority === "high";
}

/**
 * A video poster has no srcset, so prefer the smallest stored WebP that does
 * not undershoot the 400px card target. Fall back to the largest smaller
 * variant, then to the existing controlled image proxy.
 */
export function resolveVideoPosterSource(
  originalUrl: string | null | undefined,
  variants?: readonly CardImageVariant[] | null,
  options: { forceProxy?: boolean; targetWidth?: number } = {},
): string | undefined {
  if (!originalUrl) return undefined;
  const targetWidth = options.targetWidth ?? VIDEO_POSTER_WIDTH;
  const validVariants = (variants || [])
    .filter((variant) => {
      if (variant?.format !== "webp") return false;
      if (!Number.isFinite(variant.width) || variant.width < 16 || variant.width > 1600) return false;
      const url = String(variant.url || "");
      return url.startsWith("/r/") || /^https?:\/\//i.test(url);
    })
    .sort((a, b) => a.width - b.width);
  const preferred = validVariants.find((variant) => variant.width >= targetWidth)
    ?? validVariants.at(-1);
  if (preferred) return resolveAssetUrl(preferred.url);

  return proxyImg(originalUrl, targetWidth, { force: options.forceProxy }) || undefined;
}

type PosterRootCandidate = Pick<Element, "closest">;
type OverflowReader = (element: Element) => string;

/**
 * Desktop feeds clip and scroll their own `.feed-body`, so each column must be
 * the observer root. On mobile the same node participates in document flow
 * (`overflow-y: visible`), where the viewport is the correct root.
 */
export function resolveVideoPosterObserverRoot(
  node: PosterRootCandidate,
  readOverflowY: OverflowReader = (element) => getComputedStyle(element).overflowY,
): Element | null {
  const feedBody = node.closest(".feed-body");
  if (!feedBody) return null;
  return CLIPPED_OVERFLOW.has(readOverflowY(feedBody)) ? feedBody : null;
}
