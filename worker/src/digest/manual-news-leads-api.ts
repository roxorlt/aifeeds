import type { Env } from '../index';
import {
  manualNewsResponseKeyring,
  manualNewsVerificationKeyring,
} from '../security/manual-news-keyring';
import {
  beginOwnerAssertedEntry,
  confirmManualNewsLeadCandidate,
  getManualNewsCandidateAuthorization,
  getManualNewsLead,
  getManualNewsLeadCandidateState,
  listManualNewsLeads,
  manualNewsLeadProcessingOwner,
  markManualNewsLeadEnqueueFailure,
  recoverStaleManualNewsLeads,
  listManualNewsCandidateAuthorizations,
  listStaleManualLeadContentEntries,
  retryManualNewsLead,
  submitManualNewsLead,
  vouchManualNewsLeadCandidate,
  type ManualNewsCandidateAuthorizationView,
} from './manual-news-leads-store';
import {
  manualLeadNeedsEnrichment,
  runManualLeadEnrichment,
  type ManualEvidenceMaterialSource,
} from './manual-lead-enrichment';
import { createManualLeadEnrichmentAdapters } from './manual-lead-enrichment-runtime';
import {
  recoverManualLeadContentEntry,
  type ManualLeadContentEntryInput,
} from './manual-lead-content-entry';
import {
  MANUAL_LEAD_CONTENT_WORKFLOW_KIND,
  manualLeadContentWorkflowId,
  type ManualLeadContentWorkflowParams,
} from './manual-lead-content-workflow';
import { newsReviewSecret } from './news-review';
import {
  MANUAL_NEWS_SOURCE_SUPPORT_POLICY,
  type ManualNewsEvidence,
} from './manual-news-leads';
import type { ManualNewsLeadRecord, ManualNewsLeadSummary } from './manual-news-leads-pipeline';
import { isTweetEvidenceAudit } from '../security/safe-url-fetch';

const MAX_BODY_BYTES = 16 * 1024;
const BASE_PATH = '/api/digest/daily-news-leads';

type ManualNewsListInput = ManualNewsLeadSummary | ManualNewsLeadRecord;

function manualNewsLeadBase(lead: ManualNewsListInput) {
  return {
    id: lead.id,
    review_date: lead.review_date,
    input_type: lead.input_type,
    input_text: lead.input_text,
    input_url: lead.input_url,
    note: lead.note,
    status: lead.status,
    version: lead.version,
    error_code: lead.error_code,
    error_message: lead.error_message,
    processing_owner: lead.processing_owner,
    processing_attempt: lead.processing_attempt,
    processing_lease_until: lead.processing_lease_until,
    confirmed_batch_id: lead.confirmed_batch_id,
    confirmed_at: lead.confirmed_at,
    created_at: lead.created_at,
    updated_at: lead.updated_at,
    // 一步录入线索的加工进度（规格第 4 / 5 节）。其余线索是 null，面板照旧只看 status。
    content_progress: lead.content_progress ?? null,
  };
}

const UNAUTHORIZED_CANDIDATE_VIEW: ManualNewsCandidateAuthorizationView = {
  candidate_authorization: null, vouch: null,
};

function manualNewsLeadSummary(
  lead: ManualNewsListInput,
  authorization: ManualNewsCandidateAuthorizationView = UNAUTHORIZED_CANDIDATE_VIEW,
) {
  return {
    ...manualNewsLeadBase(lead),
    evidence_count: 'evidence_count' in lead ? lead.evidence_count : lead.evidence.length,
    ...authorization,
  };
}

export function manualNewsEvidenceDetail(item: ManualNewsEvidence) {
  // 证据种类从已持久化的 fetch_audit 派生,不新增持久化字段:
  // 推文证据的 audit 形状与网页直抓完全不同(kind='tweet_api',无 hops/IP),
  // 呈现层据此把「推文证据」与「网页证据」分开,而不是让 owner 从 URL 里猜。
  const tweet = isTweetEvidenceAudit(item.fetch_audit);
  // 官方账号推文(白名单命中,2026-09-03)与普通推文分开标注:前者与官网公告同级,
  // owner 在证据列表里要一眼看出来。
  const officialAccount = tweet && item.reliable && item.source_type === 'official_primary';
  return {
    id: item.id,
    url: item.url,
    source_type: item.source_type,
    evidence_kind: tweet ? 'tweet_api' : 'web',
    source_label: tweet
      ? (officialAccount ? 'X/Twitter 官方账号推文（ScrapeBadger）' : 'X/Twitter 推文（ScrapeBadger）')
      : '网页',
    publisher: item.publisher,
    published_at: item.published_at,
    retrieved_at: item.retrieved_at,
    title: item.title,
    excerpt: item.excerpt,
    reliable: item.reliable,
  };
}

