import {
  applyManualLeadEvidencePolicy,
  assertManualLeadTransition,
  buildManualLeadAssessmentPrompt,
  buildManualLeadAssessmentRegenerationPrompt,
  buildManualLeadFactVerificationPrompt,
  classifyManualLeadDuplicate,
  manualLeadAssessmentValidationFailure,
  manualLeadFactVerificationErrorCode,
  missingManualLeadEvidenceAnchors,
  isRegeneratableManualLeadAssessmentValidationCode,
  MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
  MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
  MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
  MANUAL_LEAD_SOURCE_FACT_CONTRACT,
  MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
  validateManualLeadGeneratedAssessment,
  validateManualLeadFactVerification,
  validateManualNewsProcessedAssessment,
  validateManualNewsLeadInput,
  type ManualNewsEvidence,
  type ManualNewsLeadAssessment,
  type ManualNewsLeadStatus,
  type ManualLeadPriorEvent,
  type ManualNewsProcessedAssessment,
  type ManualNewsAssessmentGenerationAudit,
} from './manual-news-leads';
import type { PublicDocument } from '../security/safe-url-fetch';
import {
  isManualNewsProviderJsonParseFailure,
  isTransientManualNewsProviderFailure,
  manualNewsProviderFailureAudit,
  manualNewsProviderPublicErrorMessage,
  withManualNewsAssessmentFailureContext,
  type ManualNewsProviderCallContext,
  type ManualNewsProviderFailureAudit,
  type ManualNewsProviderStage,
} from './manual-news-provider';

export type ProcessedManualLeadAssessment = ManualNewsProcessedAssessment;

export interface ManualNewsLeadRecord {
  id: string;
  review_date: string;
  input_type: 'text' | 'url' | 'text_url';
  input_text: string;
  input_url: string;
  note: string;
  status: ManualNewsLeadStatus;
  version: number;
  error_code: string | null;
  error_message: string | null;
  assessment_generation?: ManualNewsAssessmentGenerationAudit;
  provider_failure?: ManualNewsProviderFailureAudit;
  processing_owner: string | null;
  processing_attempt: number;
  processing_lease_until: number | null;
  assessment: ProcessedManualLeadAssessment | null;
  evidence: ManualNewsEvidence[];
  confirmed_batch_id: string | null;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
}

export type ManualNewsLeadSummary = Omit<ManualNewsLeadRecord,
  'assessment_generation' | 'provider_failure' | 'assessment' | 'evidence'> & {
    evidence_count: number;
  };

export interface ManualSearchResult {
  url: string;
  title: string;
  snippet: string;
  source_type?: ManualNewsEvidence['source_type'];
  publisher?: string;
  published_at?: string | null;
  reliable?: boolean;
}

export interface ManualLeadProcessingStore {
  getLead(id: string): Promise<ManualNewsLeadRecord | null>;
  hasPersistedAssessment(id: string): Promise<boolean>;
  transition(
    id: string,
    from: ManualNewsLeadStatus,
    to: ManualNewsLeadStatus,
    patch?: ManualLeadTransitionPatch,
  ): Promise<ManualNewsLeadRecord>;
  replaceEvidence(id: string, expectedVersion: number, evidence: readonly ManualNewsEvidence[]): Promise<void>;
  listRecentPriorEvents(date: string, excludeLeadId: string): Promise<ManualLeadPriorEvent[]>;
  findPriorEventsByEventKey(eventKey: string, excludeLeadId: string): Promise<ManualLeadPriorEvent[]>;
  saveVerifiedAssessment(
    id: string,
    expectedVersion: number,
    assessment: ProcessedManualLeadAssessment,
    verification: unknown,
  ): Promise<{ assessment_version: number }>;
  invalidateAssessment(id: string, expectedVersion: number, reason: string): Promise<void>;
  beginAssessmentGenerationCycle(
    id: string,
    expectedVersion: number,
  ): Promise<ManualAssessmentGenerationCycleState>;
  recordAssessmentGenerationValidation(
    id: string,
    expectedVersion: number,
    result: ManualAssessmentGenerationValidationResult,
  ): Promise<ManualAssessmentGenerationCycleState>;
  consumeAssessmentRegeneration(
    id: string,
    expectedVersion: number,
  ): Promise<ManualAssessmentGenerationCycleState>;
}

