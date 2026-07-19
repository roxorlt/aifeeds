import type { Env } from "../index";
import type { RenderRow } from "../digest/render";
import { fetchItemRow } from "../digest/item-fetch";
import { callDeepSeekJson, DEEPSEEK_FLASH } from "../hf-paper/llm";
import { isDedupSuppressed } from "../seo/item-page-policy";
import { buildCcReviewText } from "./review-text";
import {
  resolveCcSourcePolicy,
  type CcSourceDecision,
} from "./source-policy";

export const CC_REVIEW_POLICY_VERSION = 1;

export interface CcRiskFlags {
  china_negative: 0 | 1;
  politics_governance: 0 | 1;
  military_conflict: 0 | 1;
  sanctions_export_control: 0 | 1;
  other_cn_distribution_risk: 0 | 1;
  uncertain: 0 | 1;
  reasons: string[];
}

export interface CcReviewResult {
  status: "pending" | "pass" | "review" | "deny";
  flags: CcRiskFlags;
  reason: string;
  reused: boolean;
}

type ReviewableRow = RenderRow & {
  source_type: string;
  is_relevant: number | null;
  deleted_at: string | null;
};

interface OverrideRow {
  action: string;
  reason: string;
}

interface StoredReviewRow {
  policy_version: number;
  source_policy: string;
  review_status: string;
  flags_json: string;
  reason: string;
  review_text_hash: string;
}

const FLAG_KEYS = [
  "china_negative",
  "politics_governance",
  "military_conflict",
  "sanctions_export_control",
  "other_cn_distribution_risk",
  "uncertain",
] as const;

const DENY_FLAG_KEYS = [
  "china_negative",
  "politics_governance",
  "military_conflict",
  "other_cn_distribution_risk",
] as const;

const REVIEW_FLAG_KEYS = [
  "sanctions_export_control",
  "uncertain",
] as const;

const ZERO_FLAGS: CcRiskFlags = {
  china_negative: 0,
  politics_governance: 0,
  military_conflict: 0,
  sanctions_export_control: 0,
  other_cn_distribution_risk: 0,
  uncertain: 0,
  reasons: [],
};

const CONSERVATIVE_FLAGS: CcRiskFlags = {
  ...ZERO_FLAGS,
  uncertain: 1,
  reasons: ["审核结果不可用，需人工复核"],
};

