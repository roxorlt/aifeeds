import type { Item } from "../types";

export const MASONRY_ROW_PX = 1;
export const MASONRY_GAP_PX = 8;
export const MASONRY_SSR_SAFETY_PX = 20;
const MASONRY_ESTIMATED_CARD_WIDTH_PX = 220;
// Edge font metrics and CJK wrapping can consume one more visual line than
// the character-count estimate. Keep the original no-JS visual-line reserve;
// the hydrated grid reconciles this conservative estimate to measured height.
const MASONRY_SSR_WRAP_BUFFER_PX = 28;

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
    + MASONRY_SSR_SAFETY_PX
    + MASONRY_SSR_WRAP_BUFFER_PX;
}
