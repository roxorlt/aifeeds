import type { Env } from "../index";
import { checkAdminAuth } from "../admin";
import { syncCcItemPage, type CcPageRunResult } from "./page-run";
import { resolveCcSourcePolicy } from "./source-policy";

export type CcMirrorSource = "x" | "gh" | "ph" | "hf-paper" | "news";

export interface CcMirrorBatchOptions {
  source?: CcMirrorSource;
  feedKey?: string;
  limit?: number;
  cursor?: string;
  dry?: boolean;
  forceReview?: boolean;
}

export interface CcMirrorBatchResult {
  scanned: number;
  live: number;
  review: number;
  denied: number;
  pending: number;
  nextCursor: string | null;
}

interface CandidateRow {
  id: string;
}

interface ReviewListRow {
  item_id: string;
  policy_version: number;
  source_policy: string;
  review_status: string;
  flags_json: string;
  reason: string;
  model: string | null;
  reviewed_at: string;
  title: string | null;
  source_type: string | null;
  author: string | null;
  url: string | null;
}

interface CountRow {
  key: string | null;
  count: number;
}

interface SourceCountRow {
  source_type: string;
  source_key: string | null;
  count: number;
}

interface EventStatsRow {
  total_events: number;
  max_seq: number | null;
}

interface DecisionStateRow {
  override_action: string | null;
  decision_token: string | null;
  page_status: string | null;
}

type BatchBucket = "live" | "review" | "denied" | "pending";

const ADMIN_PREFIX = "/api/admin/cc-mirror/";
const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_CONCURRENCY = 5;
const MAX_CURSOR_LENGTH = 512;
const MAX_FEED_KEY_LENGTH = 128;
const MAX_REASON_LENGTH = 500;
const SOURCES = new Set<CcMirrorSource>([
  "x",
  "gh",
  "ph",
  "hf-paper",
  "news",
]);
const REVIEW_STATUSES = new Set(["pending", "pass", "review", "deny"]);

class AdminInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export async function handleCcMirrorAdmin(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(ADMIN_PREFIX)) return null;

  // Authentication deliberately precedes method checks, body parsing, D1, R2,
  // and review calls so malformed unauthenticated requests remain cheap.
  if (!(await checkAdminAuth(request, env))) {
    return adminJson(
      { error: "unauthorized" },
      401,
      env.CF_ACCESS_AUD && env.CF_ACCESS_TEAM_DOMAIN
        ? undefined
        : { "WWW-Authenticate": 'Basic realm="ai-feeds admin"' },
    );
  }

  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== url.origin) {
    return adminJson({ error: "cross_origin_forbidden" }, 403);
  }

  const endpoint = url.pathname.slice(ADMIN_PREFIX.length);
  const expectedMethod = endpoint === "stats" || endpoint === "reviews"
    ? "GET"
    : endpoint === "decision"
      || endpoint === "backfill"
      || endpoint === "reconcile"
    ? "POST"
    : null;
  if (!expectedMethod) return adminJson({ error: "not_found" }, 404);
  if (request.method !== expectedMethod) {
    return adminJson(
      { error: "method_not_allowed" },
      405,
      { Allow: expectedMethod },
    );
  }
  if (expectedMethod === "POST" && !hasJsonContentType(request)) {
    return adminJson({ error: "application_json_required" }, 415);
  }

  try {
    switch (endpoint) {
      case "stats":
        return adminJson(await getCcMirrorStats(env));
      case "reviews":
        return adminJson(await listCcMirrorReviews(env, url.searchParams));
      case "decision":
        return adminJson(await applyCcMirrorDecision(
          env,
          await readJsonObject(request),
        ));
      case "backfill": {
        const body = await readJsonObject(request);
        return adminJson(await backfillCcMirror(
          env,
          parseBackfillBody(body),
        ));
      }
      case "reconcile": {
        const body = await readJsonObject(request);
        return adminJson(await reconcileCcMirror(
          env,
          parseReconcileBody(body),
        ));
      }
      default:
        return adminJson({ error: "not_found" }, 404);
    }
  } catch (error) {
    if (error instanceof AdminInputError) {
      return adminJson(
        { error: error.message, ...error.details },
        error.status,
      );
    }
    console.error(`[cc-mirror-admin] ${endpoint}: operation failed`);
    return adminJson({ error: "cc_mirror_admin_failed" }, 500);
  }
}