export async function reviewCcItem(
  env: Env,
  itemId: string,
  opts: { force?: boolean; dry?: boolean } = {},
): Promise<CcReviewResult> {
  const row = (await fetchItemRow(env, itemId)) as ReviewableRow | null;
  const hardGate = evaluateHardGate(row);
  if (hardGate) return hardGate;
  const candidate = row!;

  const sourceDecision = resolveCcSourcePolicy(candidate);
  if (sourceDecision.policy === "deny") {
    return result("deny", ZERO_FLAGS, `source-deny:${sourceDecision.reason}`);
  }

  const override = await env.DB.prepare(
    `SELECT action, reason
     FROM cc_item_overrides
     WHERE item_id = ?`,
  )
    .bind(itemId)
    .first<OverrideRow>();

  if (override?.action === "deny") {
    return result("deny", ZERO_FLAGS, "override-deny");
  }
  if (override?.action === "allow") {
    return result("pass", ZERO_FLAGS, "override-allow");
  }

  const reviewText = buildCcReviewText(candidate, env);
  const reviewTextHash = await sha256Hex(reviewText.hashInput);

  if (!opts.force) {
    const stored = await env.DB.prepare(
      `SELECT
         policy_version,
         source_policy,
         review_status,
         flags_json,
         reason,
         review_text_hash
       FROM cc_item_reviews
       WHERE item_id = ?`,
    )
      .bind(itemId)
      .first<StoredReviewRow>();

    if (
      stored
      && stored.policy_version === CC_REVIEW_POLICY_VERSION
      && stored.review_text_hash === reviewTextHash
      && stored.source_policy === sourceDecision.policy
    ) {
      if (reviewText.renderError) {
        return result(
          "pending",
          CONSERVATIVE_FLAGS,
          `render-failed:${reviewText.renderError}`,
          true,
        );
      }
      return reuseStoredReview(stored, sourceDecision);
    }
  }

  if (reviewText.renderError) {
    const pending = result(
      "pending",
      CONSERVATIVE_FLAGS,
      `render-failed:${reviewText.renderError}`,
    );
    await persistReview(
      env,
      itemId,
      sourceDecision,
      reviewTextHash,
      pending,
      null,
      opts.dry === true,
    );
    return pending;
  }

  if (!reviewText.text) {
    const pending = result(
      "pending",
      CONSERVATIVE_FLAGS,
      "empty-review-text",
    );
    await persistReview(
      env,
      itemId,
      sourceDecision,
      reviewTextHash,
      pending,
      null,
      opts.dry === true,
    );
    return pending;
  }

  if (!env.DEEPSEEK_API_KEY) {
    const pending = result(
      "pending",
      CONSERVATIVE_FLAGS,
      "missing-api-key",
    );
    await persistReview(
      env,
      itemId,
      sourceDecision,
      reviewTextHash,
      pending,
      null,
      opts.dry === true,
    );
    return pending;
  }

  const modelResult = await callDeepSeekJson<CcRiskFlags>(
    env.DEEPSEEK_API_KEY,
    DEEPSEEK_FLASH,
    buildReviewPrompt(reviewText.text),
    { maxTokens: 700, timeoutMs: 60_000, retries: 1 },
  );

  if (modelResult.data === null) {
    const pending = result(
      "pending",
      CONSERVATIVE_FLAGS,
      `model-call-failed:${modelResult.error ?? "null-data"}`,
    );
    await persistReview(
      env,
      itemId,
      sourceDecision,
      reviewTextHash,
      pending,
      null,
      opts.dry === true,
    );
    return pending;
  }

  const normalized = normalizeRiskFlags(modelResult.data);
  const baseResult = normalized.valid
    ? decideFromFlags(normalized.flags, sourceDecision)
    : result(
        "review",
        CONSERVATIVE_FLAGS,
        "model-invalid-shape",
      );
  await persistReview(
    env,
    itemId,
    sourceDecision,
    reviewTextHash,
    baseResult,
    DEEPSEEK_FLASH,
    opts.dry === true,
  );
  return baseResult;
}

function evaluateHardGate(row: ReviewableRow | null): CcReviewResult | null {
  if (!row) return result("deny", ZERO_FLAGS, "item-not-found");
  if (row.is_relevant !== 1) {
    return result("deny", ZERO_FLAGS, "item-not-relevant");
  }
  if (row.deleted_at !== null && row.deleted_at !== undefined) {
    return result("deny", ZERO_FLAGS, "item-deleted");
  }
  if (isDedupSuppressed(row.extra)) {
    return result("deny", ZERO_FLAGS, "item-deduplicated");
  }
  return null;
}

function reuseStoredReview(
  stored: StoredReviewRow,
  sourceDecision: CcSourceDecision,
): CcReviewResult {
  const parsed = parseStoredFlags(stored.flags_json);
  if (!parsed.valid) {
    return result(
      "review",
      CONSERVATIVE_FLAGS,
      "cache-invalid-shape",
      true,
    );
  }
  if (stored.review_status === "pending") {
    return result("pending", parsed.flags, stored.reason, true);
  }
  if (
    stored.review_status !== "pass"
    && stored.review_status !== "review"
    && stored.review_status !== "deny"
  ) {
    return result(
      "review",
      CONSERVATIVE_FLAGS,
      "cache-invalid-status",
      true,
    );
  }

  return {
    ...decideFromFlags(parsed.flags, sourceDecision),
    reused: true,
  };
}

function parseStoredFlags(value: string): {
  valid: boolean;
  flags: CcRiskFlags;
} {
  try {
    return normalizeRiskFlags(JSON.parse(value) as unknown);
  } catch {
    return { valid: false, flags: CONSERVATIVE_FLAGS };
  }
}

