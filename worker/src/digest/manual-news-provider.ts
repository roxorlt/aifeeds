import type { DeepSeekSafeDiagnostics } from '../hf-paper/llm';

export type ManualNewsProviderStage = 'assessment' | 'verification';

export interface ManualNewsProviderCallContext {
  request_id: string;
  evidence_count: number;
  attempt: number;
}

export interface ManualNewsProviderCallMetrics extends ManualNewsProviderCallContext {
  stage: ManualNewsProviderStage;
  system_chars: number;
  user_chars: number;
}

export interface ManualNewsProviderFailureAudit extends ManualNewsProviderCallMetrics {
  provider_error_code: string;
  provider_diagnostics?: ManualNewsProviderDiagnostics;
  assessment_generation_attempt?: 1 | 2;
  assessment_last_validation_code?: string;
}

export interface ManualNewsProviderDiagnostics {
  finish_reason: DeepSeekSafeDiagnostics['finish_reason'];
  content_chars: number;
  reasoning_chars: number;
  usage: Pick<
    DeepSeekSafeDiagnostics['usage'],
    'prompt_tokens' | 'completion_tokens' | 'total_tokens' | 'reasoning_tokens'
  >;
}

interface ManualNewsProviderErrorInput {
  stage: ManualNewsProviderStage;
  provider_error_code: string;
  metrics: ManualNewsProviderCallMetrics;
  provider_diagnostics?: ManualNewsProviderDiagnostics;
  assessment_generation_attempt?: 1 | 2;
  assessment_last_validation_code?: string;
}

const SAFE_PROVIDER_ERROR = /^provider_(?:timeout|transport_error|no_text|empty_final|output_exhausted|capacity|json_parse_fail|prompt_too_large|retry_exhausted|unknown_error|http_\d{3})$/;
const SAFE_REQUEST_ID = /^[A-Za-z0-9:_-]{1,240}$/;
const SAFE_VALIDATION_CODE = /^[a-z0-9_]{1,80}$/;
const PROVIDER_ERROR_PREFIX = 'manual_news_provider_error';
const SAFE_FINISH_REASONS = new Set([
  'stop', 'length', 'content_filter', 'tool_calls', 'insufficient_system_resource', 'unknown',
]);

function validMetricCount(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= max;
}

function isValidProviderDiagnostics(value: unknown): value is ManualNewsProviderDiagnostics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some((key) => ![
    'finish_reason', 'content_chars', 'reasoning_chars', 'usage',
  ].includes(key))
    || !SAFE_FINISH_REASONS.has(String(row.finish_reason))
    || typeof row.content_chars !== 'number'
    || !validMetricCount(row.content_chars, 10_000_000)
    || typeof row.reasoning_chars !== 'number'
    || !validMetricCount(row.reasoning_chars, 10_000_000)
    || !row.usage || typeof row.usage !== 'object' || Array.isArray(row.usage)) return false;
  const usage = row.usage as Record<string, unknown>;
  const allowedUsage = new Set([
    'prompt_tokens', 'completion_tokens', 'total_tokens', 'reasoning_tokens',
  ]);
  return !Object.keys(usage).some((key) => !allowedUsage.has(key))
    && Object.values(usage).every((metric) => typeof metric === 'number'
      && validMetricCount(metric, 100_000_000));
}

export function manualNewsProviderDiagnostics(
  diagnostics: DeepSeekSafeDiagnostics | undefined,
): ManualNewsProviderDiagnostics | undefined {
  if (!diagnostics) return undefined;
  const usage: ManualNewsProviderDiagnostics['usage'] = {};
  for (const field of [
    'prompt_tokens', 'completion_tokens', 'total_tokens', 'reasoning_tokens',
  ] as const) {
    const value = diagnostics.usage[field];
    if (value !== undefined) usage[field] = value;
  }
  const safe: ManualNewsProviderDiagnostics = {
    finish_reason: diagnostics.finish_reason,
    content_chars: diagnostics.content_chars,
    reasoning_chars: diagnostics.reasoning_chars,
    usage,
  };
  return isValidProviderDiagnostics(safe) ? safe : undefined;
}