export async function backfillCcMirror(
  env: Env,
  opts: CcMirrorBatchOptions,
): Promise<CcMirrorBatchResult> {
  const normalized = normalizeBatchOptions(opts, true);
  const { rows, hasMore } = await selectBackfillCandidates(env, normalized);
  return processCandidateBatch(env, rows, hasMore, normalized);
}

export async function reconcileCcMirror(
  env: Env,
  opts: Omit<CcMirrorBatchOptions, "source" | "feedKey" | "forceReview"> = {},
): Promise<CcMirrorBatchResult> {
  const normalized = normalizeBatchOptions(opts, false);
  const selected = await env.DB.prepare(
    `SELECT id
     FROM (
       SELECT id
       FROM items
       WHERE source_type IN (
         'x_list', 'github', 'product_hunt', 'hf_paper', 'blog', 'podcast'
       )
       UNION
       SELECT item_id AS id
       FROM cc_item_pages
     )
     WHERE id > ?
     ORDER BY id ASC
     LIMIT ?`,
  )
    .bind(normalized.cursor ?? "", normalized.limit + 1)
    .all<CandidateRow>();
  const allRows = selected.results ?? [];
  const hasMore = allRows.length > normalized.limit;
  return processCandidateBatch(
    env,
    allRows.slice(0, normalized.limit),
    hasMore,
    normalized,
  );
}

