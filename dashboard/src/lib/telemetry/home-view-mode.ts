export type TelemetryHomeView = "classic" | "waterfall";

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
