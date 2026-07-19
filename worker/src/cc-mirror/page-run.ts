import type { Env } from "../index";
import type { DigestSource } from "../digest/config";
import {
  itemPagePath,
  itemPageR2Key,
  renderItem,
  type RenderRow,
} from "../digest/render";
import { renderItemPageHtml } from "../seo/item-page";
import { ccItemPageProfile } from "./profile";
import {
  bindCcPassToCurrentRow,
  reviewCcItem,
} from "./review";

export interface CcPageRunResult {
  itemId: string;
  status: "live" | "gone" | "skipped";
  reason: string;
  eventCreated: boolean;
}

interface StoredPage {
  item_id: string;
  content_hash: string | null;
  status: string;
}

interface R2Backup {
  bytes: ArrayBuffer;
  httpMetadata?: R2HTTPMetadata;
  customMetadata?: Record<string, string>;
}

type CcPageRow = RenderRow & {
  source_type?: string | null;
  published_at?: string | null;
  scraped_at?: string | null;
};

export function ccItemPageR2Key(itemId: string): string | null {
  if (!itemPagePath(itemId)) return null;
  const existingKey = itemPageR2Key(itemId);
  return existingKey
    ? existingKey.replace(/^items\//, "cc-item-pages/")
    : null;
}

export async function syncCcItemPage(
  env: Env,
  itemId: string,
  opts: { forceReview?: boolean; dry?: boolean } = {},
): Promise<CcPageRunResult> {
  const r2Key = ccItemPageR2Key(itemId);
  const urlPath = itemPagePath(itemId);
  if (!r2Key || !urlPath) {
    return skipped(itemId, "unsupported-item-id");
  }

  const review = await reviewCcItem(env, itemId, {
    force: opts.forceReview === true,
    dry: opts.dry === true,
  });
  if (review.status !== "pass" || !review.reviewTextHash) {
    return transitionToGone(
      env,
      itemId,
      review.reason,
      opts.dry === true,
    );
  }

  const bound = await bindCcPassToCurrentRow(
    env,
    itemId,
    review.reviewTextHash,
    review.passProvenance,
  );
  if (!bound.ok) {
    return transitionToGone(
      env,
      itemId,
      bound.reason,
      opts.dry === true,
    );
  }

  const row = bound.row as CcPageRow;
  const source = digestSource(row.source_type);
  if (!source) {
    return transitionToGone(
      env,
      itemId,
      "unsupported-source",
      opts.dry === true,
    );
  }

  let html: string;
  let title: string;
  try {
    const profile = ccItemPageProfile(env);
    html = renderItemPageHtml(row, env, [], profile);
    title = renderItem(source.digest, row, 1, profile.apiBase, {
      newsCoverQualityGate: true,
      extendedIntro: true,
    }).title;
  } catch {
    return transitionToGone(
      env,
      itemId,
      "render-failed",
      opts.dry === true,
    );
  }
  const contentHash = await sha256Hex(html);

  const prior = await getStoredPage(env, itemId);
  if (opts.dry) {
    return skipped(itemId, "dry");
  }
  if (prior?.status === "live" && prior.content_hash === contentHash) {
    return {
      itemId,
      status: "live",
      reason: review.reason,
      eventCreated: false,
    };
  }
  if (!env.READMES) {
    throw new Error("R2 not configured");
  }
  let priorObject: R2Backup | null = null;
  if (prior?.status === "live") {
    const object = await env.READMES.get(r2Key);
    if (!object) {
      throw new Error(
        `[cc-mirror] ${itemId}: live R2 object missing before update`,
      );
    }
    priorObject = {
      bytes: await object.arrayBuffer(),
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    };
  }

  // Publish bytes before the authoritative live row. If R2 fails, D1 remains
  // unchanged and can never claim a missing object. The D1 page row and event
  // are committed together with batch(), which Cloudflare D1 executes as one
  // transaction.
  await env.READMES.put(r2Key, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
  });

  const now = new Date().toISOString();
  const publishedAt = String(
    row.published_at || row.scraped_at || "",
  ).trim() || null;
  let batchResults: D1Result[];
  try {
    batchResults = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO cc_page_events (
           item_id, op, content_hash, created_at
         )
         SELECT ?, 'upsert', ?, ?
         WHERE NOT EXISTS (
           SELECT 1
           FROM cc_item_pages
           WHERE item_id = ?
             AND status = 'live'
             AND content_hash = ?
         )`,
      ).bind(itemId, contentHash, now, itemId, contentHash),
      env.DB.prepare(
        `INSERT INTO cc_item_pages (
           item_id, source, url_path, r2_key, content_hash, title,
           published_at, generated_at, status, reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'live', ?)
         ON CONFLICT(item_id) DO UPDATE SET
           source = excluded.source,
           url_path = excluded.url_path,
           r2_key = excluded.r2_key,
           content_hash = excluded.content_hash,
           title = excluded.title,
           published_at = excluded.published_at,
           generated_at = excluded.generated_at,
           status = 'live',
           reason = excluded.reason`,
      ).bind(
        itemId,
        source.stored,
        urlPath,
        r2Key,
        contentHash,
        title,
        publishedAt,
        now,
        review.reason,
      ),
    ]);
  } catch (databaseError) {
    try {
      if (priorObject) {
        await env.READMES.put(r2Key, priorObject.bytes, {
          httpMetadata: priorObject.httpMetadata,
          customMetadata: priorObject.customMetadata,
        });
      } else {
        await env.READMES.delete(r2Key);
      }
    } catch (compensationError) {
      console.error(
        `[cc-mirror] ${itemId}: R2 compensation failed after D1 batch failure`,
        compensationError,
      );
      throw new AggregateError(
        [databaseError, compensationError],
        `[cc-mirror] ${itemId}: D1 publish and R2 compensation both failed`,
      );
    }
    throw databaseError;
  }

  return {
    itemId,
    status: "live",
    reason: review.reason,
    eventCreated: Number(batchResults[0]?.meta?.changes ?? 0) > 0,
  };
}

export async function markCcItemPageGone(
  env: Env,
  itemId: string,
  reason: string,
): Promise<void> {
  const prior = await getStoredPage(env, itemId);
  if (!prior || prior.status !== "live") return;

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cc_page_events (
         item_id, op, content_hash, created_at
       )
       SELECT ?, 'delete', NULL, ?
       WHERE EXISTS (
         SELECT 1
         FROM cc_item_pages
         WHERE item_id = ?
           AND status = 'live'
       )`,
    ).bind(itemId, now, itemId),
    env.DB.prepare(
      `UPDATE cc_item_pages
       SET status = 'gone', reason = ?, generated_at = ?
       WHERE item_id = ? AND status = 'live'`,
    ).bind(reason, now, itemId),
  ]);
}