/**
 * 这条线索到底有没有背景素材,以及素材来自哪几家。
 *
 * owner 直接录入的候选,标题与卡片文字都是他自己写的那一句话;口播能不能写得比那一句话
 * 厚,全看入池之后有没有补到素材。补不到的时候审核阶段就该看见,而不是等视频出来才发现
 * 口播单薄——所以详情里带上这一项。读的是 extra 里那两个补充键,与门禁绑定的东西无关。
 */
async function manualNewsLeadEvidenceMaterial(
  env: Env,
  leadId: string,
): Promise<{ chars: number; sources: ManualEvidenceMaterialSource[] } | null> {
  try {
    const row = await env.DB.prepare(
      `/* manual_lead:detail_evidence_material */ SELECT extra FROM items WHERE id = ?`,
    ).bind(`blog:manual:${leadId}`).first<{ extra: string | null }>();
    if (!row?.extra) return null;
    const extra = JSON.parse(row.extra) as Record<string, unknown>;
    const text = typeof extra.manual_evidence_text === 'string' ? extra.manual_evidence_text.trim() : '';
    if (!text) return null;
    const source = (extra.manual_evidence_source && typeof extra.manual_evidence_source === 'object'
      && !Array.isArray(extra.manual_evidence_source))
      ? extra.manual_evidence_source as Record<string, unknown>
      : {};
    // 合并了多份素材时逐份列出来;只有一份时(以及老行)退回主来源那一条。
    const listed = Array.isArray(source.sources) ? source.sources as Record<string, unknown>[] : [];
    const entries = listed.length ? listed : [source];
    return {
      chars: Array.from(text).length,
      sources: entries
        .filter((entry) => entry && typeof entry === 'object' && typeof entry.url === 'string')
        .map((entry) => ({
          url: String(entry.url || ''),
          publisher: String(entry.publisher || ''),
          kind: String(entry.kind || 'document'),
        } as ManualEvidenceMaterialSource)),
    };
  } catch {
    // 这一项只是给审核看的提示,读不出来就当没有,详情本身不能因此挂掉。
    return null;
  }
}

async function manualNewsLeadDetail(env: Env, lead: ManualNewsLeadRecord) {
  return {
    response_profile: 'manual_news_lead_detail_v1' as const,
    schema_version: 1 as const,
    ...manualNewsLeadBase(lead),
    ...await getManualNewsCandidateAuthorization(env, lead.id),
    evidence_material: await manualNewsLeadEvidenceMaterial(env, lead.id),
    ...(lead.assessment_generation ? { assessment_generation: lead.assessment_generation } : {}),
    ...(lead.provider_failure ? { provider_failure: lead.provider_failure } : {}),
    assessment: lead.assessment,
    evidence: lead.evidence.slice(0, 8).filter((item) => {
      const codePoints = Array.from(item.excerpt).length;
      return codePoints > 0 && codePoints <= 3_000
        && new TextEncoder().encode(item.excerpt).byteLength <= 12_000;
    }).map(manualNewsEvidenceDetail),
  };
}

async function manualNewsMutationResult<T extends { lead?: ManualNewsLeadRecord }>(
  env: Env,
  result: T,
) {
  return {
    ...result,
    ...(result.lead ? { lead: await manualNewsLeadDetail(env, result.lead) } : {}),
  };
}

function scheduleLeadProcessing(
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  lead: { id: string; version: number; processing_owner: string | null },
): void {
  if (!env.MANUAL_NEWS_LEAD_WORKFLOW) throw new Error('manual_news_workflow_unavailable');
  const owner = manualNewsLeadProcessingOwner(lead.id, lead.version);
  if (lead.processing_owner !== owner) throw new Error('manual_news_processing_reservation_missing');
  const pending = Promise.resolve().then(() => env.MANUAL_NEWS_LEAD_WORKFLOW!.create({
    id: owner,
    params: { lead_id: lead.id, processing_owner: owner },
  })).then(() => undefined).catch(async (error) => {
    await markManualNewsLeadEnqueueFailure(env, lead.id, lead.version, owner, error);
  });
  ctx.waitUntil(pending);
}