export function isValidManualNewsProviderFailureAudit(
  value: unknown,
): value is ManualNewsProviderFailureAudit {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const allowed = new Set([
    'stage', 'provider_error_code', 'request_id', 'system_chars', 'user_chars',
    'evidence_count', 'attempt', 'assessment_generation_attempt',
    'assessment_last_validation_code', 'provider_diagnostics',
  ]);
  return !Object.keys(row).some((key) => !allowed.has(key))
    && ['assessment', 'verification'].includes(String(row.stage))
    && SAFE_PROVIDER_ERROR.test(String(row.provider_error_code || ''))
    && SAFE_REQUEST_ID.test(String(row.request_id || ''))
    && validMetricCount(Number(row.system_chars), 2_000_000)
    && validMetricCount(Number(row.user_chars), 4_000_000)
    && validMetricCount(Number(row.evidence_count), 100)
    && validMetricCount(Number(row.attempt), 1_000_000)
    && (row.provider_diagnostics === undefined
      || isValidProviderDiagnostics(row.provider_diagnostics))
    && (row.assessment_generation_attempt === undefined
      || row.assessment_generation_attempt === 1
      || row.assessment_generation_attempt === 2)
    && (row.assessment_last_validation_code === undefined
      || SAFE_VALIDATION_CODE.test(String(row.assessment_last_validation_code)));
}

export class ManualNewsProviderError extends Error {
  readonly stage: ManualNewsProviderStage;
  readonly provider_error_code: string;
  readonly metrics: ManualNewsProviderCallMetrics;
  readonly provider_diagnostics?: ManualNewsProviderDiagnostics;
  readonly assessment_generation_attempt?: 1 | 2;
  readonly assessment_last_validation_code?: string;

  constructor(input: ManualNewsProviderErrorInput) {
    const audit: ManualNewsProviderFailureAudit = {
      ...input.metrics,
      stage: input.stage,
      provider_error_code: input.provider_error_code,
      ...(input.provider_diagnostics
        ? { provider_diagnostics: input.provider_diagnostics }
        : {}),
      ...(input.assessment_generation_attempt
        ? { assessment_generation_attempt: input.assessment_generation_attempt }
        : {}),
      ...(input.assessment_last_validation_code
        ? { assessment_last_validation_code: input.assessment_last_validation_code }
        : {}),
    };
    if (!isValidManualNewsProviderFailureAudit(audit)) {
      throw new Error('invalid_manual_news_provider_error');
    }
    // Workflow runtimes may deserialize a thrown subclass as a plain Error.
    // Carry only this validated, allowlisted diagnostic payload in the message
    // so the outer exhaustion handler can still recover stage/code/metrics.
    super(`${PROVIDER_ERROR_PREFIX}:${input.stage}:${input.provider_error_code}:${encodeURIComponent(JSON.stringify(audit))}`);
    this.name = 'ManualNewsProviderError';
    this.stage = input.stage;
    this.provider_error_code = input.provider_error_code;
    this.metrics = { ...input.metrics, stage: input.stage };
    this.provider_diagnostics = input.provider_diagnostics;
    this.assessment_generation_attempt = input.assessment_generation_attempt;
    this.assessment_last_validation_code = input.assessment_last_validation_code;
  }
}

export function stableManualNewsProviderErrorCode(raw: string | undefined): string {
  const value = String(raw || '').trim();
  if (/^(?:AbortError|TimeoutError)$/i.test(value)) return 'provider_timeout';
  if (/^TypeError$/i.test(value)) return 'provider_transport_error';
  const status = /^HTTP\s+(\d{3})$/i.exec(value)?.[1];
  if (status) return `provider_http_${status}`;
  if (value === 'no_text') return 'provider_no_text';
  if (value === 'json_parse_fail') return 'provider_json_parse_fail';
  if (value === 'exhausted_retries') return 'provider_retry_exhausted';
  return 'provider_unknown_error';
}

