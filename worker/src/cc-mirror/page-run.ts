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
import { itemNotDedupedSql } from "../seo/item-page-policy";
import {
  bindCcPassToCurrentRow,
  CC_REVIEW_POLICY_VERSION,
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
  r2_key: string;
  status: string;
}

type CcPageRow = RenderRow & {
  source_type?: string | null;
  published_at?: string | null;
  scraped_at?: string | null;
};

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
const FINAL_ITEM_NOT_DEDUPED_SQL = itemNotDedupedSql("i.extra");

export function ccItemPageR2Key(
  itemId: string,
  contentHash: string,
): string | null {
  if (!CONTENT_HASH_RE.test(contentHash)) return null;
  if (!itemPagePath(itemId)) return null;
  const existingKey = itemPageR2Key(itemId);
  return existingKey
    ? `${existingKey
        .replace(/^items\//, "cc-item-pages/")
        .replace(/\.html$/, "")}/${contentHash}.html`
    : null;
}

export async function syncCcItemPage(
  env: Env,
  itemId: string,
  opts: { forceReview?: boolean; dry?: boolean } = {},
): Promise<CcPageRunResult> {
  const urlPath = itemPagePath(itemId);
  if (!urlPath) {
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
  const r2Key = ccItemPageR2Key(itemId, contentHash);
  if (!r2Key) return skipped(itemId, "invalid-content-hash");

  const prior = await getStoredPage(env, itemId);
  if (opts.dry) {
    return skipped(itemId, "dry");
  }
  if (!env.READMES) {
    throw new Error("R2 not configured");
  }

  // Immutable, content-addressed versions make event replay safe: H1 and H2
  // never share a key. A failed D1 publish may leave a private orphan for a
  // later cleanup pass, but it cannot corrupt any live or historical version.
  await ensureImmutableVersion(env.READMES, r2Key, contentHash, html);

  const now = new Date().toISOString();
  const publishedAt = String(
    row.published_at || row.scraped_at || "",
  ).trim() || null;
  const authSql = finalAuthorizationSql();
  const authBindings = finalAuthorizationBindings(
    itemId,
    row,
    bound.sourcePolicy,
    bound.passProvenance,
    bound.reviewTextHash,
  );
  const batchResults = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO cc_page_events (
         item_id, op, content_hash, created_at
       )
       SELECT ?, 'upsert', ?, ?
       WHERE ${authSql}
         AND NOT EXISTS (
           SELECT 1
           FROM cc_item_pages
           WHERE item_id = ?
             AND status = 'live'
             AND content_hash = ?
         )`,
    ).bind(
      itemId,
      contentHash,
      now,
      ...authBindings,
      itemId,
      contentHash,
    ),
    env.DB.prepare(
      `INSERT INTO cc_item_pages (
         item_id, source, url_path, r2_key, content_hash, title,
         published_at, generated_at, status, reason
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?
       WHERE ${authSql}
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
      ...authBindings,
    ),
  ]);
  const eventCreated = Number(
    batchResults[0]?.meta?.changes ?? 0,
  ) > 0;
  const pageCommitted = Number(
    batchResults[1]?.meta?.changes ?? 0,
  ) > 0;
  if (!pageCommitted) {
    if (eventCreated) {
      throw new Error(
        `[cc-mirror] ${itemId}: event committed without page pointer`,
      );
    }
    return transitionAfterFinalAuthorizationFailure(
      env,
      itemId,
      prior,
    );
  }

  return {
    itemId,
    status: "live",
    reason: review.reason,
    eventCreated,
  };
}

export async function markCcItemPageGone(
  env: Env,
  itemId: string,
  reason: string,
): Promise<boolean> {
  const prior = await getStoredPage(env, itemId);
  if (!prior || prior.status !== "live" || !prior.content_hash) return false;
  return markCcItemPageGoneIfCurrent(
    env,
    itemId,
    reason,
    prior.content_hash,
  );
}

