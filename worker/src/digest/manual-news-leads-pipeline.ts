import {
  applyManualLeadEvidencePolicy,
  assertManualLeadTransition,
  buildManualLeadAssessmentPrompt,
  classifyManualLeadDuplicate,
  validateManualLeadAssessment,
  validateManualNewsLeadInput,
  type ManualNewsEvidence,
  type ManualNewsLeadAssessment,
  type ManualNewsLeadStatus,
} from './manual-news-leads';
import type { PublicDocument } from '../security/safe-url-fetch';

export type ProcessedManualLeadAssessment = ManualNewsLeadAssessment & {
  evidence_tier: 'official_primary' | 'original_plus_independent' | 'multi_source' | 'insufficient';
  duplicate_scope?: 'same_day' | 'cross_day' | null;
  matched_lead_id?: string | null;
};

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
  assessment: ProcessedManualLeadAssessment | null;
  evidence: ManualNewsEvidence[];
  confirmed_batch_id: string | null;
  confirmed_at: number | null;
  created_at: number;
  updated_at: number;
}

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
  transition(
    id: string,
    from: ManualNewsLeadStatus,
    to: ManualNewsLeadStatus,
    patch?: Partial<Pick<ManualNewsLeadRecord, 'error_code' | 'error_message'>>,
  ): Promise<ManualNewsLeadRecord>;
  replaceEvidence(id: string, evidence: readonly ManualNewsEvidence[]): Promise<void>;
  listPriorEvents(date: string, eventKey?: string): Promise<Array<{ event_key: string; review_date: string; lead_id: string }>>;
  saveAssessment(id: string, assessment: ProcessedManualLeadAssessment): Promise<void>;
}

export interface ManualLeadProcessingAdapters {
  search(input: { date: string; text: string; note: string }): Promise<ManualSearchResult[]>;
  fetch(url: string): Promise<PublicDocument>;
  extract(document: PublicDocument, hint?: ManualSearchResult): Promise<ManualNewsEvidence | null>;
  assess(prompt: { system: string; user: string }): Promise<unknown>;
}

function conciseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').slice(0, 500);
}

export async function processManualNewsLead(
  leadId: string,
  store: ManualLeadProcessingStore,
  adapters: ManualLeadProcessingAdapters,
): Promise<ManualNewsLeadRecord> {
  let lead = await store.getLead(leadId);
  if (!lead) throw new Error('manual_news_lead_not_found');
  let status = lead.status;
  if (!PROCESSABLE_STATUSES.has(status)) throw new Error(`lead_not_processable:${status}`);
  const transition = async (
    to: ManualNewsLeadStatus,
    patch: Partial<Pick<ManualNewsLeadRecord, 'error_code' | 'error_message'>> = {},
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
      for (const source of sources) {
        try {
          const document = await adapters.fetch(source.url);
          const extracted = await adapters.extract(document, source.hint);
          if (extracted && !evidence.some((item) => item.id === extracted.id)) evidence.push(extracted);
        } catch {
          // A single bad source is evidence failure, not authority to downgrade or
          // fabricate the remaining sources. The final evidence gate decides.
        }
      }
      await store.replaceEvidence(leadId, evidence);
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
        await transition('needs_review', {
          error_code: 'evidence_insufficient',
          error_message: '核验阶段缺少持久化证据，请重试并补充来源。',
        });
        return (await store.getLead(leadId))!;
      }
      const priorEvents = await store.listPriorEvents(normalized.date);
      const prompt = buildManualLeadAssessmentPrompt({
        date: normalized.date,
        text: normalized.text,
        note: normalized.note,
        evidence,
        prior_events: priorEvents,
      });
      try {
        const raw = await adapters.assess(prompt);
        assessment = applyManualLeadEvidencePolicy(validateManualLeadAssessment(raw, evidence), evidence);
      } catch (error) {
        await transition('failed', {
          error_code: 'assessment_validation_failed',
          error_message: conciseError(error),
        });
        return (await store.getLead(leadId))!;
      }
      await store.saveAssessment(leadId, assessment);
      await transition('clustering');
    }

    if (!assessment) throw new Error(`assessment_missing:${status}`);
    if (status === 'clustering') {
      const priorEvents = await store.listPriorEvents(normalized.date);
      const duplicate = classifyManualLeadDuplicate(assessment, priorEvents, normalized.date);
      if (duplicate.duplicate || assessment.recommendation === 'duplicate') {
        assessment = {
          ...assessment,
          recommendation: 'duplicate',
          duplicate_scope: duplicate.scope,
          matched_lead_id: duplicate.matched_lead_id,
        };
        await store.saveAssessment(leadId, assessment);
        await transition('duplicate');
        return (await store.getLead(leadId))!;
      }

      assessment = {
        ...assessment,
        duplicate_scope: null,
        matched_lead_id: duplicate.matched_lead_id,
      };
      await store.saveAssessment(leadId, assessment);
      await transition('scored');
    }
    if (status !== 'scored') throw new Error(`lead_not_scoreable:${status}`);
    await transition(assessment.recommendation);
    return (await store.getLead(leadId))!;
  } catch (error) {
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
