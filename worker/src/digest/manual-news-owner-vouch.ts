/**
 * owner 担保确认（`owner_vouched_v1`）。
 *
 * 一条线索已经有可核验的证据链（`manual_news_evidence` 全部通过 response HMAC 与
 * proof_excerpt 摘要校验），但没能拿到大模型事实评估时，owner 用一句话陈述事实并为它
 * 担保，这条陈述成为候选的标题与摘要。被替换掉的只有「大模型事实评估」这一环，证据链的
 * 密码学校验照旧执行。
 *
 * 与 `source_support_v1` 一样，本文件产出的 payload 是**签名快照**：
 * `canonical_digest` / `hmac_sha256` 覆盖整个 payload，`item_projection` 必须逐字透传给
 * 候选池（confirm 时写入与 sanitize 重建时读取用的是同一个 `ownerVouchCandidateFromPayload`），
 * 任何一侧改写字段形状都会让每次 sanitize 看到 drift 而空转 bump 批次版本。
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

export const MANUAL_NEWS_OWNER_VOUCH_POLICY = 'owner_vouched_v1' as const;
/** `manual_news_lead_audit.action`：owner 担保这一步的授权记录。 */
export const MANUAL_NEWS_OWNER_VOUCH_AUDIT_ACTION = 'vouch_candidate' as const;
/** `manual_news_leads.last_mutation_kind`：担保写入这一步的变更类型。 */
export const MANUAL_NEWS_OWNER_VOUCH_MUTATION_KIND = 'vouch' as const;

const MANUAL_NEWS_OWNER_VOUCH_HMAC_DOMAIN = 'manual-news-owner-vouch-hmac-v1\0';
const MANUAL_NEWS_OWNER_VOUCH_EVENT_DOMAIN = 'mnvo1\0';
const MANUAL_NEWS_OWNER_VOUCH_EVENT_PREFIX = 'mnvo1:';