async function markCcItemPageGoneIfCurrent(
  env: Env,
  itemId: string,
  reason: string,
  expectedContentHash: string,
): Promise<boolean> {
  const prior = await getStoredPage(env, itemId);
  if (
    !prior
    || prior.status !== "live"
    || prior.content_hash !== expectedContentHash
  ) return false;

  const now = new Date().toISOString();
  const results = await env.DB.batch([
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
           AND content_hash = ?
       )`,
    ).bind(itemId, now, itemId, expectedContentHash),
    env.DB.prepare(
      `UPDATE cc_item_pages
       SET status = 'gone', reason = ?, generated_at = ?
       WHERE item_id = ? AND status = 'live'
         AND content_hash = ?`,
    ).bind(reason, now, itemId, expectedContentHash),
  ]);
  return Number(results[0]?.meta?.changes ?? 0) > 0
    && Number(results[1]?.meta?.changes ?? 0) > 0;
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

  if (!prior.content_hash) return skipped(itemId, reason);
  const eventCreated = await markCcItemPageGoneIfCurrent(
    env,
    itemId,
    reason,
    prior.content_hash,
  );
  if (!eventCreated) {
    const current = await getStoredPage(env, itemId);
    if (current?.status === "live") return skipped(itemId, reason);
  }
  return {
    itemId,
    status: "gone",
    reason,
    eventCreated,
  };
}

async function transitionAfterFinalAuthorizationFailure(
  env: Env,
  itemId: string,
  prior: StoredPage | null,
): Promise<CcPageRunResult> {
  const reason = "final-authorization-changed";
  if (!prior) return skipped(itemId, reason);
  if (prior.status !== "live" || !prior.content_hash) {
    return {
      itemId,
      status: "gone",
      reason,
      eventCreated: false,
    };
  }

  const eventCreated = await markCcItemPageGoneIfCurrent(
    env,
    itemId,
    reason,
    prior.content_hash,
  );
  if (!eventCreated) return skipped(itemId, reason);
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
    `SELECT item_id, content_hash, r2_key, status
     FROM cc_item_pages
     WHERE item_id = ?`,
  )
    .bind(itemId)
    .first<StoredPage>();
}

async function ensureImmutableVersion(
  bucket: R2Bucket,
  r2Key: string,
  contentHash: string,
  html: string,
): Promise<void> {
  const metadata = await bucket.head(r2Key);
  if (metadata?.customMetadata?.contentHash === contentHash) return;

  await bucket.put(r2Key, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: { contentHash },
  });
}

function finalAuthorizationSql(): string {
  return `EXISTS (
    SELECT 1
    FROM items i
    WHERE i.id = ?
      AND i.source_type IS ?
      AND i.title IS ?
      AND i.content IS ?
      AND i.content_translated IS ?
      AND i.author IS ?
      AND i.handle IS ?
      AND i.url IS ?
      AND i.media IS ?
      AND i.extra IS ?
      AND i.published_at IS ?
      AND i.scraped_at IS ?
      AND i.is_relevant = 1
      AND i.deleted_at IS NULL
      AND ${FINAL_ITEM_NOT_DEDUPED_SQL}
      AND ? IN ('allow', 'manual')
      AND ? IN ('model', 'override')
      AND NOT EXISTS (
        SELECT 1
        FROM cc_item_overrides invalid_override
        WHERE invalid_override.item_id = i.id
          AND invalid_override.action <> 'allow'
      )
      AND (
        EXISTS (
          SELECT 1
          FROM cc_item_overrides allow_override
          WHERE allow_override.item_id = i.id
            AND allow_override.action = 'allow'
        )
        OR (
          ? = 0
          AND ? = 'model'
          AND EXISTS (
            SELECT 1
            FROM cc_item_reviews current_review
            WHERE current_review.item_id = i.id
              AND current_review.policy_version = ?
              AND current_review.source_policy = ?
              AND current_review.review_text_hash = ?
              AND current_review.review_status = 'pass'
          )
        )
      )
  )`;
}

function finalAuthorizationBindings(
  itemId: string,
  row: CcPageRow,
  sourcePolicy: "allow" | "manual",
  passProvenance: "model" | "override",
  expectedReviewTextHash: string,
): unknown[] {
  const nullable = (value: unknown): unknown => value ?? null;
  const requiresAllow =
    sourcePolicy === "manual" || passProvenance === "override";
  return [
    itemId,
    row.source_type ?? null,
    nullable(row.title),
    nullable(row.content),
    nullable(row.content_translated),
    nullable(row.author),
    nullable(row.handle),
    nullable(row.url),
    nullable(row.media),
    nullable(row.extra),
    row.published_at ?? null,
    row.scraped_at ?? null,
    sourcePolicy,
    passProvenance,
    requiresAllow ? 1 : 0,
    passProvenance,
    CC_REVIEW_POLICY_VERSION,
    sourcePolicy,
    expectedReviewTextHash,
  ];
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