async function transitionToGone(
  env: Env,
  itemId: string,
  reason: string,
  dry: boolean,
): Promise<CcPageRunResult> {
  const prior = await getStoredPage(env, itemId);
  if (!prior) return skipped(itemId, dry ? `dry:${reason}` : reason);
  if (prior.status !== "live") {
    return {
      itemId,
      status: "gone",
      reason,
      eventCreated: false,
    };
  }
  if (dry) return skipped(itemId, `dry:${reason}`);

  await markCcItemPageGone(env, itemId, reason);
  return {
    itemId,
    status: "gone",
    reason,
    eventCreated: true,
  };
}

async function getStoredPage(
  env: Env,
  itemId: string,
): Promise<StoredPage | null> {
  return env.DB.prepare(
    `SELECT item_id, content_hash, status
     FROM cc_item_pages
     WHERE item_id = ?`,
  )
    .bind(itemId)
    .first<StoredPage>();
}

function digestSource(
  sourceType: string | null | undefined,
): { digest: DigestSource; stored: string } | null {
  switch (sourceType) {
    case "x_list":
      return { digest: "x", stored: "x" };
    case "github":
      return { digest: "gh", stored: "gh" };
    case "product_hunt":
      return { digest: "ph", stored: "ph" };
    case "hf_paper":
      return { digest: "hf-paper", stored: "paper" };
    case "blog":
    case "podcast":
      return { digest: "news", stored: "news" };
    default:
      return null;
  }
}

function skipped(itemId: string, reason: string): CcPageRunResult {
  return {
    itemId,
    status: "skipped",
    reason,
    eventCreated: false,
  };
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
