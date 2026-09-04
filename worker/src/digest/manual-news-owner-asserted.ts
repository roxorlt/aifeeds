/**
 * owner 直接录入（`owner_asserted_v1`）。
 *
 * 这是自用工具的兜底通道：owner 亲自写一句话断言一件事发生了，这句话就是候选的标题与
 * 口播依据，**不要求任何证据**。2026-09-04 早上 owner 提交的三条线索全部
 * `failed / processing_retry_exhausted` 且证据数为 0（大陆服务器取不回境外网页），
 * 9/3 上线的 owner 担保又硬性要求至少一条签名证据，工具整体不可用 —— 本通道是那次事故的
 * 直接修复。
 *
 * 与 {@link ./manual-news-owner-vouch} 的关系：
 * - 有证据时两者都能用，担保（`owner_vouched_v1`）语义更强（owner 担保 + 证据链）；
 *   零证据时只有本通道可用。`vouchManualNewsLeadCandidate` 按证据数量在两者间分派。
 * - 陈述校验共用 `normalizeOwnerVouchStatement`。
 * - 事件身份不同：担保绑主证据 URL（同一篇来源算同一件事），直接录入没有来源可绑，
 *   改绑线索 id —— 也就是说**直接录入的候选不参与跨天/跨线索事件去重**，owner 自己
 *   写重复了就会出现两条候选。这是刻意的：宁可重复，也不能因为去重把 owner 的断言挡掉。
 *
 * 与 `source_support_v1` / `owner_vouched_v1` 一样，本文件产出的 payload 是**签名快照**：
 * `canonical_digest` / `hmac_sha256` 覆盖整个 payload，`item_projection` 必须逐字透传给
 * 候选池，任何一侧改写字段形状都会让每次 sanitize 看到 drift 而空转 bump 批次版本。
 */
import type { ManualNewsKeyring } from '../security/manual-news-keyring';
import {
  assertManualNewsEvidenceBodyDigests,
  assertManualNewsEvidenceSet,
  canonicalEvidence,
  canonicalJson,
  constantTimeHexEqual,
  hasExactKeys,
  hmacSha256Hex,
  sha256Hex,
  type ManualNewsEvidence,
} from './manual-news-leads';
import { normalizeOwnerVouchStatement } from './manual-news-owner-vouch';

export const MANUAL_NEWS_OWNER_ASSERTED_POLICY = 'owner_asserted_v1' as const;
/** `manual_news_lead_audit.action`：owner 一步直接录入这一步的授权记录。 */
export const MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTION = 'assert_candidate' as const;
/**
 * 能为 `owner_asserted_v1` 充当授权凭据的审计 action。
 * 直接录入写 `assert_candidate`；零证据线索走 `vouch-candidate` 入口救回时沿用
 * `vouch_candidate`（那是 owner 从担保按钮点进来的，审计要如实记录入口）。
 */
export const MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTIONS = [
  MANUAL_NEWS_OWNER_ASSERTED_AUDIT_ACTION, 'vouch_candidate',
] as const;
/** `manual_news_leads.last_mutation_kind`：直接录入这一步的变更类型。 */
export const MANUAL_NEWS_OWNER_ASSERTED_MUTATION_KIND = 'assert' as const;
/** 零证据候选的来源署名：候选池与 items.author 都用它。 */
export const MANUAL_NEWS_OWNER_ASSERTED_FALLBACK_SOURCE = '手工补录';

const MANUAL_NEWS_OWNER_ASSERTED_HMAC_DOMAIN = 'manual-news-owner-asserted-hmac-v1\0';
const MANUAL_NEWS_OWNER_ASSERTED_EVENT_DOMAIN = 'mnoa1\0';
const MANUAL_NEWS_OWNER_ASSERTED_EVENT_PREFIX = 'mnoa1:';

export interface ManualNewsOwnerAssertedPayload {
  policy_version: typeof MANUAL_NEWS_OWNER_ASSERTED_POLICY;
  lead_id: string;
  review_date: string;
  statement: string;
  evidence: ManualNewsEvidence[];
  event_identity: { event_key: string };
  item_projection: {
    item_id: string;
    source_id: string;
    title: string;
    summary: string;
    source: string;
    score: null;
    url: string;
    published_at: string | null;
  };
  asserted_at: number;
}