/**
 * 入池成功之后去补一段背景素材。
 *
 * **用 `ctx.waitUntil` 而不是派发 Workflow**：Workflow 那条路要先在库里占一个
 * `processing_owner` 租约、失败要回写 `error_code`，那整套是为「取证决定线索能不能入池」
 * 设计的。补充素材决定不了任何事 —— 它成不成功，候选都已经在池子里了 —— 给它一份带状态
 * 机的重试机制只会让一条已经确认的线索显示成失败。`waitUntil` 正好是「响应发出去之后
 * 顺手做完，做不成就算了」。
 *
 * 三道保险保证它伤不到刚完成的那次确认：这里的 try / catch 挡住同步异常，`.catch` 挡住
 * 异步异常，`runManualLeadEnrichment` 自己还会把失败收敛成一个返回值。
 */
function scheduleLeadEnrichment(
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  outcome: { ok: boolean; lead?: ManualNewsLeadRecord },
): void {
  try {
    const lead = outcome.ok ? outcome.lead : undefined;
    // 无条件先记一行：2026-09-05 排查「取材一行日志都没有」时，光靠下游的失败日志分不清
    // 是没被调用、被这两个条件挡住、还是调用了但静默失败。这行日志把前两种直接区分开。
    console.log('[manual-lead-enrichment] schedule'
      + ` ok=${outcome.ok} lead=${lead ? lead.id : 'none'}`
      + ` evidence=${lead ? (lead.evidence?.length ?? -1) : -1}`);
    if (!lead || !manualLeadNeedsEnrichment(lead)) return;
    ctx.waitUntil(runManualLeadEnrichment(env, {
      leadId: lead.id,
      itemId: `blog:manual:${lead.id}`,
      url: lead.input_url || null,
      text: lead.input_text || '',
      // 审核日期要一路带到网关：搜索那一路少了它就抛 Invalid time value。
      date: lead.review_date,
    }, createManualLeadEnrichmentAdapters(env)).then(() => undefined, () => undefined));
  } catch (error) {
    console.warn('[manual-lead-enrichment] schedule failed:', String((error as Error)?.message || error).slice(0, 200));
  }
}

/**
 * 一步录入的后台那一半：派一条 workflow 去跑内容加工，跑完由它签名入池。
 *
 * **派发用 `ctx.waitUntil`，加工本身不用**：派发是一次亚秒级的 RPC，正是 `waitUntil`
 * 该干的活；加工要一两分钟，挂在 `waitUntil` 上会被运行时回收 —— 2026-09-05 首轮验收
 * 四条线索里有三条就是这么卡在 `drafting` 再没进候选池的（规格第 10.1 节）。
 *
 * 复用取证那条 workflow 的绑定，靠 payload 的 `kind` 与实例 id 前缀分流；这条路一个
 * `processing_owner` 租约都不占，与取证互不干扰。
 *
 * 派发失败（绑定缺失、创建被拒）不影响已经建好的那一行：`content_deadline_at` 过期后由
 * {@link scheduleStaleContentEntries} 直接兜底入池。
 */
function scheduleContentEntry(
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  lead: ManualLeadContentEntryInput,
  now: number,
): void {
  try {
    console.log(`[manual-lead-content] schedule lead=${lead.id} url=${lead.input_url ? 'yes' : 'no'}`);
    const workflow = env.MANUAL_NEWS_LEAD_WORKFLOW;
    if (!workflow) {
      console.warn(`[manual-lead-content] workflow binding missing lead=${lead.id},`
        + ' falling back to deadline recovery');
      return;
    }
    // `now` 取的是 owner 按下提交那一刻，不是加工跑完那一刻：审核窗口该按提交时间算，
    // 让一条卡在窗口边上的线索因为多花了一分钟加工就被判过期是说不通的。
    const params: ManualLeadContentWorkflowParams = {
      kind: MANUAL_LEAD_CONTENT_WORKFLOW_KIND, ...lead, submitted_at: now,
    };
    ctx.waitUntil(Promise.resolve()
      .then(() => workflow.create({ id: manualLeadContentWorkflowId(lead.id), params }))
      .then(() => undefined, (error: unknown) => {
        console.warn('[manual-lead-content] workflow dispatch failed:',
          String((error as Error)?.message || error).slice(0, 200));
      }));
  } catch (error) {
    console.warn('[manual-lead-content] schedule failed:',
      String((error as Error)?.message || error).slice(0, 200));
  }
}