/** 控制字符、bidi 改写、零宽字符：陈述会直接当标题渲染，一律拒绝。 */
const OWNER_VOUCH_UNSAFE_UNICODE =
  /[\u0000-\u001f\u007f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/u;

const OWNER_VOUCH_MIN_CODE_POINTS = 6;
const OWNER_VOUCH_MAX_CODE_POINTS = 160;
const OWNER_VOUCH_MIN_HAN_CHARACTERS = 4;
const OWNER_VOUCH_MIN_ENGLISH_WORDS = 3;
const OWNER_VOUCH_MIN_CONTENT_TOKENS = 3;
/**
 * 内容 token:一段连续汉字算一个,一个 ASCII 单词(字母开头,可含数字与连字符,
 * 如 `GPT-5` / `Gemini3`)算一个。标点与空白只做分隔,自己不算 token。
 */
const OWNER_VOUCH_CONTENT_TOKEN = /\p{Script=Han}+|[A-Za-z][A-Za-z0-9'’-]*/gu;

export interface ManualNewsOwnerVouchPayload {
  policy_version: typeof MANUAL_NEWS_OWNER_VOUCH_POLICY;
  lead_id: string;
  review_date: string;
  statement: string;
  primary_evidence_id: string;
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
  vouched_at: number;
}

export interface ManualNewsOwnerVouchProof {
  policy_version: typeof MANUAL_NEWS_OWNER_VOUCH_POLICY;
  verification_key_id: string;
  canonical_digest: string;
  hmac_sha256: string;
}

const OWNER_VOUCH_PAYLOAD_KEYS = [
  'policy_version', 'lead_id', 'review_date', 'statement', 'primary_evidence_id',
  'evidence', 'event_identity', 'item_projection', 'vouched_at',
] as const;

/**
 * 陈述规范化 + 校验。trim 后 6–160 code points、单行、无控制字符 / bidi / 零宽字符，
 * 且内容量够：至少 4 个汉字、或至少 3 个英文单词、或至少 3 个内容 token。
 *
 * 三选一是「只放宽不收紧」的写法。2026-09-04 owner 实测 `OpenAI发布Astra`（2 个汉字 +
 * 2 个英文单词）被前两条挡下，但它是一句完整合格的新闻陈述 —— AI 新闻里公司名与产品名
 * 几乎都是英文，中英混写是常态，所以补上 token 计数这一条；同时保留原有两条，避免
 * `阿里发布模型`（单个汉字段，只有 1 个 token）这类原本能过的陈述被新规则误伤。
 *
 * 不合规一律抛 `invalid_vouch_statement`。`owner_asserted_v1` 与 `owner_vouched_v1`
 * 共用这一个口径，面板侧的就地校验必须与此一致。
 */
export function normalizeOwnerVouchStatement(raw: unknown): string {
  if (typeof raw !== 'string' || OWNER_VOUCH_UNSAFE_UNICODE.test(raw)) {
    throw new Error('invalid_vouch_statement');
  }
  const normalized = raw.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const codePoints = Array.from(normalized).length;
  if (codePoints < OWNER_VOUCH_MIN_CODE_POINTS || codePoints > OWNER_VOUCH_MAX_CODE_POINTS) {
    throw new Error('invalid_vouch_statement');
  }
  const hanCount = (normalized.match(/\p{Script=Han}/gu) || []).length;
  const wordCount = (normalized.match(/[A-Za-z][A-Za-z'’-]*/gu) || []).length;
  const contentTokens = (normalized.match(OWNER_VOUCH_CONTENT_TOKEN) || []).length;
  if (hanCount < OWNER_VOUCH_MIN_HAN_CHARACTERS
    && wordCount < OWNER_VOUCH_MIN_ENGLISH_WORDS
    && contentTokens < OWNER_VOUCH_MIN_CONTENT_TOKENS) {
    throw new Error('invalid_vouch_statement');
  }
  return normalized;
}

function ownerVouchPrimaryEvidence(evidence: readonly ManualNewsEvidence[]): ManualNewsEvidence {
  const primary = evidence.find((item) => item.reliable) || evidence[0];
  if (!primary) throw new Error('owner_vouch_payload_invalid');
  return primary;
}

export async function createManualNewsOwnerVouchPayload(input: {
  lead: { id: string; review_date: string };
  statement: string;
  evidence: readonly ManualNewsEvidence[];
  vouched_at: number;
}): Promise<ManualNewsOwnerVouchPayload> {
  assertManualNewsEvidenceSet(input.evidence);
  if (!/^ml-\d{8}-[a-f0-9]{12}$/.test(input.lead.id)
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.lead.review_date)
    || !Number.isSafeInteger(input.vouched_at) || input.vouched_at <= 0) {
    throw new Error('owner_vouch_payload_invalid');
  }
  const statement = normalizeOwnerVouchStatement(input.statement);
  const evidence = canonicalEvidence(input.evidence) as ManualNewsEvidence[];
  const primary = ownerVouchPrimaryEvidence(evidence);
  return {
    policy_version: MANUAL_NEWS_OWNER_VOUCH_POLICY,
    lead_id: input.lead.id,
    review_date: input.lead.review_date,
    statement,
    primary_evidence_id: primary.id,
    evidence,
    event_identity: {
      // 事件身份只绑主证据 URL：同一天两条担保线索引用同一篇来源即视为同一事件,
      // 由 confirm 的事件占用检查挡掉第二条。
      event_key: `${MANUAL_NEWS_OWNER_VOUCH_EVENT_PREFIX}${
        await sha256Hex(`${MANUAL_NEWS_OWNER_VOUCH_EVENT_DOMAIN}${primary.url}`)}`,
    },
    item_projection: {
      item_id: `blog:manual:${input.lead.id}`,
      source_id: `manual:${input.lead.id}`,
      title: statement,
      summary: statement,
      source: primary.publisher,
      score: null,
      url: primary.url,
      published_at: primary.published_at,
    },
    vouched_at: input.vouched_at,
  };
}

/** 候选投影的唯一读取口径：confirm 写入与 sanitize 重建都必须走这里。 */
export function ownerVouchCandidateFromPayload(payload: ManualNewsOwnerVouchPayload): {
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

async function validatedManualNewsOwnerVouchPayload(
  leadId: string,
  payload: ManualNewsOwnerVouchPayload,
): Promise<ManualNewsOwnerVouchPayload> {
  if (!hasExactKeys(payload, OWNER_VOUCH_PAYLOAD_KEYS)
    || payload.policy_version !== MANUAL_NEWS_OWNER_VOUCH_POLICY
    || payload.lead_id !== leadId) {
    throw new Error('owner_vouch_payload_invalid');
  }
  const rebuilt = await createManualNewsOwnerVouchPayload({
    lead: { id: payload.lead_id, review_date: payload.review_date },
    statement: payload.statement,
    evidence: payload.evidence,
    vouched_at: payload.vouched_at,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(payload)) {
    throw new Error('owner_vouch_payload_invalid');
  }
  return rebuilt;
}

export async function createManualNewsOwnerVouchProof(
  input: { lead_id: string; assessment_version: number; payload: ManualNewsOwnerVouchPayload },
  verificationKeys: ManualNewsKeyring,
  responseKeys: ManualNewsKeyring,
): Promise<ManualNewsOwnerVouchProof> {
  const payload = await validatedManualNewsOwnerVouchPayload(input.lead_id, input.payload);
  await assertManualNewsEvidenceBodyDigests(payload.evidence, responseKeys);
  const verificationSecret = verificationKeys.keys.get(verificationKeys.currentKeyId);
  if (!verificationSecret) throw new Error('manual_news_verification_keys_unavailable');
  if (!Number.isSafeInteger(input.assessment_version) || input.assessment_version <= 0) {
    throw new Error('invalid_assessment_version');
  }
  const canonicalDigest = await sha256Hex(
    `${MANUAL_NEWS_OWNER_VOUCH_HMAC_DOMAIN}${canonicalJson(payload)}`,
  );
  return {
    policy_version: MANUAL_NEWS_OWNER_VOUCH_POLICY,
    verification_key_id: verificationKeys.currentKeyId,
    canonical_digest: canonicalDigest,
    hmac_sha256: await hmacSha256Hex(verificationSecret, ownerVouchHmacPayload({
      verification_key_id: verificationKeys.currentKeyId,
      lead_id: input.lead_id,
      assessment_version: input.assessment_version,
      canonical_digest: canonicalDigest,
    })),
  };
}

function ownerVouchHmacPayload(input: {
  verification_key_id: string;
  lead_id: string;
  assessment_version: number;
  canonical_digest: string;
}): string {
  return `${MANUAL_NEWS_OWNER_VOUCH_HMAC_DOMAIN}${canonicalJson({
    policy_version: MANUAL_NEWS_OWNER_VOUCH_POLICY,
    verification_key_id: input.verification_key_id,
    lead_id: input.lead_id,
    assessment_version: input.assessment_version,
    canonical_digest: input.canonical_digest,
  })}`;
}

export async function isCurrentManualNewsOwnerVouchProof(
  input: { lead_id: string; assessment_version: number; payload: ManualNewsOwnerVouchPayload },
  proof: unknown,
  verificationKeys: ManualNewsKeyring,
  responseKeys: ManualNewsKeyring,
): Promise<boolean> {
  if (!hasExactKeys(proof, ['policy_version', 'verification_key_id', 'canonical_digest', 'hmac_sha256'])
    || proof.policy_version !== MANUAL_NEWS_OWNER_VOUCH_POLICY
    || typeof proof.verification_key_id !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(proof.verification_key_id)
    || typeof proof.canonical_digest !== 'string' || !/^[a-f0-9]{64}$/.test(proof.canonical_digest)
    || typeof proof.hmac_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.hmac_sha256)) return false;
  const verificationSecret = verificationKeys.keys.get(proof.verification_key_id);
  if (!verificationSecret) return false;
  try {
    const payload = await validatedManualNewsOwnerVouchPayload(input.lead_id, input.payload);
    await assertManualNewsEvidenceBodyDigests(payload.evidence, responseKeys);
    const canonicalDigest = await sha256Hex(
      `${MANUAL_NEWS_OWNER_VOUCH_HMAC_DOMAIN}${canonicalJson(payload)}`,
    );
    const expectedHmac = await hmacSha256Hex(verificationSecret, ownerVouchHmacPayload({
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
