import type { Env } from "../index";
import { verifyCcSyncRequest, sha256Hex } from "./auth";
import { ccItemPageR2Key } from "./page-run";

const CC_SYNC_PREFIX = "/api/cc-sync/";
const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
const NON_NEGATIVE_INTEGER_RE = /^(0|[1-9][0-9]*)$/;
const POSITIVE_INTEGER_RE = /^[1-9][0-9]*$/;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

interface BootstrapPageRow {
  item_id: string;
  source: string;
  url_path: string;
  content_hash: string;
  title: string;
  published_at: string | null;
}

interface ChangeRow {
  seq: number;
  item_id: string;
  op: "upsert" | "delete";
  source: string;
  url_path: string;
  content_hash: string | null;
  title: string;
  published_at: string | null;
}

export async function handleCcSyncRoute(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(CC_SYNC_PREFIX)) return null;

  const auth = await verifyCcSyncRequest(request, env.CC_SYNC_SECRET);
  if (!auth.ok) return auth.response;

  if (request.method.toUpperCase() !== "GET") {
    return syncResponse("method not allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }

  try {
    switch (url.pathname) {
      case "/api/cc-sync/bootstrap":
        return await bootstrapResponse(url, env);
      case "/api/cc-sync/changes":
        return await changesResponse(url, env);
      case "/api/cc-sync/page":
        return await pageResponse(url, env);
      case "/api/cc-sync/health":
        return jsonResponse({
          ok: true,
          db_configured: Boolean(env.DB),
          r2_configured: Boolean(env.READMES),
        });
      default:
        return syncResponse("not found", { status: 404 });
    }
  } catch (error) {
    console.error(
      "[cc-sync] request failed",
      error instanceof Error ? error.message : "unknown error",
    );
    return syncResponse("sync unavailable", { status: 503 });
  }
}

async function bootstrapResponse(url: URL, env: Env): Promise<Response> {
  const afterParam = uniqueQueryParam(url, "after_item_id");
  const watermarkParam = uniqueQueryParam(url, "watermark");
  const limit = parseLimit(url);
  if (
    afterParam === DUPLICATE
    || watermarkParam === DUPLICATE
    || limit === null
  ) {
    return badRequest();
  }

  const afterItemId = afterParam ?? "";
  let watermark: number;
  if (afterItemId === "") {
    if (watermarkParam !== null && watermarkParam !== "") return badRequest();
    watermark = await currentEventWatermark(env);
  } else {
    if (
      watermarkParam === null
      || watermarkParam === ""
      || !isCanonicalNonNegativeInteger(watermarkParam)
    ) {
      return badRequest();
    }
    watermark = Number(watermarkParam);
    const currentMax = await currentEventWatermark(env);
    if (watermark > currentMax) return badRequest();
  }

  const result = await env.DB.prepare(
    `SELECT item_id, source, url_path, content_hash, title, published_at
       FROM cc_item_pages
       WHERE status = 'live'
         AND content_hash IS NOT NULL
         AND item_id > ?
       ORDER BY item_id ASC
       LIMIT ?`,
  ).bind(afterItemId, limit + 1).all<BootstrapPageRow>();
  const rows = result.results || [];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toBootstrapItem);

  return jsonResponse({
    watermark,
    items,
    next_after_item_id: hasMore
      ? items[items.length - 1]?.item_id ?? null
      : null,
  });
}

