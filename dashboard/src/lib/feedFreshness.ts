interface ScrapedAtRecord {
  scraped_at?: string | null;
}

/** Return the newest opaque server timestamp without reformatting the cursor. */
export function newestScrapedAt(items: readonly ScrapedAtRecord[]): string | null {
  let newest = "";
  for (const item of items) {
    const value = item.scraped_at;
    if (typeof value === "string" && value > newest) newest = value;
  }
  return newest || null;
}