export interface ManualAssessmentGenerationCycleState {
  cycle_id: string;
  base_version: number;
  generation_revision: 1 | 2;
  call_state: 'initial_started' | 'regeneration_ready' | 'regeneration_started' | 'validated' | 'terminal';
  acquired_call: boolean;
  first_validation_code?: string;
  first_validation_path?: string;
  last_validation_code?: string;
  last_validation_path?: string;
  regeneration_consumed: boolean;
  validated_assessment?: ProcessedManualLeadAssessment;
  provider_failure?: ManualNewsProviderFailureAudit;
}

export interface ManualAssessmentGenerationValidationResult {
  generation_revision: 1 | 2;
  validation_code: string;
  validation_path?: string;
  regeneratable: boolean;
  validated_assessment?: ProcessedManualLeadAssessment;
  provider_failure?: ManualNewsProviderFailureAudit;
}

export interface ManualLeadTransitionPatch
  extends Partial<Pick<ManualNewsLeadRecord, 'error_code' | 'error_message'>> {
  audit_metadata?: {
    assessment_generation_attempts?: 1 | 2;
    assessment_first_validation_code?: string;
    assessment_first_validation_path?: string;
    assessment_last_validation_code?: string;
    assessment_last_validation_path?: string;
    assessment_regeneration_trigger_code?: string;
    assessment_regeneration_trigger_path?: string;
    assessment_claim_contract: typeof MANUAL_LEAD_GENERATED_CLAIM_CONTRACT;
    assessment_source_fact_contract: typeof MANUAL_LEAD_SOURCE_FACT_CONTRACT;
    assessment_editorial_projection_contract: typeof MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT;
    assessment_evidence_disposition_contract: typeof MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT;
    assessment_verification_policy: typeof MANUAL_LEAD_VERIFICATION_POLICY_VERSION;
    assessment_recovery?: 'persisted_verified';
    provider_failure?: ManualNewsProviderFailureAudit;
  };
}

function manualLeadContractAuditMetadata() {
  return {
    assessment_claim_contract: MANUAL_LEAD_GENERATED_CLAIM_CONTRACT,
    assessment_source_fact_contract: MANUAL_LEAD_SOURCE_FACT_CONTRACT,
    assessment_editorial_projection_contract: MANUAL_LEAD_EDITORIAL_PROJECTION_CONTRACT,
    assessment_evidence_disposition_contract: MANUAL_LEAD_EVIDENCE_DISPOSITION_CONTRACT,
    assessment_verification_policy: MANUAL_LEAD_VERIFICATION_POLICY_VERSION,
  } as const;
}

function assessmentGenerationAuditMetadata(input: {
  attempts: 1 | 2;
  first: { code: string; path?: string };
  last: { code: string; path?: string };
  trigger?: { code: string; path?: string };
}): NonNullable<ManualLeadTransitionPatch['audit_metadata']> {
  return {
    assessment_generation_attempts: input.attempts,
    assessment_first_validation_code: input.first.code,
    ...(input.first.path ? { assessment_first_validation_path: input.first.path } : {}),
    assessment_last_validation_code: input.last.code,
    ...(input.last.path ? { assessment_last_validation_path: input.last.path } : {}),
    ...(input.trigger ? {
      assessment_regeneration_trigger_code: input.trigger.code,
      ...(input.trigger.path
        ? { assessment_regeneration_trigger_path: input.trigger.path }
        : {}),
    } : {}),
    ...manualLeadContractAuditMetadata(),
  };
}