async function changesResponse(url: URL, env: Env): Promise<Response> {
  const afterParam = uniqueQueryParam(url, "after_seq");
  const limit = parseLimit(url);
  if (
    afterParam === DUPLICATE
    || afterParam === null
    || !isCanonicalNonNegativeInteger(afterParam)
    || limit === null
  ) {
    return badRequest();
  }
  const afterSeq = Number(afterParam);
  const result = await env.DB.prepare(
    `SELECT
       e.seq,
       e.item_id,
       e.op,
       e.content_hash,
       COALESCE(p.source, '') AS source,
       COALESCE(p.url_path, '') AS url_path,
       COALESCE(p.title, '') AS title,
       p.published_at
     FROM cc_page_events e
     LEFT JOIN cc_item_pages p ON p.item_id = e.item_id
     WHERE e.seq > ?
     ORDER BY e.seq ASC
     LIMIT ?`,
  ).bind(afterSeq, limit).all<ChangeRow>();
  const rows = result.results || [];
  if (
    rows.some((row) =>
      row.op !== "upsert"
      && row.op !== "delete"
    )
  ) {
    return syncResponse("sync unavailable", { status: 503 });
  }

  return jsonResponse({
    items: rows.map((row) => ({
      seq: Number(row.seq),
      item_id: String(row.item_id),
      op: row.op,
      source: String(row.source ?? ""),
      url_path: String(row.url_path ?? ""),
      content_hash: row.content_hash === null
        ? null
        : String(row.content_hash),
      title: String(row.title ?? ""),
      published_at: row.published_at === null
        ? null
        : String(row.published_at),
    })),
    next_after_seq: rows.length > 0
      ? Number(rows[rows.length - 1].seq)
      : afterSeq,
  });
}

async function pageResponse(url: URL, env: Env): Promise<Response> {
  const itemIdParam = uniqueQueryParam(url, "item_id");
  const hashParam = uniqueQueryParam(url, "content_hash");
  if (
    itemIdParam === DUPLICATE
    || hashParam === DUPLICATE
    || itemIdParam === null
    || itemIdParam === ""
    || hashParam === null
    || !CONTENT_HASH_RE.test(hashParam)
  ) {
    return syncResponse("not found", { status: 404 });
  }

  const event = await env.DB.prepare(
    `SELECT 1 AS found
       FROM cc_page_events
       WHERE item_id = ?
         AND op = 'upsert'
         AND content_hash = ?
       LIMIT 1`,
  ).bind(itemIdParam, hashParam).first<{ found: number }>();
  if (!event) return syncResponse("not found", { status: 404 });

  const r2Key = ccItemPageR2Key(itemIdParam, hashParam);
  if (!r2Key || !env.READMES) {
    return r2Key
      ? syncResponse("sync unavailable", { status: 503 })
      : syncResponse("not found", { status: 404 });
  }
  const object = await env.READMES.get(r2Key);
  if (!object) return syncResponse("not found", { status: 404 });
  if (object.customMetadata?.contentHash !== hashParam) {
    return syncResponse("sync unavailable", { status: 503 });
  }

  const bytes = await object.arrayBuffer();
  if (await sha256Hex(bytes) !== hashParam) {
    return syncResponse("sync unavailable", { status: 503 });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ETag: hashParam,
      "Cache-Control": "no-store",
    },
  });
}

async function currentEventWatermark(env: Env): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(seq), 0) AS watermark
       FROM cc_page_events`,
  ).first<{ watermark: number }>();
  const watermark = Number(row?.watermark ?? 0);
  if (
    !Number.isSafeInteger(watermark)
    || watermark < 0
  ) {
    throw new Error("invalid event watermark");
  }
  return watermark;
}

function toBootstrapItem(row: BootstrapPageRow): BootstrapPageRow {
  return {
    item_id: String(row.item_id),
    source: String(row.source),
    url_path: String(row.url_path),
    content_hash: String(row.content_hash),
    title: String(row.title),
    published_at: row.published_at === null
      ? null
      : String(row.published_at),
  };
}

const DUPLICATE = Symbol("duplicate query parameter");

function uniqueQueryParam(
  url: URL,
  name: string,
): string | null | typeof DUPLICATE {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) return DUPLICATE;
  return values.length === 1 ? values[0] : null;
}

function parseLimit(url: URL): number | null {
  const value = uniqueQueryParam(url, "limit");
  if (value === DUPLICATE) return null;
  if (value === null) return DEFAULT_LIMIT;
  if (!POSITIVE_INTEGER_RE.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_LIMIT
    ? parsed
    : null;
}

function isCanonicalNonNegativeInteger(value: string): boolean {
  if (!NON_NEGATIVE_INTEGER_RE.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value;
}

function badRequest(): Response {
  return syncResponse("bad request", { status: 400 });
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function syncResponse(body: string, init: ResponseInit): Response {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(body, { ...init, headers });
}