export interface ManualNewsOwnerAssertedProof {
  policy_version: typeof MANUAL_NEWS_OWNER_ASSERTED_POLICY;
  verification_key_id: string;
  canonical_digest: string;
  hmac_sha256: string;
}

const OWNER_ASSERTED_PAYLOAD_KEYS = [
  'policy_version', 'lead_id', 'review_date', 'statement',
  'evidence', 'event_identity', 'item_projection', 'asserted_at',
] as const;

/**
 * 投影里的 url 兜底：线索自带的 https 网址。http / 空值一律退成空串。
 *
 * ⚠️ **空串不是 null**：候选写进 items 时走 `candidate.url || ''`，正式新闻门再用
 * `i.url IS json_extract(...,'$.item_projection.url')` 逐字比对。写成 null 会让守卫
 * 永远对不上，零证据候选一进门就被判 stale。`published_at` 相反，保持 null 即可
 * （`i.published_at IS NULL` 能匹配）。
 */
function ownerAssertedFallbackUrl(inputUrl: unknown): string {
  return typeof inputUrl === 'string' && /^https:\/\//.test(inputUrl) ? inputUrl : '';
}

/** 主证据：优先第一条 reliable，没有就取规范化后的第一条；证据为空时返回 undefined。 */
function ownerAssertedPrimaryEvidence(
  evidence: readonly ManualNewsEvidence[],
): ManualNewsEvidence | undefined {
  return evidence.find((item) => item.reliable) || evidence[0];
}

export async function createManualNewsOwnerAssertedPayload(input: {
  lead: { id: string; review_date: string; input_url: string };
  statement: string;
  evidence: readonly ManualNewsEvidence[];
  asserted_at: number;
}): Promise<ManualNewsOwnerAssertedPayload> {
  assertManualNewsEvidenceSet(input.evidence);
  if (!/^ml-\d{8}-[a-f0-9]{12}$/.test(input.lead.id)
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.lead.review_date)
    || !Number.isSafeInteger(input.asserted_at) || input.asserted_at <= 0) {
    throw new Error('owner_asserted_payload_invalid');
  }
  const statement = normalizeOwnerVouchStatement(input.statement);
  const evidence = canonicalEvidence(input.evidence) as ManualNewsEvidence[];
  const primary = ownerAssertedPrimaryEvidence(evidence);
  return {
    policy_version: MANUAL_NEWS_OWNER_ASSERTED_POLICY,
    lead_id: input.lead.id,
    review_date: input.lead.review_date,
    statement,
    evidence,
    event_identity: {
      // 事件身份绑线索 id:直接录入没有来源可绑,也刻意不参与跨天事件去重。
      event_key: `${MANUAL_NEWS_OWNER_ASSERTED_EVENT_PREFIX}${
        await sha256Hex(`${MANUAL_NEWS_OWNER_ASSERTED_EVENT_DOMAIN}${input.lead.id}`)}`,
    },
    item_projection: {
      item_id: `blog:manual:${input.lead.id}`,
      source_id: `manual:${input.lead.id}`,
      title: statement,
      summary: statement,
      source: primary?.publisher || MANUAL_NEWS_OWNER_ASSERTED_FALLBACK_SOURCE,
      score: null,
      url: primary?.url || ownerAssertedFallbackUrl(input.lead.input_url),
      published_at: primary?.published_at || null,
    },
    asserted_at: input.asserted_at,
  };
}

/** 候选投影的唯一读取口径：confirm 写入与 sanitize 重建都必须走这里。 */
export function ownerAssertedCandidateFromPayload(payload: ManualNewsOwnerAssertedPayload): {
  item_id: string;
  source_id: string;
  title: string;
  summary: string;
  source: string;
  score: null;
  url: string;
  published_at: string | null;
  event_key: string;
} {
  return { ...payload.item_projection, event_key: payload.event_identity.event_key };
}

