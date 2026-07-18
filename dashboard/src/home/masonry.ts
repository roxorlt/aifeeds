import type { Item } from "../types";

export const MASONRY_ROW_PX = 8;
export const MASONRY_GAP_PX = 12;
export const MASONRY_SSR_SAFETY_PX = MASONRY_ROW_PX + MASONRY_GAP_PX;
const MASONRY_ESTIMATED_CARD_WIDTH_PX = 220;

export function masonryRowSpan(
  measuredHeight: number,
  rowHeight = MASONRY_ROW_PX,
  gap = MASONRY_GAP_PX,
): number {
  if (!Number.isFinite(measuredHeight) || measuredHeight <= 0) return 1;
  const safeRow = Math.max(1, rowHeight);
  const safeGap = Math.max(0, gap);
  return Math.max(1, Math.ceil((measuredHeight + safeGap) / (safeRow + safeGap)));
}

export function nonShrinkingMasonrySpan(
  currentSpan: number,
  measuredHeight: number,
): number {
  const measuredSpan = masonryRowSpan(measuredHeight);
  return Number.isSafeInteger(currentSpan) && currentSpan > 0
    ? Math.max(currentSpan, measuredSpan)
    : measuredSpan;
}

function textLines(value: string | null | undefined, charactersPerLine: number): number {
  const length = value?.trim().length ?? 0;
  if (length === 0) return 0;
  return Math.max(1, Math.ceil(length / charactersPerLine));
}

export function estimateMasonryHeight(
  item: Item,
  media?: { aspectRatio: number } | null,
): number {
  const titleLines = Math.min(4, textLines(item.title, 22));
  const summaryLines = Math.min(
    7,
    textLines(item.content_translated ?? item.content, 34),
  );
  const mediaHeight = media && Number.isFinite(media.aspectRatio) && media.aspectRatio > 0
    ? Math.min(
      300,
      Math.max(100, MASONRY_ESTIMATED_CARD_WIDTH_PX / media.aspectRatio),
    )
    : 0;
  return 76
    + (mediaHeight === 0 ? MASONRY_SSR_SAFETY_PX : 0)
    + (titleLines * 25)
    + (summaryLines * 23)
    + mediaHeight
    + MASONRY_SSR_SAFETY_PX;
}