async function applyCcMirrorDecision(
  env: Env,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  assertOnlyFields(
    body,
    ["item_id", "action", "reason"],
    "invalid_decision_parameter",
  );
  const itemId = requiredTrimmedString(body.item_id, "item_id", 512);
  const action = body.action;
  if (action !== "allow" && action !== "deny") {
    throw new AdminInputError("action_must_be_allow_or_deny");
  }
  const reason = requiredTrimmedString(
    body.reason,
    "reason",
    MAX_REASON_LENGTH,
  );
  const item = await env.DB.prepare("SELECT id FROM items WHERE id = ?")
    .bind(itemId)
    .first<{ id: string }>();
  if (!item) throw new AdminInputError("item_not_found");

  const decisionToken = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO cc_item_overrides (
       item_id, action, reason, decision_token, updated_at
     )
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       action = excluded.action,
       reason = excluded.reason,
       decision_token = excluded.decision_token,
       updated_at = excluded.updated_at`,
  )
    .bind(
      itemId,
      action,
      reason,
      decisionToken,
      new Date().toISOString(),
    )
    .run();

  let sync: CcPageRunResult;
  try {
    sync = await syncCcItemPage(env, itemId, {
      expectedDecision: {
        action,
        token: decisionToken,
      },
    });
  } catch {
    // The override is durable audit state, but the requested publish/unpublish
    // side effect did not complete. Never turn that partial outcome into 200.
    console.error(`[cc-mirror-admin] decision sync failed for ${itemId}`);
    const state = await readDecisionStateOrThrow(env, itemId, action);
    assertDecisionStillCurrent(
      itemId,
      action,
      decisionToken,
      state,
    );
    throw new AdminInputError(
      "cc_mirror_sync_failed",
      502,
      {
        item_id: itemId,
        action,
        override_persisted: true,
        current_decision_action: state.overrideAction,
        current_page_status: state.pageStatus,
      },
    );
  }

  const state = await readDecisionStateOrThrow(env, itemId, action);
  assertDecisionStillCurrent(
    itemId,
    action,
    decisionToken,
    state,
    sync,
  );
  const currentPageStatus = state.pageStatus;
  const actionReachedRequestedState = action === "allow"
    ? sync.status === "live" && currentPageStatus === "live"
    : currentPageStatus === "missing" || currentPageStatus === "gone";
  if (!actionReachedRequestedState) {
    throw new AdminInputError(
      action === "allow"
        ? "cc_mirror_publish_not_live"
        : "cc_mirror_unpublish_incomplete",
      409,
      {
        item_id: itemId,
        action,
        override_persisted: true,
        current_page_status: currentPageStatus,
        sync,
      },
    );
  }

  return {
    ok: true,
    item_id: itemId,
    action,
    current_decision_action: state.overrideAction,
    current_page_status: currentPageStatus,
    sync,
  };
}

async function readDecisionStateOrThrow(
  env: Env,
  itemId: string,
  action: "allow" | "deny",
): Promise<{
  overrideAction: string;
  decisionToken: string | null;
  pageStatus: string;
}> {
  let row: DecisionStateRow | null;
  try {
    row = await env.DB.prepare(
      `SELECT
         o.action AS override_action,
         o.decision_token,
         p.status AS page_status
       FROM (SELECT 1) anchor
       LEFT JOIN cc_item_overrides o ON o.item_id = ?
       LEFT JOIN cc_item_pages p ON p.item_id = ?`,
    )
      .bind(itemId, itemId)
      .first<DecisionStateRow>();
  } catch {
    console.error(`[cc-mirror-admin] decision state check failed for ${itemId}`);
    throw new AdminInputError(
      "cc_mirror_state_check_failed",
      502,
      {
        item_id: itemId,
        action,
        override_persisted: true,
        decision_state: "unknown",
      },
    );
  }
  return {
    overrideAction: row?.override_action ?? "missing",
    decisionToken: row?.decision_token ?? null,
    pageStatus: row?.page_status ?? "missing",
  };
}

function assertDecisionStillCurrent(
  itemId: string,
  action: "allow" | "deny",
  expectedToken: string,
  state: {
    overrideAction: string;
    decisionToken: string | null;
    pageStatus: string;
  },
  sync?: CcPageRunResult,
): void {
  if (
    state.decisionToken === expectedToken
    && state.overrideAction === action
  ) {
    return;
  }
  throw new AdminInputError(
    "decision_superseded",
    409,
    {
      item_id: itemId,
      action,
      override_persisted: true,
      current_decision_action: state.overrideAction,
      current_page_status: state.pageStatus,
      ...(sync ? { sync } : {}),
    },
  );
}

async function listCcMirrorReviews(
  env: Env,
  params: URLSearchParams,
): Promise<Record<string, unknown>> {
  const status = params.get("status") ?? "review";
  if (!REVIEW_STATUSES.has(status)) {
    throw new AdminInputError("invalid_status");
  }
  const limit = parseQueryLimit(params.get("limit"));
  const rawCursor = params.get("cursor");
  if (rawCursor !== null && rawCursor.length === 0) {
    throw new AdminInputError("invalid_cursor");
  }
  const cursor = normalizeCursor(rawCursor ?? undefined);
  const result = await env.DB.prepare(
    `SELECT
       r.item_id,
       r.policy_version,
       r.source_policy,
       r.review_status,
       r.flags_json,
       r.reason,
       r.model,
       r.reviewed_at,
       i.title,
       i.source_type,
       i.author,
       i.url
     FROM cc_item_reviews r
     LEFT JOIN items i ON i.id = r.item_id
     WHERE r.review_status = ?
       AND r.item_id > ?
     ORDER BY r.item_id ASC
     LIMIT ?`,
  )
    .bind(status, cursor ?? "", limit + 1)
    .all<ReviewListRow>();
  const rows = result.results ?? [];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  return {
    status,
    items: page.map((row) => {
      const parsed = parseReviewFlags(row.flags_json);
      return {
        item_id: row.item_id,
        review_status: row.review_status,
        source_policy: row.source_policy,
        policy_version: row.policy_version,
        flags: parsed.flags,
        flags_invalid: !parsed.valid,
        reason: row.reason,
        model: row.model,
        reviewed_at: row.reviewed_at,
        title: row.title,
        source_type: row.source_type,
        author: row.author,
        url: row.url,
      };
    }),
    next_cursor: hasMore && page.length > 0
      ? page[page.length - 1].item_id
      : null,
  };
}

async function getCcMirrorStats(env: Env): Promise<Record<string, unknown>> {
  const [sourceRows, reviewRows, pageRows, events] = await Promise.all([
    env.DB.prepare(
      `SELECT
         source_type,
         CASE
           WHEN json_valid(extra) THEN
             CASE
               WHEN source_type = 'blog'
                 AND json_type(extra, '$.feed_key') = 'text'
                 THEN json_extract(extra, '$.feed_key')
               WHEN source_type = 'podcast'
                 AND json_type(extra, '$.show_key') = 'text'
                 THEN json_extract(extra, '$.show_key')
               ELSE NULL
             END
           ELSE NULL
         END AS source_key,
         COUNT(*) AS count
       FROM items
       WHERE source_type IN (
         'x_list', 'github', 'product_hunt', 'hf_paper', 'blog', 'podcast'
       )
       GROUP BY source_type, source_key`,
    ).all<SourceCountRow>(),
    env.DB.prepare(
      `SELECT review_status AS key, COUNT(*) AS count
       FROM cc_item_reviews
       GROUP BY review_status`,
    ).all<CountRow>(),
    env.DB.prepare(
      `SELECT status AS key, COUNT(*) AS count
       FROM cc_item_pages
       GROUP BY status`,
    ).all<CountRow>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total_events, MAX(seq) AS max_seq
       FROM cc_page_events`,
    ).first<EventStatsRow>(),
  ]);

  const sourcePolicy = { allow: 0, manual: 0, deny: 0 };
  for (const row of sourceRows.results ?? []) {
    const extra = row.source_type === "blog"
      ? JSON.stringify({ feed_key: row.source_key })
      : row.source_type === "podcast"
      ? JSON.stringify({ show_key: row.source_key })
      : null;
    const decision = resolveCcSourcePolicy({
      source_type: row.source_type,
      extra,
    });
    sourcePolicy[decision.policy] += Number(row.count) || 0;
  }

  return {
    source_policy: sourcePolicy,
    review_status: fixedCounts(
      reviewRows.results ?? [],
      ["pending", "pass", "review", "deny"],
    ),
    page_status: fixedCounts(
      pageRows.results ?? [],
      ["live", "gone"],
    ),
    // There is no consumer acknowledgement table yet, so these are deliberately
    // total/max sequence metrics rather than a misleading "pending events".
    events: {
      total_events: Number(events?.total_events ?? 0),
      max_seq: events?.max_seq === null || events?.max_seq === undefined
        ? 0
        : Number(events.max_seq),
    },
  };
}