function assessmentGenerationAuditFromCycle(
  cycle: ManualAssessmentGenerationCycleState,
): NonNullable<ManualLeadTransitionPatch['audit_metadata']> {
  const attempts = cycle.regeneration_consumed ? 2 : 1;
  const first = {
    code: cycle.first_validation_code || 'not_validated',
    ...(cycle.first_validation_path ? { path: cycle.first_validation_path } : {}),
  };
  const last = {
    code: cycle.last_validation_code || first.code,
    ...(cycle.last_validation_path ? { path: cycle.last_validation_path } : {}),
  };
  return assessmentGenerationAuditMetadata({
    attempts,
    first,
    last,
    ...(attempts === 2 ? { trigger: first } : {}),
  });
}

export interface ManualLeadProcessingAdapters {
  search(input: { date: string; text: string; note: string }): Promise<ManualSearchResult[]>;
  fetch(url: string): Promise<PublicDocument>;
  extract(document: PublicDocument, hint?: ManualSearchResult): Promise<ManualNewsEvidence | null>;
  assess(prompt: { system: string; user: string }, context?: ManualNewsProviderCallContext): Promise<unknown>;
  verify(prompt: { system: string; user: string }, context?: ManualNewsProviderCallContext): Promise<unknown>;
}

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 500);
}

export function isTransientManualLeadError(error: unknown): boolean {
  const providerTransient = isTransientManualNewsProviderFailure(error);
  if (providerTransient !== null) return providerTransient;
  const message = conciseError(error).trim();
  const stableCode = message.split(':', 1)[0].toLowerCase();
  if (isRegeneratableManualLeadAssessmentValidationCode(stableCode)
    || stableCode === 'non_atomic_fact'
    || stableCode === 'json_parse_fail') {
    return false;
  }

  const errorName = error instanceof Error ? error.name : '';
  if (['AbortError', 'TimeoutError', 'TypeError'].includes(errorName)
    || /^(?:AbortError|TimeoutError|TypeError)$/i.test(message)) {
    return true;
  }
  if (/^HTTP (?:408|429|5\d\d)$/i.test(message)) return true;
  if (/^(?:429|5\d\d)$/.test(message)) return true;
  if (/^assessment_model_retryable_attempt_[12]_after_[a-z0-9_]+$/i.test(message)) return true;
  if (/^(?:no_text|empty_model_assessment|exhausted_retries)$/i.test(message)) return true;
  if (/(?:^|:)(?:trusted_gateway_http_(?:408|429|5\d\d)|model_gateway_(?:408|429|5\d\d)|gateway_timeout)(?:$|[:\s])/i
    .test(message)) return true;
  if (/(?:^|:)(?:d1|sqlite|database)(?:$|[_:\s])/i.test(message)) return true;
  if (/(?:^|:)(?:network|fetch)(?:_|\s)(?:error|failed|failure)(?:$|[:\s])/i.test(message)) return true;
  return /\b(?:timed out|request timeout|connection timeout|temporarily unavailable|service unavailable)\b/i
    .test(message);
}

function isDeterministicModelJsonError(error: unknown): boolean {
  return isManualNewsProviderJsonParseFailure(error)
    || /(?:^|_)json_parse_fail(?:$|_)/i.test(conciseError(error));
}

function deterministicJsonFailureMessage(
  error: unknown,
  stage: ManualNewsProviderStage,
): string {
  return manualNewsProviderPublicErrorMessage(error)
    || `manual_news_provider_error:${stage}:provider_json_parse_fail`;
}

function safeProviderOrConciseError(error: unknown): string {
  return manualNewsProviderPublicErrorMessage(error) || conciseError(error);
}

function auditMetadataWithProviderFailure(
  metadata: ManualLeadTransitionPatch['audit_metadata'],
  error: unknown,
): ManualLeadTransitionPatch['audit_metadata'] {
  const providerFailure = manualNewsProviderFailureAudit(error);
  return providerFailure && metadata ? { ...metadata, provider_failure: providerFailure } : metadata;
}

