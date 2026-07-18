export type TelemetryHomeView = "classic" | "waterfall";
export type TelemetryHomeSsrState =
  | "classic"
  | "generated"
  | "fresh"
  | "stale"
  | "fallback";

type AttributeReader = Readonly<{
  getAttribute(name: string): string | null;
}>;

export function resolveTelemetryHomeView(
  root: AttributeReader | undefined,
): TelemetryHomeView {
  return root?.getAttribute("data-home-view") === "waterfall"
    ? "waterfall"
    : "classic";
}

export function resolveTelemetryHomeSsrState(
  root: AttributeReader | undefined,
): TelemetryHomeSsrState {
  const value = root?.getAttribute("data-home-ssr");
  return value === "generated"
    || value === "fresh"
    || value === "stale"
    || value === "fallback"
    ? value
    : "classic";
}
