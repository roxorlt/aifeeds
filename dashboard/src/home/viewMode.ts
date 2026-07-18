export const HOME_VIEW_COOKIE = "aifeeds_view";
export const HOME_VIEW_MODES = ["classic", "waterfall"] as const;

export type HomeViewMode = (typeof HOME_VIEW_MODES)[number];

const HOME_VIEW_MODE_SET = new Set<string>(HOME_VIEW_MODES);
const HOME_VIEW_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export function isHomeExperienceEnabled(value: unknown): boolean {
  return value === "true";
}

export function isHomeViewMode(value: unknown): value is HomeViewMode {
  return typeof value === "string" && HOME_VIEW_MODE_SET.has(value);
}

function readCookie(cookieHeader: string, name: string): string | undefined {
  for (const token of cookieHeader.split(";")) {
    const separator = token.indexOf("=");
    if (separator < 0) continue;
    const key = token.slice(0, separator).trim();
    if (key !== name) continue;
    return token.slice(separator + 1).trim();
  }
  return undefined;
}

export function resolveHomeView({
  url,
  cookieHeader = "",
  enabled,
}: {
  url: URL;
  cookieHeader?: string;
  enabled: boolean;
}): HomeViewMode {
  if (!enabled) return "classic";

  if (url.searchParams.has("view")) {
    const queryMode = url.searchParams.get("view");
    return isHomeViewMode(queryMode) ? queryMode : "classic";
  }

  const cookieMode = readCookie(cookieHeader, HOME_VIEW_COOKIE);
  return isHomeViewMode(cookieMode) ? cookieMode : "classic";
}

export function serializeHomeViewCookie(mode: HomeViewMode): string {
  if (!isHomeViewMode(mode)) throw new Error("invalid home view");
  return `${HOME_VIEW_COOKIE}=${mode}; Path=/; Max-Age=${HOME_VIEW_MAX_AGE_SECONDS}; SameSite=Lax; Secure`;
}

export function expireHomeViewCookie(): string {
  return `${HOME_VIEW_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;
}

export function isHomeExperiencePath(pathname: string): boolean {
  if (pathname === "/") return true;
  return /^\/t\/[^/]+$/.test(pathname)
    || /^\/g\/[^/]+\/[^/]+$/.test(pathname)
    || /^\/ph\/[^/]+\/[^/]+$/.test(pathname)
    || /^\/c\/[^/]+$/.test(pathname)
    || /^\/e\/[^/]+$/.test(pathname)
    || /^\/h\/[^/]+$/.test(pathname)
    || /^\/o\/[^/]+$/.test(pathname);
}