async function selectBackfillCandidates(
  env: Env,
  opts: Required<Pick<CcMirrorBatchOptions, "limit">>
    & Omit<CcMirrorBatchOptions, "limit">,
): Promise<{ rows: CandidateRow[]; hasMore: boolean }> {
  const bindings: unknown[] = [opts.cursor ?? ""];
  const clauses = [
    "id > ?",
    `source_type IN (
      'x_list', 'github', 'product_hunt', 'hf_paper', 'blog', 'podcast'
    )`,
  ];

  if (opts.source) {
    switch (opts.source) {
      case "x":
        clauses.push("source_type = 'x_list'");
        break;
      case "gh":
        clauses.push("source_type = 'github'");
        break;
      case "ph":
        clauses.push("source_type = 'product_hunt'");
        break;
      case "hf-paper":
        clauses.push("source_type = 'hf_paper'");
        break;
      case "news":
        clauses.push("source_type IN ('blog', 'podcast')");
        break;
    }
  }
  if (opts.feedKey) {
    clauses.push(
      `(
        (
          source_type = 'blog'
          AND json_extract(
            CASE WHEN json_valid(extra) THEN extra ELSE '{}' END,
            '$.feed_key'
          ) = ?
        )
        OR
        (
          source_type = 'podcast'
          AND json_extract(
            CASE WHEN json_valid(extra) THEN extra ELSE '{}' END,
            '$.show_key'
          ) = ?
        )
      )`,
    );
    bindings.push(opts.feedKey, opts.feedKey);
  }
  bindings.push(opts.limit + 1);

  const selected = await env.DB.prepare(
    `SELECT id
     FROM items
     WHERE ${clauses.join("\n       AND ")}
     ORDER BY id ASC
     LIMIT ?`,
  )
    .bind(...bindings)
    .all<CandidateRow>();
  const allRows = selected.results ?? [];
  return {
    rows: allRows.slice(0, opts.limit),
    hasMore: allRows.length > opts.limit,
  };
}

