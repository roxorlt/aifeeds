import type { XArticle } from "../types";

export type ArticleTier = "rich" | "mid" | "basic";

export function articleTier(a: XArticle | null | undefined): ArticleTier {
  if (!a) return "basic";
  if (a.fetched_at && a.title) return "rich";
  if (a.fetch_failed_at && a.author_handle) return "mid";
  return "basic";
}