/**
 * 把「加工没了下文」的线索捡回来直接补入池。
 *
 * 挂在列表 GET 上：owner 盯着卡片看进度时页面本来就在轮询，捡回来的时机正好。**只补
 * 入池，不重跑加工** —— 加工在 workflow 上自己会续跑，这里重跑一遍只会跟它抢
 * （规格第 10.1 节）。
 */
async function scheduleStaleContentEntries(
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  date: string,
  now: number,
): Promise<void> {
  const stale = await listStaleManualLeadContentEntries(env, date, now);
  for (const row of stale) {
    console.warn(`[manual-lead-content] recovering stale entry lead=${row.id}`);
    try {
      ctx.waitUntil(recoverManualLeadContentEntry(env, row, now).then(() => undefined, () => undefined));
    } catch (error) {
      console.warn('[manual-lead-content] recovery schedule failed:',
        String((error as Error)?.message || error).slice(0, 200));
    }
  }
}

/**
 * owner 直接录入只需要签名密钥：搜索 / 取证 / 大模型全都不参与。
 * 取证链路挂掉正是这条通道存在的理由，不能跟着一起 503。
 */
function signingKeysAvailable(env: Env): boolean {
  try {
    manualNewsResponseKeyring(env);
    manualNewsVerificationKeyring(env);
    return true;
  } catch {
    return false;
  }
}

function processingDependenciesAvailable(env: Env): boolean {
  if (!(
    env.MANUAL_NEWS_LEAD_WORKFLOW
    && env.MANUAL_NEWS_RESEARCH_ORIGIN
    && env.MANUAL_NEWS_RESEARCH_TOKEN
    && env.DEEPSEEK_API_KEY
  )) return false;
  try {
    manualNewsResponseKeyring(env);
    manualNewsVerificationKeyring(env);
    return true;
  } catch {
    return false;
  }
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
    },
  });
}

/**
 * 异常消息脱敏后才允许进日志。
 *
 * 先抹掉三类可能带凭证的东西：URL（query 里常挂 token）、`token=` / `key=` / `secret=` 这类
 * 键值对、以及 32 位以上的十六进制串（本项目的 token 与摘要都是这个形状）。剩下的部分才是
 * 定位需要的：抛出点写的那句话。
 */
function sanitizedFailureMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b(token|key|secret|password|authorization|bearer)\b\s*[=:]?\s*\S+/gi, '$1=[redacted]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[hex]')
    .slice(0, 300);
}