async function validatedManualNewsOwnerAssertedPayload(
  input: { lead_id: string; input_url: string },
  payload: ManualNewsOwnerAssertedPayload,
): Promise<ManualNewsOwnerAssertedPayload> {
  if (!hasExactKeys(payload, OWNER_ASSERTED_PAYLOAD_KEYS)
    || payload.policy_version !== MANUAL_NEWS_OWNER_ASSERTED_POLICY
    || payload.lead_id !== input.lead_id) {
    throw new Error('owner_asserted_payload_invalid');
  }
  const rebuilt = await createManualNewsOwnerAssertedPayload({
    lead: { id: payload.lead_id, review_date: payload.review_date, input_url: input.input_url },
    statement: payload.statement,
    evidence: payload.evidence,
    asserted_at: payload.asserted_at,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(payload)) {
    throw new Error('owner_asserted_payload_invalid');
  }
  return rebuilt;
}

export async function createManualNewsOwnerAssertedProof(
  input: {
    lead_id: string;
    input_url: string;
    assessment_version: number;
    payload: ManualNewsOwnerAssertedPayload;
  },
  verificationKeys: ManualNewsKeyring,
  responseKeys: ManualNewsKeyring,
): Promise<ManualNewsOwnerAssertedProof> {
  const payload = await validatedManualNewsOwnerAssertedPayload(input, input.payload);
  // 证据为空时这一步天然通过;挂了证据就照常验响应 HMAC 与正文摘要 —— 断言可以不带
  // 证据,但带上的证据必须是真的。
  await assertManualNewsEvidenceBodyDigests(payload.evidence, responseKeys);
  const verificationSecret = verificationKeys.keys.get(verificationKeys.currentKeyId);
  if (!verificationSecret) throw new Error('manual_news_verification_keys_unavailable');
  if (!Number.isSafeInteger(input.assessment_version) || input.assessment_version <= 0) {
    throw new Error('invalid_assessment_version');
  }
  const canonicalDigest = await sha256Hex(
    `${MANUAL_NEWS_OWNER_ASSERTED_HMAC_DOMAIN}${canonicalJson(payload)}`,
  );
  return {
    policy_version: MANUAL_NEWS_OWNER_ASSERTED_POLICY,
    verification_key_id: verificationKeys.currentKeyId,
    canonical_digest: canonicalDigest,
    hmac_sha256: await hmacSha256Hex(verificationSecret, ownerAssertedHmacPayload({
      verification_key_id: verificationKeys.currentKeyId,
      lead_id: input.lead_id,
      assessment_version: input.assessment_version,
      canonical_digest: canonicalDigest,
    })),
  };
}

function ownerAssertedHmacPayload(input: {
  verification_key_id: string;
  lead_id: string;
  assessment_version: number;
  canonical_digest: string;
}): string {
  return `${MANUAL_NEWS_OWNER_ASSERTED_HMAC_DOMAIN}${canonicalJson({
    policy_version: MANUAL_NEWS_OWNER_ASSERTED_POLICY,
    verification_key_id: input.verification_key_id,
    lead_id: input.lead_id,
    assessment_version: input.assessment_version,
    canonical_digest: input.canonical_digest,
  })}`;
}

export async function isCurrentManualNewsOwnerAssertedProof(
  input: {
    lead_id: string;
    input_url: string;
    assessment_version: number;
    payload: ManualNewsOwnerAssertedPayload;
  },
  proof: unknown,
  verificationKeys: ManualNewsKeyring,
  responseKeys: ManualNewsKeyring,
): Promise<boolean> {
  if (!hasExactKeys(proof, ['policy_version', 'verification_key_id', 'canonical_digest', 'hmac_sha256'])
    || proof.policy_version !== MANUAL_NEWS_OWNER_ASSERTED_POLICY
    || typeof proof.verification_key_id !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(proof.verification_key_id)
    || typeof proof.canonical_digest !== 'string' || !/^[a-f0-9]{64}$/.test(proof.canonical_digest)
    || typeof proof.hmac_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.hmac_sha256)) return false;
  const verificationSecret = verificationKeys.keys.get(proof.verification_key_id);
  if (!verificationSecret) return false;
  try {
    const payload = await validatedManualNewsOwnerAssertedPayload(input, input.payload);
    await assertManualNewsEvidenceBodyDigests(payload.evidence, responseKeys);
    const canonicalDigest = await sha256Hex(
      `${MANUAL_NEWS_OWNER_ASSERTED_HMAC_DOMAIN}${canonicalJson(payload)}`,
    );
    const expectedHmac = await hmacSha256Hex(verificationSecret, ownerAssertedHmacPayload({
      verification_key_id: proof.verification_key_id,
      lead_id: input.lead_id,
      assessment_version: input.assessment_version,
      canonical_digest: canonicalDigest,
    }));
    return constantTimeHexEqual(proof.canonical_digest, canonicalDigest)
      && constantTimeHexEqual(proof.hmac_sha256, expectedHmac);
  } catch {
    return false;
  }
}