async function finalizeManualLeadAssessment(
  leadId: string,
  reviewDate: string,
  assessment: ManualNewsLeadAssessment & { evidence_tier: ManualNewsProcessedAssessment['evidence_tier'] },
  store: ManualLeadProcessingStore,
): Promise<ProcessedManualLeadAssessment> {
  const priorEvents = await store.findPriorEventsByEventKey(assessment.event_key, leadId);
  const duplicate = classifyManualLeadDuplicate(assessment, priorEvents, reviewDate);
  if (duplicate.duplicate) {
    return {
      ...assessment,
      recommendation: 'duplicate',
      duplicate_scope: duplicate.scope,
      matched_lead_id: duplicate.matched_lead_id,
      matched_event_key: duplicate.matched_lead_id ? assessment.event_key : assessment.matched_event_key,
    };
  }
  const exactMatch = !!duplicate.matched_lead_id;
  const advisoryDuplicate = assessment.recommendation === 'duplicate';
  const unmatchedMaterialUpdate = assessment.material_update && !exactMatch;
  return {
    ...assessment,
    material_update: unmatchedMaterialUpdate ? false : assessment.material_update,
    recommendation: advisoryDuplicate || unmatchedMaterialUpdate ? 'needs_review' : assessment.recommendation,
    uncertainties: unmatchedMaterialUpdate
      ? [...assessment.uncertainties, '未找到可对应的既有事件，重要更新标记已转为人工复核。']
      : assessment.uncertainties,
    duplicate_scope: null,
    matched_lead_id: duplicate.matched_lead_id,
    matched_event_key: exactMatch ? assessment.event_key : null,
  };
}