function normalizeRiskFlags(value: unknown): {
  valid: boolean;
  flags: CcRiskFlags;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, flags: CONSERVATIVE_FLAGS };
  }

  const object = value as Record<string, unknown>;
  for (const key of FLAG_KEYS) {
    if (
      typeof object[key] !== "number"
      || (object[key] !== 0 && object[key] !== 1)
    ) {
      return { valid: false, flags: CONSERVATIVE_FLAGS };
    }
  }
  if (
    !Array.isArray(object.reasons)
    || object.reasons.some((reason) => typeof reason !== "string")
  ) {
    return { valid: false, flags: CONSERVATIVE_FLAGS };
  }

  return {
    valid: true,
    flags: {
      china_negative: object.china_negative as 0 | 1,
      politics_governance: object.politics_governance as 0 | 1,
      military_conflict: object.military_conflict as 0 | 1,
      sanctions_export_control: object.sanctions_export_control as 0 | 1,
      other_cn_distribution_risk:
        object.other_cn_distribution_risk as 0 | 1,
      uncertain: object.uncertain as 0 | 1,
      reasons: object.reasons
        .slice(0, 5)
        .map((reason) => truncateCodePoints(reason, 80)),
    },
  };
}

function decideFromFlags(
  flags: CcRiskFlags,
  sourceDecision: CcSourceDecision,
): CcReviewResult {
  const denyFlags = DENY_FLAG_KEYS.filter((key) => flags[key] === 1);
  if (denyFlags.length > 0) {
    return result("deny", flags, `risk-deny:${denyFlags.join(",")}`);
  }

  const reviewFlags = REVIEW_FLAG_KEYS.filter((key) => flags[key] === 1);
  if (reviewFlags.length > 0) {
    return result("review", flags, `risk-review:${reviewFlags.join(",")}`);
  }

  if (sourceDecision.policy === "manual") {
    return result("review", flags, "source-manual");
  }
  return result("pass", flags, "model-pass");
}

function result(
  status: CcReviewResult["status"],
  flags: CcRiskFlags,
  reason: string,
  reused = false,
): CcReviewResult {
  return {
    status,
    flags: {
      ...flags,
      reasons: [...flags.reasons],
    },
    reason,
    reused,
  };
}

function buildReviewPrompt(text: string): string {
  return `你是内容分发合规审核器。任务是判断下面“最终页面可见文本”是否适合在中国大陆公开静态发布，不是事实核查。

判定规则：
1. 中性产品、技术或研究内容的全部风险 flag 为 0。
2. 对华负面内容标 china_negative=1。
3. 政治治理内容独立标 politics_governance=1。
4. 军事冲突内容独立标 military_conflict=1。
5. 中性陈述制裁或出口管制事实也标 sanctions_export_control=1，交人工复核。
6. 其他不适合大陆公开分发的风险标 other_cn_distribution_risk=1。
7. 无法确定时标 uncertain=1。

只输出固定 JSON 对象，不要 markdown、解释或额外字段：
{"china_negative":0,"politics_governance":0,"military_conflict":0,"sanctions_export_control":0,"other_cn_distribution_risk":0,"uncertain":0,"reasons":[]}
六个 flag 必须是数字 0 或 1。reasons 最多 5 项，每项不超过 80 个字符。

最终页面可见文本：
${text}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function persistReview(
  env: Env,
  itemId: string,
  sourceDecision: CcSourceDecision,
  reviewTextHash: string,
  review: CcReviewResult,
  model: string | null,
  dry: boolean,
): Promise<void> {
  if (dry) return;

  await env.DB.prepare(
    `INSERT INTO cc_item_reviews (
       item_id,
       policy_version,
       source_policy,
       review_status,
       flags_json,
       reason,
       review_text_hash,
       model,
       reviewed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       policy_version = excluded.policy_version,
       source_policy = excluded.source_policy,
       review_status = excluded.review_status,
       flags_json = excluded.flags_json,
       reason = excluded.reason,
       review_text_hash = excluded.review_text_hash,
       model = excluded.model,
       reviewed_at = excluded.reviewed_at`,
  )
    .bind(
      itemId,
      CC_REVIEW_POLICY_VERSION,
      sourceDecision.policy,
      review.status,
      JSON.stringify(review.flags),
      review.reason,
      reviewTextHash,
      model,
      new Date().toISOString(),
    )
    .run();
}

function truncateCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}
