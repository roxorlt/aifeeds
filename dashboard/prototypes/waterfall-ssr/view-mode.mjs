export const VIEW_MODES = Object.freeze(["classic", "waterfall"]);
export const DEFAULT_VIEW_MODE = "classic";

function isViewMode(value) {
  return VIEW_MODES.includes(value);
}

function readViewCookie(cookieHeader) {
  if (typeof cookieHeader !== "string") return undefined;
  for (const token of cookieHeader.split(";")) {
    const separator = token.indexOf("=");
    if (separator < 0) continue;
    const name = token.slice(0, separator).trim();
    const value = token.slice(separator + 1).trim();
    if (name === "aifeeds_view" && isViewMode(value)) return value;
  }
  return undefined;
}

export function resolveViewMode(url, cookieHeader = "") {
  const requested = url.searchParams.get("view");
  if (isViewMode(requested)) return requested;
  return readViewCookie(cookieHeader) ?? DEFAULT_VIEW_MODE;
}

export function serializeViewCookie(mode) {
  if (!isViewMode(mode)) throw new Error("invalid view mode");
  return `aifeeds_view=${mode}; Max-Age=15552000; Path=/; SameSite=Lax`;
}