export function classifyManualNewsProviderErrorCode(
  raw: string | undefined,
  diagnostics: ManualNewsProviderDiagnostics | undefined,
): string {
  const rawCode = String(raw || '').trim();
  if (diagnostics?.finish_reason === 'insufficient_system_resource') return 'provider_capacity';
  if (diagnostics?.finish_reason === 'length'
    && (rawCode === 'no_text' || rawCode === 'json_parse_fail')) {
    return 'provider_output_exhausted';
  }
  if (diagnostics?.finish_reason === 'stop' && rawCode === 'no_text') {
    return 'provider_empty_final';
  }
  return stableManualNewsProviderErrorCode(raw);
}

export function manualNewsProviderFailureAudit(
  error: unknown,
): ManualNewsProviderFailureAudit | null {
  if (error instanceof ManualNewsProviderError) {
    const audit: ManualNewsProviderFailureAudit = {
      ...error.metrics,
      provider_error_code: error.provider_error_code,
      ...(error.provider_diagnostics
        ? { provider_diagnostics: error.provider_diagnostics }
        : {}),
      ...(error.assessment_generation_attempt
        ? { assessment_generation_attempt: error.assessment_generation_attempt }
        : {}),
      ...(error.assessment_last_validation_code
        ? { assessment_last_validation_code: error.assessment_last_validation_code }
        : {}),
    };
    return isValidManualNewsProviderFailureAudit(audit) ? audit : null;
  }
  const message = error instanceof Error ? error.message : String(error || '');
  const match = new RegExp(
    `^${PROVIDER_ERROR_PREFIX}:(assessment|verification):(${SAFE_PROVIDER_ERROR.source.slice(1, -1)}):(.+)$`,
  ).exec(message);
  if (!match) return null;
  try {
    const audit = JSON.parse(decodeURIComponent(match[3])) as unknown;
    if (!isValidManualNewsProviderFailureAudit(audit)) return null;
    return audit.stage === match[1] && audit.provider_error_code === match[2] ? audit : null;
  } catch {
    return null;
  }
}

export function manualNewsProviderPublicErrorMessage(error: unknown): string | null {
  const failure = manualNewsProviderFailureAudit(error);
  return failure
    ? `${PROVIDER_ERROR_PREFIX}:${failure.stage}:${failure.provider_error_code}`
    : null;
}

export function withManualNewsAssessmentFailureContext(
  error: unknown,
  generationAttempt: 1 | 2,
  lastValidationCode: string,
): unknown {
  if (!(error instanceof ManualNewsProviderError)) return error;
  return new ManualNewsProviderError({
    stage: error.stage,
    provider_error_code: error.provider_error_code,
    metrics: error.metrics,
    provider_diagnostics: error.provider_diagnostics,
    assessment_generation_attempt: generationAttempt,
    assessment_last_validation_code: SAFE_VALIDATION_CODE.test(lastValidationCode)
      ? lastValidationCode
      : 'not_validated',
  });
}

export function isTransientManualNewsProviderFailure(error: unknown): boolean | null {
  const failure = manualNewsProviderFailureAudit(error);
  if (!failure) return null;
  // Empty JSON-mode finals, output-budget exhaustion, and provider capacity
  // are retried only by the outer durable Workflow; manual calls have retries=0.
  return failure.provider_error_code === 'provider_timeout'
    || failure.provider_error_code === 'provider_transport_error'
    || failure.provider_error_code === 'provider_no_text'
    || failure.provider_error_code === 'provider_empty_final'
    || failure.provider_error_code === 'provider_output_exhausted'
    || failure.provider_error_code === 'provider_capacity'
    || failure.provider_error_code === 'provider_retry_exhausted'
    || /^provider_http_(?:408|429|5\d\d)$/.test(failure.provider_error_code);
}

export function isManualNewsProviderJsonParseFailure(error: unknown): boolean {
  return manualNewsProviderFailureAudit(error)?.provider_error_code === 'provider_json_parse_fail';
}