function requestErrorResponse(error: unknown): Response {
  const code = error instanceof Error ? error.message : 'internal_error';
  if (code === 'request_too_large') return response({ ok: false, error: code }, 413);
  if (code === 'idempotency_key_reused_with_different_payload') return response({ ok: false, error: code }, 409);
  if (['trusted_research_service_required', 'invalid_trusted_research_origin', 'invalid_trusted_research_token',
    'trusted_research_response_secret_required', 'no_deepseek_key']
    .includes(code)) return response({ ok: false, error: 'dependency_unavailable' }, 503);
  if (code === 'invalid_json' || code === 'invalid_review_date' || code === 'lead_input_required'
    || code === 'invalid_candidate_authorization' || code === 'invalid_owner_asserted'
    || code === 'invalid_vouch_statement'
    || code.startsWith('unsafe_url:')) return response({ ok: false, error: code }, 400);
  // 只记 name 时 prod 上是一句 {"error":"Error"}，定位不了任何东西 —— 2026-09-04 晚
  // PR #249 的 500 就是这么变成瞎猜然后只能回滚的。message 会带上抛出点的具体原因
  // （Workers 的子请求上限、D1 约束冲突等都在这里），截断并抹掉 URL 与疑似 token。
  console.error('[manual-news-leads-api] internal request failure', {
    error: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? sanitizedFailureMessage(error.message) : '',
  });
  return response({ ok: false, error: 'internal_error' }, 500);
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function authorized(request: Request, env: Env): boolean {
  const secret = newsReviewSecret(env);
  const header = request.headers.get('Authorization') || '';
  return !!secret && header.startsWith('Bearer ') && constantTimeEqual(header.slice(7), secret);
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.getUTCFullYear() === Number(match[1])
    && parsed.getUTCMonth() === Number(match[2]) - 1
    && parsed.getUTCDate() === Number(match[3]);
}

function idempotencyKey(request: Request): string | null {
  const key = (request.headers.get('Idempotency-Key') || '').trim();
  return /^[A-Za-z0-9._:-]{6,128}$/.test(key) ? key : null;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BODY_BYTES) throw new Error('request_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error('request_too_large');
  let parsed: unknown;
  try { parsed = JSON.parse(text) as unknown; } catch { throw new Error('invalid_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_json');
  return parsed as Record<string, unknown>;
}

async function handleManualNewsLeadsApiInternal(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  now = Date.now(),
): Promise<Response> {
  if (!authorized(request, env)) return response({ ok: false, error: 'unauthorized' }, 401);
  if (env.DAILY_NEWS_REVIEW_ENABLED !== undefined && env.DAILY_NEWS_REVIEW_ENABLED !== '1') {
    return response({ ok: false, error: 'news_review_disabled' }, 503);
  }
  const url = new URL(request.url);
  const suffix = url.pathname.slice(BASE_PATH.length);
  if (!url.pathname.startsWith(BASE_PATH) || (suffix && !suffix.startsWith('/'))) {
    return response({ ok: false, error: 'not_found' }, 404);
  }

  if (!suffix) {
    if (request.method === 'GET') {
      const date = url.searchParams.get('date') || '';
      if (!validCalendarDate(date)) return response({ ok: false, error: 'invalid_review_date' }, 400);
      const recovered = processingDependenciesAvailable(env)
        ? await recoverStaleManualNewsLeads(env, date, now)
        : [];
      for (const lead of recovered) scheduleLeadProcessing(env, ctx, lead);
      // 一步录入那条路的兜底：整条 workflow 都没了时，这里直接把线索补进候选池。
      if (signingKeysAvailable(env)) await scheduleStaleContentEntries(env, ctx, date, now);
      const [leads, candidateBatch, authorizations] = await Promise.all([
        listManualNewsLeads(env, date),
        getManualNewsLeadCandidateState(env, date),
        listManualNewsCandidateAuthorizations(env, date),
      ]);
      return response({
        ok: true,
        response_profile: 'manual_news_leads_summary_v1',
        schema_version: 1,
        date,
        leads: leads.slice(0, 50).map((lead) => manualNewsLeadSummary(lead, authorizations.get(lead.id))),
        candidate_batch: candidateBatch,
      });
    }
    if (request.method !== 'POST') return response({ ok: false, error: 'method_not_allowed' }, 405);
    const key = idempotencyKey(request);
    if (!key) return response({ ok: false, error: 'invalid_idempotency_key' }, 400);
    try {
      const body = await jsonBody(request);
      if ('owner_asserted' in body && typeof body.owner_asserted !== 'boolean') {
        throw new Error('invalid_owner_asserted');
      }
      if (body.owner_asserted === true) {
        // 一步录入：提交这一步只建线索行就返回（202），内容加工与随后的签名入池都在后台
        // 跑。候选的标题与摘要由模型从抓回的正文写出来，而它们进的是被签名覆盖的投影 ——
        // 签名之前就得确定，所以入池只能等加工跑完（规格第 1 / 8 节）。
        // 签名密钥这时候就要查：后台那一半必定要签名，缺密钥就别先把线索建出来。
        if (!signingKeysAvailable(env)) return response({ ok: false, error: 'dependency_unavailable' }, 503);
        const begun = await beginOwnerAssertedEntry(env, {
          date: body.date,
          text: body.text,
          url: body.url,
          note: body.note,
          ...('statement' in body ? { statement: body.statement } : {}),
        }, key, now);
        if (!begun.ok) {
          return response(await manualNewsMutationResult(env, begun), begun.status);
        }
        if (begun.created) {
          scheduleContentEntry(env, ctx, {
            id: begun.lead.id,
            review_date: begun.lead.review_date,
            input_url: begun.lead.input_url,
            input_text: begun.lead.input_text,
            note: begun.lead.note,
            submit_idempotency_key: key,
          }, now);
        }
        return response({
          ok: true,
          created: begun.created,
          lead: await manualNewsLeadDetail(env, begun.lead),
        }, begun.created ? 202 : 200);
      }
      if (!processingDependenciesAvailable(env)) {
        return response({ ok: false, error: 'dependency_unavailable' }, 503);
      }
      if ('candidate_authorization' in body
        && body.candidate_authorization !== MANUAL_NEWS_SOURCE_SUPPORT_POLICY) {
        throw new Error('invalid_candidate_authorization');
      }
      const result = await submitManualNewsLead(env, {
        date: body.date,
        text: body.text,
        url: body.url,
        note: body.note,
        ...('candidate_authorization' in body
          ? { candidate_authorization: body.candidate_authorization }
          : {}),
      }, key, now);
      if (result.created) scheduleLeadProcessing(env, ctx, result.lead);
      return response({
        ok: true, created: result.created, lead: await manualNewsLeadDetail(env, result.lead),
      }, result.created ? 202 : 200);
    } catch (error) {
      return requestErrorResponse(error);
    }
  }

  const match = /^\/(ml-\d{8}-[a-f0-9]{12})(?:\/(retry|confirm-candidate|vouch-candidate))?$/.exec(suffix);
  if (!match) return response({ ok: false, error: 'not_found' }, 404);
  const [, leadId, action] = match;
  if (!action) {
    if (request.method !== 'GET') return response({ ok: false, error: 'method_not_allowed' }, 405);
    const lead = await getManualNewsLead(env, leadId);
    return lead
      ? response({ ok: true, lead: await manualNewsLeadDetail(env, lead) })
      : response({ ok: false, error: 'manual_news_lead_not_found' }, 404);
  }
  if (request.method !== 'POST') return response({ ok: false, error: 'method_not_allowed' }, 405);
  const key = idempotencyKey(request);
  if (!key) return response({ ok: false, error: 'invalid_idempotency_key' }, 400);
  let body: Record<string, unknown>;
  try {
    body = await jsonBody(request);
  } catch (error) {
    return requestErrorResponse(error);
  }
  const expectedVersion = Number(body.expected_version);
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    return response({ ok: false, error: 'invalid_expected_version' }, 400);
  }
  if (action === 'retry') {
    if (!processingDependenciesAvailable(env)) return response({ ok: false, error: 'dependency_unavailable' }, 503);
    const result = await retryManualNewsLead(env, leadId, expectedVersion, key, now);
    if (!result.ok) return response(await manualNewsMutationResult(env, result), result.status);
    if (result.changed) scheduleLeadProcessing(env, ctx, result.lead);
    return response(await manualNewsMutationResult(env, result), result.changed ? 202 : 200);
  }
  const expectedBatchRevision = Number(body.expected_batch_revision);
  if (!Number.isInteger(expectedBatchRevision) || expectedBatchRevision < 0) {
    return response({ ok: false, error: 'invalid_expected_batch_revision' }, 400);
  }
  const result = action === 'vouch-candidate'
    ? await vouchManualNewsLeadCandidate(
      env, leadId, expectedVersion, expectedBatchRevision, body.statement, key, now,
    )
    : await confirmManualNewsLeadCandidate(
      env, leadId, expectedVersion, expectedBatchRevision, key, now,
    );
  // 只给担保这条路补素材：确认走的是取证跑完的线索，它的摘要本来就是核验过的正文。
  if (action === 'vouch-candidate') scheduleLeadEnrichment(env, ctx, result);
  return result.ok
    ? response(await manualNewsMutationResult(env, result))
    : response(await manualNewsMutationResult(env, result), result.status);
}

export async function handleManualNewsLeadsApi(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, 'waitUntil'>,
  now = Date.now(),
): Promise<Response> {
  try {
    return await handleManualNewsLeadsApiInternal(request, env, ctx, now);
  } catch (error) {
    return requestErrorResponse(error);
  }
}