async function processCandidateBatch(
  env: Env,
  rows: CandidateRow[],
  hasMore: boolean,
  opts: Required<Pick<CcMirrorBatchOptions, "limit">>
    & Omit<CcMirrorBatchOptions, "limit">,
): Promise<CcMirrorBatchResult> {
  const outcomes = await mapWithConcurrency(
    rows,
    MAX_CONCURRENCY,
    async (row) => {
      try {
        const result = await syncCcItemPage(env, row.id, {
          dry: opts.dry === true,
          forceReview: opts.forceReview === true,
        });
        return classifyCcBatchResult(result);
      } catch {
        console.error(`[cc-mirror-admin] batch sync failed for ${row.id}`);
        return "pending" as const;
      }
    },
  );

  const counts: Record<BatchBucket, number> = {
    live: 0,
    review: 0,
    denied: 0,
    pending: 0,
  };
  for (const outcome of outcomes) counts[outcome] += 1;

  return {
    scanned: rows.length,
    ...counts,
    nextCursor: hasMore && rows.length > 0
      ? rows[rows.length - 1].id
      : null,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index]);
    }
  }

  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

export function classifyCcBatchResult(
  result: CcPageRunResult,
): BatchBucket {
  const reason = result.reason.startsWith("dry:")
    ? result.reason.slice(4)
    : result.reason;
  if (result.status === "live" || reason === "dry") return "live";

  if (
    reason === "source-manual"
    || reason === "model-invalid-shape"
    || reason === "cache-invalid-shape"
    || reason === "cache-invalid-status"
    || reason.startsWith("risk-review:")
  ) {
    return "review";
  }

  if (
    reason === "item-not-found"
    || reason === "item-not-relevant"
    || reason === "item-deleted"
    || reason === "item-deduplicated"
    || reason === "override-deny"
    || reason.startsWith("source-deny:")
    || reason.startsWith("risk-deny:")
  ) {
    return "denied";
  }

  // Unknown/future reasons, renderer faults, snapshot/CAS races, missing pass
  // evidence, and operational failures all require retry or investigation.
  // They must never silently inflate the content-denied bucket.
  return "pending";
}

function normalizeBatchOptions(
  opts: CcMirrorBatchOptions,
  allowSource: boolean,
): Required<Pick<CcMirrorBatchOptions, "limit">>
  & Omit<CcMirrorBatchOptions, "limit"> {
  const source = opts.source;
  if (!allowSource && (source !== undefined || opts.feedKey !== undefined)) {
    throw new AdminInputError("source_not_supported_for_reconcile");
  }
  if (source !== undefined && !SOURCES.has(source)) {
    throw new AdminInputError("invalid_source");
  }
  const feedKey = normalizeOptionalString(
    opts.feedKey,
    "feed_key",
    MAX_FEED_KEY_LENGTH,
  );
  if (feedKey && source !== "news") {
    throw new AdminInputError("feed_key_requires_news_source");
  }
  const limit = normalizeLimit(opts.limit);
  const cursor = normalizeCursor(opts.cursor);
  if (opts.dry !== undefined && typeof opts.dry !== "boolean") {
    throw new AdminInputError("invalid_dry");
  }
  if (
    opts.forceReview !== undefined
    && typeof opts.forceReview !== "boolean"
  ) {
    throw new AdminInputError("invalid_force_review");
  }
  return {
    source,
    feedKey,
    limit,
    cursor,
    dry: opts.dry,
    forceReview: opts.forceReview,
  };
}

function parseBackfillBody(
  body: Record<string, unknown>,
): CcMirrorBatchOptions {
  assertOnlyFields(
    body,
    ["source", "feed_key", "limit", "cursor", "dry", "force_review"],
    "invalid_backfill_parameter",
  );
  return {
    source: body.source as CcMirrorSource | undefined,
    feedKey: body.feed_key as string | undefined,
    limit: body.limit as number | undefined,
    cursor: body.cursor as string | undefined,
    dry: parseBooleanFlag(body.dry, "dry"),
    forceReview: parseBooleanFlag(body.force_review, "force_review"),
  };
}