export async function processManualNewsLead(
  leadId: string,
  store: ManualLeadProcessingStore,
  adapters: ManualLeadProcessingAdapters,
): Promise<ManualNewsLeadRecord> {
  let lead = await store.getLead(leadId);
  if (!lead) throw new Error('manual_news_lead_not_found');
  let status = lead.status;
  let assessmentGenerationAudit: ManualLeadTransitionPatch['audit_metadata'];
  let providerCallSequence = 0;
  const providerCallContext = (
    stage: ManualNewsProviderStage,
    evidenceCount: number,
  ): ManualNewsProviderCallContext => {
    providerCallSequence += 1;
    return {
      request_id: `${leadId}:p${lead!.processing_attempt}:${stage}:${providerCallSequence}`,
      evidence_count: evidenceCount,
      attempt: lead!.processing_attempt,
    };
  };
  if (!PROCESSABLE_STATUSES.has(status)) throw new Error(`lead_not_processable:${status}`);
  const transition = async (
    to: ManualNewsLeadStatus,
    patch: ManualLeadTransitionPatch = {},
  ) => {
    assertManualLeadTransition(status, to);
    lead = await store.transition(leadId, status, to, patch);
    status = to;
  };

  try {
    if (status === 'submitted') await transition('validating');
    const normalized = validateManualNewsLeadInput({
      date: lead.review_date,
      text: lead.input_text,
      url: lead.input_url,
      note: lead.note,
    });
    if (status === 'validating') await transition('researching', { error_code: null, error_message: null });

    if (status === 'researching' || status === 'extracting') {
      // A Workflow retry may resume after either transition. Search is deliberately
      // repeated because its bounded results are not authoritative evidence yet.
      const searchResults = normalized.text
        ? await adapters.search({ date: normalized.date, text: normalized.text, note: normalized.note })
        : [];
      const sources: Array<{ url: string; hint?: ManualSearchResult }> = [];
      if (normalized.url) sources.push({ url: normalized.url });
      for (const result of searchResults) {
        if (!sources.some((source) => source.url === result.url)) sources.push({ url: result.url, hint: result });
        if (sources.length >= 8) break;
      }
      if (status === 'researching') await transition('extracting');
      const evidence: ManualNewsEvidence[] = [];
      let transientSourceError: unknown = null;
      for (const source of sources) {
        try {
          const document = await adapters.fetch(source.url);
          const extracted = await adapters.extract(document, source.hint);
          if (extracted && !evidence.some((item) => item.id === extracted.id)) evidence.push(extracted);
        } catch (error) {
          if (isTransientManualLeadError(error)) transientSourceError = error;
          // A single bad source is evidence failure, not authority to downgrade or
          // fabricate the remaining sources. The final evidence gate decides.
        }
      }
      if (!evidence.length && transientSourceError) throw transientSourceError;
      await store.replaceEvidence(leadId, lead.version, evidence);
      if (!evidence.length) {
        await transition('needs_review', {
          error_code: 'evidence_insufficient',
          error_message: '未取得可核验的一手或独立证据，请补充链接后重试。',
        });
        return (await store.getLead(leadId))!;
      }
      await transition('verifying');
    }

    let assessment = lead.assessment;
    if (status === 'verifying') {
      const evidence = lead.evidence;
      if (!evidence.length) {
        await store.invalidateAssessment(leadId, lead.version, 'evidence_missing');
        assessment = null;
        await transition('needs_review', {
          error_code: 'evidence_insufficient',
          error_message: '核验阶段缺少持久化证据，请重试并补充来源。',
        });
        return (await store.getLead(leadId))!;
      }
      if (missingManualLeadEvidenceAnchors(normalized.text, evidence).length) {
        await store.invalidateAssessment(leadId, lead.version, 'anchor_missing');
        assessment = null;
        await transition('needs_review', {
          error_code: 'evidence_relevance_unverified',
          error_message: 'high_confidence_anchor_missing',
        });
        return (await store.getLead(leadId))!;
      }
      if (!assessment && await store.hasPersistedAssessment(leadId)) {
        await store.invalidateAssessment(leadId, lead.version, 'persisted_verification_invalid');
      }
      const priorEvents = await store.listRecentPriorEvents(normalized.date, leadId);
      if (assessment) {
        try {
          assessment = validateManualNewsProcessedAssessment(assessment, evidence);
        } catch {
          await store.invalidateAssessment(leadId, lead.version, 'persisted_assessment_invalid');
          assessment = null;
        }
      }
      if (!assessment) {
        const promptInput = {
          date: normalized.date,
          text: normalized.text,
          note: normalized.note,
          evidence,
          prior_events: priorEvents,
        };
        let cycle = await store.beginAssessmentGenerationCycle(leadId, lead.version);
        let finalizedAssessment: ProcessedManualLeadAssessment | null = null;
        if (cycle.call_state === 'validated' && cycle.validated_assessment) {
          finalizedAssessment = validateManualNewsProcessedAssessment(
            cycle.validated_assessment, evidence, priorEvents.map((event) => event.event_key),
          );
          assessmentGenerationAudit = assessmentGenerationAuditFromCycle(cycle);
        } else {
          let prompt: { system: string; user: string } | null = null;
          let generationRevision: 1 | 2;
          if (cycle.call_state === 'initial_started') {
            generationRevision = 1;
            if (cycle.acquired_call) {
              prompt = buildManualLeadAssessmentPrompt(promptInput);
            }
          } else if (cycle.call_state === 'regeneration_ready') {
            cycle = await store.consumeAssessmentRegeneration(leadId, lead.version);
            generationRevision = 2;
            if (cycle.acquired_call) {
              prompt = buildManualLeadAssessmentRegenerationPrompt(
                promptInput,
                cycle.first_validation_code || 'assessment_validation_failed',
                cycle.first_validation_path,
              );
            }
          } else {
            generationRevision = cycle.generation_revision;
          }

          while (!finalizedAssessment) {
            if (!prompt) {
              cycle = await store.recordAssessmentGenerationValidation(leadId, lead.version, {
                generation_revision: generationRevision,
                validation_code: 'not_validated',
                regeneratable: false,
              });
              assessmentGenerationAudit = assessmentGenerationAuditFromCycle(cycle);
              await store.invalidateAssessment(leadId, lead.version, 'assessment_generation_indeterminate');
              await transition('needs_review', {
                error_code: 'assessment_validation_failed',
                error_message: 'assessment_generation_indeterminate',
                audit_metadata: assessmentGenerationAudit,
              });
              return (await store.getLead(leadId))!;
            }
            let raw: unknown;
            try {
              raw = await adapters.assess(prompt, providerCallContext('assessment', evidence.length));
            } catch (error) {
              const failureCode = isDeterministicModelJsonError(error) ? 'invalid_assessment' : 'not_validated';
              const contextualError = withManualNewsAssessmentFailureContext(
                error, generationRevision, failureCode,
              );
              cycle = await store.recordAssessmentGenerationValidation(leadId, lead.version, {
                generation_revision: generationRevision,
                validation_code: failureCode,
                regeneratable: false,
                ...(manualNewsProviderFailureAudit(contextualError)
                  ? { provider_failure: manualNewsProviderFailureAudit(contextualError)! }
                  : {}),
              });
              assessmentGenerationAudit = auditMetadataWithProviderFailure(
                assessmentGenerationAuditFromCycle(cycle), contextualError,
              );
              await store.invalidateAssessment(leadId, lead.version, 'assessment_provider_failed');
              const recoverableOrIndeterminate = isDeterministicModelJsonError(error)
                || isTransientManualLeadError(contextualError);
              await transition(recoverableOrIndeterminate ? 'needs_review' : 'failed', {
                error_code: recoverableOrIndeterminate ? 'assessment_validation_failed' : 'assessment_failed',
                error_message: isDeterministicModelJsonError(error)
                  ? deterministicJsonFailureMessage(contextualError, 'assessment')
                  : (manualNewsProviderPublicErrorMessage(contextualError)
                    || (recoverableOrIndeterminate
                      ? 'assessment_generation_provider_failed'
                      : safeProviderOrConciseError(contextualError))),
                audit_metadata: assessmentGenerationAudit,
              });
              return (await store.getLead(leadId))!;
            }
            let validatedCore: ManualNewsLeadAssessment;
            try {
              validatedCore = validateManualLeadGeneratedAssessment(
                raw, evidence, priorEvents.map((event) => event.event_key),
              );
            } catch (error) {
              const validationFailure = manualLeadAssessmentValidationFailure(error);
              const regeneratable = generationRevision === 1
                && isRegeneratableManualLeadAssessmentValidationCode(validationFailure.code);
              cycle = await store.recordAssessmentGenerationValidation(leadId, lead.version, {
                generation_revision: generationRevision,
                validation_code: validationFailure.code,
                ...(validationFailure.path ? { validation_path: validationFailure.path } : {}),
                regeneratable,
              });
              if (regeneratable) {
                cycle = await store.consumeAssessmentRegeneration(leadId, lead.version);
                generationRevision = 2;
                prompt = cycle.acquired_call
                  ? buildManualLeadAssessmentRegenerationPrompt(
                    promptInput, validationFailure.code, validationFailure.path,
                  )
                  : null;
                continue;
              }
              assessmentGenerationAudit = assessmentGenerationAuditFromCycle(cycle);
              await store.invalidateAssessment(leadId, lead.version, 'assessment_schema_invalid');
              await transition('needs_review', {
                error_code: 'assessment_validation_failed',
                error_message: validationFailure.code,
                audit_metadata: assessmentGenerationAudit,
              });
              return (await store.getLead(leadId))!;
            }
            const validatedAssessment = applyManualLeadEvidencePolicy(validatedCore, evidence);
            finalizedAssessment = await finalizeManualLeadAssessment(
              leadId, normalized.date, validatedAssessment, store,
            );
            cycle = await store.recordAssessmentGenerationValidation(leadId, lead.version, {
              generation_revision: generationRevision,
              validation_code: 'valid',
              regeneratable: false,
              validated_assessment: finalizedAssessment,
            });
            assessmentGenerationAudit = assessmentGenerationAuditFromCycle(cycle);
          }
        }
        if (!finalizedAssessment) throw new Error('assessment_generation_state_invalid');
        let verificationRaw: unknown;
        try {
          verificationRaw = await adapters.verify(
            buildManualLeadFactVerificationPrompt({
              assessment: finalizedAssessment,
              evidence,
              prior_events: priorEvents,
            }),
            providerCallContext('verification', evidence.length),
          );
        } catch (error) {
          if (isDeterministicModelJsonError(error)) {
            await store.invalidateAssessment(leadId, lead.version, 'fact_verification_schema_invalid');
            await transition('needs_review', {
              error_code: 'fact_verification_failed',
              error_message: deterministicJsonFailureMessage(error, 'verification'),
              ...(assessmentGenerationAudit ? {
                audit_metadata: auditMetadataWithProviderFailure(assessmentGenerationAudit, error),
              } : {}),
            });
            return (await store.getLead(leadId))!;
          }
          if (isTransientManualLeadError(error)) throw error;
          await store.invalidateAssessment(leadId, lead.version, 'fact_verification_model_failed');
          await transition('failed', {
            error_code: 'fact_verification_failed',
            error_message: safeProviderOrConciseError(error),
            ...(assessmentGenerationAudit ? {
              audit_metadata: auditMetadataWithProviderFailure(assessmentGenerationAudit, error),
            } : {}),
          });
          return (await store.getLead(leadId))!;
        }
        let verification;
        try {
          verification = validateManualLeadFactVerification(
            verificationRaw, finalizedAssessment, evidence, { prior_events: priorEvents },
          );
        } catch (error) {
          await store.invalidateAssessment(leadId, lead.version, 'fact_verification_schema_invalid');
          await transition('needs_review', {
            error_code: 'fact_verification_failed',
            error_message: manualLeadFactVerificationErrorCode(error),
            ...(assessmentGenerationAudit ? { audit_metadata: assessmentGenerationAudit } : {}),
          });
          return (await store.getLead(leadId))!;
        }
        if (verification.overall_verdict === 'unsupported') {
          const issueCode = verification.fact_results.find((item) => !item.supported)?.issue_code || 'unsupported';
          await store.invalidateAssessment(leadId, lead.version, `fact_${issueCode}`);
          await transition('needs_review', {
            error_code: 'fact_verification_failed',
            error_message: issueCode,
            ...(assessmentGenerationAudit ? { audit_metadata: assessmentGenerationAudit } : {}),
          });
          return (await store.getLead(leadId))!;
        }
        assessment = finalizedAssessment;
        await store.saveVerifiedAssessment(leadId, lead.version, assessment, verification);
      } else {
        assessmentGenerationAudit = {
          ...manualLeadContractAuditMetadata(),
          assessment_recovery: 'persisted_verified',
        };
      }
      await transition('clustering', assessmentGenerationAudit
        ? { audit_metadata: assessmentGenerationAudit }
        : {});
    }

    if (!assessment) throw new Error(`assessment_missing:${status}`);
    if (status === 'clustering') {
      if (assessment.recommendation === 'duplicate' && assessment.duplicate_scope !== null) {
        await transition('duplicate');
        return (await store.getLead(leadId))!;
      }
      await transition('scored');
    }
    if (status !== 'scored') throw new Error(`lead_not_scoreable:${status}`);
    await transition(assessment.recommendation);
    return (await store.getLead(leadId))!;
  } catch (error) {
    if (isTransientManualLeadError(error)) throw error;
    if (TRANSITION_TO_FAILED_FROM.has(status)) {
      await transition('failed', { error_code: 'processing_failed', error_message: conciseError(error) });
      return (await store.getLead(leadId))!;
    }
    throw error;
  }
}

const TRANSITION_TO_FAILED_FROM = new Set<ManualNewsLeadStatus>([
  'validating', 'researching', 'extracting', 'verifying', 'clustering', 'scored',
]);

const PROCESSABLE_STATUSES = new Set<ManualNewsLeadStatus>([
  'submitted', 'validating', 'researching', 'extracting', 'verifying', 'clustering', 'scored',
]);
