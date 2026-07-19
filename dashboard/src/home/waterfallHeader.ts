export const WATERFALL_HEADER_HEIGHT = 54;
export const WATERFALL_HEADER_TOP_ZONE = 50;

type HeaderProgressInput = Readonly<{
  y: number;
  delta: number;
  ratio: number;
}>;

export function nextWaterfallHeaderRatio({
  y,
  delta,
  ratio,
}: HeaderProgressInput): number {
  if (y < WATERFALL_HEADER_TOP_ZONE) return 0;
  return Math.max(
    0,
    Math.min(1, ratio + delta / WATERFALL_HEADER_HEIGHT),
  );
}