function parseReconcileBody(
  body: Record<string, unknown>,
): Omit<CcMirrorBatchOptions, "source" | "feedKey" | "forceReview"> {
  assertOnlyFields(
    body,
    ["limit", "cursor", "dry"],
    "invalid_reconcile_parameter",
  );
  return {
    limit: body.limit as number | undefined,
    cursor: body.cursor as string | undefined,
    dry: parseBooleanFlag(body.dry, "dry"),
  };
}

function parseBooleanFlag(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  throw new AdminInputError(`invalid_${field}`);
}

function normalizeLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < 1
    || value > MAX_LIMIT
  ) {
    throw new AdminInputError("invalid_limit");
  }
  return value;
}

function parseQueryLimit(value: string | null): number {
  if (value === null) return DEFAULT_LIMIT;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new AdminInputError("invalid_limit");
  }
  return normalizeLimit(Number(value));
}

function normalizeCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_CURSOR_LENGTH
  ) {
    throw new AdminInputError("invalid_cursor");
  }
  return value;
}

function normalizeOptionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AdminInputError(`invalid_${field}`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new AdminInputError(`invalid_${field}`);
  }
  return normalized;
}

function requiredTrimmedString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  const normalized = normalizeOptionalString(value, field, maxLength);
  if (!normalized) throw new AdminInputError(`${field}_required`);
  return normalized;
}

function assertOnlyFields(
  body: Record<string, unknown>,
  fields: string[],
  error: string,
): void {
  const allowed = new Set(fields);
  if (Object.keys(body).some((key) => !allowed.has(key))) {
    throw new AdminInputError(error);
  }
}

function hasJsonContentType(request: Request): boolean {
  const raw = request.headers.get("Content-Type");
  if (!raw) return false;
  const parts = raw.split(";").map((part) => part.trim());
  if (parts[0].toLowerCase() !== "application/json") return false;
  if (parts.length === 1) return true;
  if (parts.length !== 2) return false;
  return /^charset\s*=\s*(?:"utf-8"|utf-8)$/i.test(parts[1]);
}

async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new AdminInputError("body_too_large", 413);
  }
  if (!request.body) return {};

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new AdminInputError("body_too_large", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AdminInputError("invalid_json");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AdminInputError("json_object_required");
  }
  return parsed as Record<string, unknown>;
}

function parseReviewFlags(value: string): {
  valid: boolean;
  flags: Record<string, unknown>;
} {
  const fallback = {
    china_negative: 0,
    politics_governance: 0,
    military_conflict: 0,
    sanctions_export_control: 0,
    other_cn_distribution_risk: 0,
    uncertain: 1,
    reasons: ["审核标记损坏，需人工复核"],
  };
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed === null
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || !Array.isArray(parsed.reasons)
    ) {
      return { valid: false, flags: fallback };
    }
    const keys = [
      "china_negative",
      "politics_governance",
      "military_conflict",
      "sanctions_export_control",
      "other_cn_distribution_risk",
      "uncertain",
    ];
    if (
      keys.some((key) => parsed[key] !== 0 && parsed[key] !== 1)
      || parsed.reasons.some((reason) => typeof reason !== "string")
    ) {
      return { valid: false, flags: fallback };
    }
    return { valid: true, flags: parsed };
  } catch {
    return { valid: false, flags: fallback };
  }
}

function fixedCounts(
  rows: CountRow[],
  knownKeys: string[],
): Record<string, number> {
  const output: Record<string, number> = Object.fromEntries(
    knownKeys.map((key) => [key, 0]),
  );
  output.other = 0;
  const known = new Set(knownKeys);
  for (const row of rows) {
    if (row.key !== null && known.has(row.key)) {
      output[row.key] += Number(row.count) || 0;
    } else {
      output.other += Number(row.count) || 0;
    }
  }
  return output;
}

function adminJson(
  data: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      ...extraHeaders,
    },
  });
}
