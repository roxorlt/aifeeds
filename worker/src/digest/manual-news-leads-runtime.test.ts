import { describe, expect, test, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

import {
  applyManualLeadEvidencePolicy,
  buildManualLeadFactVerificationPrompt,
  createManualLeadVerificationProof as createManualLeadVerificationProofWithResponseSecret,
  isCurrentManualLeadVerification as isCurrentManualLeadVerificationWithResponseSecret,
  type ManualNewsProcessedAssessment,
  validateManualLeadAssessment,
  validateManualLeadFactVerification,
  validateManualLeadGeneratedAssessment,
} from './manual-news-leads';
import {
  createManualNewsLeadRuntimeAdapters,
  extractManualNewsEvidence,
  MANUAL_NEWS_PROVIDER_PROMPT_MAX_CHARS,
  MANUAL_NEWS_PROVIDER_TIMEOUT_MS,
} from './manual-news-leads-runtime';
import type { PublicDocument } from '../security/safe-url-fetch';
import { callDeepSeekJson, DEEPSEEK_PRO } from '../hf-paper/llm';
import {
  ManualNewsProviderError,
  manualNewsProviderDiagnostics,
  manualNewsProviderFailureAudit,
} from './manual-news-provider';
import {
  proofForLegacyPolicy,
  testManualNewsResponseKeyring,
  testManualNewsVerificationKeyring,
} from './manual-news-signed-evidence.test-fixture';

vi.mock('../hf-paper/llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../hf-paper/llm')>();
  return { ...actual, callDeepSeekJson: vi.fn() };
});

const responseSecret = '11'.repeat(32);
const responseProfile = 'proof_excerpt_v1';
const responseHmacContract = 'hmac-sha256-canonical-json-all-fields-except-response_hmac-v1';
const proofExcerptAlgorithm = 'utf8-nfc-ws1-codepoint-prefix-v1';

function referenceProofExcerpt(value: string): string {
  return Array.from(value.normalize('NFC')
    .replace(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu, ' ')
    .replace(/^ +| +$/gu, ''))
    .slice(0, 3_000)
    .join('')
    .replace(/ +$/gu, '');
}

function proofExcerptClaims(body: string) {
  const excerpt = referenceProofExcerpt(body);
  return {
    contract: 'proof_excerpt_v1' as const,
    algorithm: 'utf8-nfc-ws1-codepoint-prefix-v1' as const,
    max_code_points: 3_000 as const,
    sha256: createHash('sha256').update(excerpt).digest('hex'),
    utf8_bytes: new TextEncoder().encode(excerpt).byteLength,
    code_points: Array.from(excerpt).length,
  };
}

function createManualLeadVerificationProof(
  input: Parameters<typeof createManualLeadVerificationProofWithResponseSecret>[0],
  secret: string,
  evidenceResponseSecret = responseSecret,
) {
  return createManualLeadVerificationProofWithResponseSecret(
    input,
    testManualNewsVerificationKeyring(secret),
    testManualNewsResponseKeyring(evidenceResponseSecret),
  );
}

function isCurrentManualLeadVerification(
  input: Parameters<typeof isCurrentManualLeadVerificationWithResponseSecret>[0],
  proof: unknown,
  secret: string,
  evidenceResponseSecret = responseSecret,
) {
  return isCurrentManualLeadVerificationWithResponseSecret(
    input, proof,
    testManualNewsVerificationKeyring(secret),
    testManualNewsResponseKeyring(evidenceResponseSecret),
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function withResponseHmac(audit: PublicDocument['fetch_audit']): PublicDocument['fetch_audit'] {
  const { response_hmac: _placeholder, ...unsigned } = audit;
  return {
    ...unsigned,
    response_hmac: createHmac('sha256', Buffer.from(responseSecret, 'hex'))
      .update(canonicalJson(unsigned)).digest('hex'),
  };
}

function auditObject(
  url: string,
  sourceContentType: string,
  extraction: PublicDocument['extraction'],
  body: string,
  protocol: { request_nonce?: string; request_timestamp?: string } = {},
): PublicDocument['fetch_audit'] {
  const extractedBytes = new TextEncoder().encode(body).byteLength;
  const articleText = extraction === 'article_text';
  return withResponseHmac({
    hops: [{ url, validated_ip: '93.184.216.34', connected_ip: '93.184.216.34' }],
    source_content_type: sourceContentType, extraction,
    requested_limits: {
      source_bytes: 8_388_608, extracted_text_bytes: 2_097_152, extracted_text_characters: 1_000_000,
    },
    applied_limits: {
      source_bytes: 8_388_608,
      extracted_text_bytes: articleText ? 28_000 : 2_097_152,
      extracted_text_characters: articleText ? 28_000 : 1_000_000,
    },
    actual_sizes: {
      source_bytes: sourceContentType === 'application/pdf' ? 48_000 : extractedBytes,
      extracted_text_bytes: extractedBytes,
      extracted_text_characters: Array.from(body).length,
    },
    truncation: { source: false, extracted_text: false },
    parser: {
      result: 'success' as const,
      version: articleText ? 'chromium/149.0.7735.12' : 'research-gateway-parser/1.0.0',
    },
    ...(articleText ? { document: {
      title: 'Validated source title', published_at: '2026-07-04T08:00:00.000Z',
      selection: 'article' as const, content_complete: true as const,
    } } : {}),
    protocol_version: 'article_text_v2' as const,
    request_nonce: protocol.request_nonce || '22'.repeat(16),
    request_timestamp: protocol.request_timestamp || '2026-08-12T00:00:00.000Z',
    extracted_at: protocol.request_timestamp || '2026-08-12T00:00:00.000Z',
    final_url: url,
    body_sha256: createHash('sha256').update(body).digest('hex'),
    response_profile: responseProfile,
    response_hmac_contract: responseHmacContract,
    proof_excerpt: proofExcerptClaims(body),
    response_hmac: '',
  });
}

function signedAudit(
  url: string,
  sourceContentType: string,
  extraction: PublicDocument['extraction'],
  body: string,
  protocol: { request_nonce: string; request_timestamp: string },
): string {
  const auditValue = auditObject(url, sourceContentType, extraction, body, protocol);
  return encodeURIComponent(JSON.stringify(auditValue));
}

function documentFixture(
  url: string,
  body: string,
  extraction: PublicDocument['extraction'] = 'article_text',
  metadata: { title?: string; published_at?: string | null; selection?: 'article' | 'main' } = {},
): PublicDocument {
  const contentType = {
    article_text: 'text/html',
    html: 'text/html',
    text: 'text/plain',
    json: 'application/json',
    pdf_text: 'application/pdf',
  }[extraction];
  const fetchAudit = auditObject(url, contentType, extraction, body);
  if (extraction === 'article_text' && fetchAudit.document) {
    fetchAudit.document = {
      title: metadata.title || fetchAudit.document.title,
      published_at: metadata.published_at === undefined
        ? fetchAudit.document.published_at : metadata.published_at,
      selection: metadata.selection || fetchAudit.document.selection,
      content_complete: true,
    };
  }
  const signedFetchAudit = withResponseHmac(fetchAudit);
  const excerpt = referenceProofExcerpt(body);
  return {
    response_key_id: 'response-key-2026-08-11',
    url, content_type: contentType, extraction, excerpt, redirects: 0,
    fetch_audit: signedFetchAudit,
    ...(extraction === 'article_text' ? {
      title: signedFetchAudit.document!.title,
      published_at: signedFetchAudit.document!.published_at,
      selection: signedFetchAudit.document!.selection,
      content_complete: true as const,
    } : {}),
  };
}

const alibabaSupport = 'Alibaba reportedly bans employees from using Claude Code.';

function longSignedBody(_extraction: 'text' | 'json' | 'pdf_text'): string {
  const repeatedSupport = Array.from({ length: 64 }, () => alibabaSupport);
  return `${repeatedSupport.join(' ')} COMPLETE-BODY-TAIL-SENTINEL`;
}

function alibabaGeneratedAssessment(evidenceId: string) {
  return {
    event_key: 'alibaba-claude-code-employee-ban-2026-07-04',
    event_type: 'industry_event', material_update: false, score: 88,
    recommendation: 'recommended', occurred_at: null, uncertainties: [], matched_event_key: null,
    source_facts: [{
      fact_ref: 'fact-01', source_language: 'en',
      atomic_fact: {
        subject: 'Alibaba', subject_role: 'organization', predicate: 'reportedly bans',
        object: 'employees from using Claude Code',
      },
      evidence_ids: [evidenceId],
    }],
    evidence_dispositions: [{
      evidence_id: evidenceId, disposition: 'supports_core',
      source_fact_refs: ['fact-01'], reason_code: null,
    }],
    editorial_projection: {
      title: {
        projection_ref: 'title-01', source_fact_refs: ['fact-01'],
        atomic_fact: {
          subject: '阿里巴巴', subject_role: 'organization', predicate: '据称禁止',
          object: '员工使用Claude Code',
        },
      },
      summary: [{
        projection_ref: 'summary-01', source_fact_refs: ['fact-01'],
        atomic_fact: {
          subject: '阿里巴巴', subject_role: 'organization', predicate: '据称禁止',
          object: '员工使用Claude Code',
        },
      }],
    },
  };
}

function supportedFactResult(factId: string, evidenceId: string, quote: string) {
  return {
    fact_id: factId, supported: true, issue_code: 'none',
    source_quotes: [{ evidence_id: evidenceId, quote }],
    ...(factId === 'field:material_update' ? {
      comparison_result: {
        value: false, matched_event_key: null, prior_event_keys: [], reason_code: 'no_prior_match',
        current_evidence_id: evidenceId, current_quote: quote,
      },
    } : {}),
  };
}

async function createAlibabaProof(
  evidence: NonNullable<Awaited<ReturnType<typeof extractManualNewsEvidence>>>,
) {
  const generated = validateManualLeadGeneratedAssessment(alibabaGeneratedAssessment(evidence.id), [evidence]);
  const candidate: ManualNewsProcessedAssessment = {
    ...applyManualLeadEvidencePolicy(generated, [evidence]), duplicate_scope: null, matched_lead_id: null,
  };
  const prompt = JSON.parse(buildManualLeadFactVerificationPrompt({
    assessment: candidate, evidence: [evidence],
  }).user) as {
    facts: Array<{ fact_id: string }>;
    projections: Array<{ projection_id: string; source_fact_ids: string[] }>;
    evidence_dispositions: Array<{ evidence_id: string; disposition: string }>;
  };
  const verification = validateManualLeadFactVerification({
    overall_verdict: 'supported',
    fact_results: prompt.facts.map((fact) => supportedFactResult(fact.fact_id, evidence.id, alibabaSupport)),
    projection_results: prompt.projections.map((projection) => ({
      projection_id: projection.projection_id, source_fact_ids: projection.source_fact_ids,
      supported: true, issue_code: 'none',
    })),
    disposition_results: prompt.evidence_dispositions.map((disposition) => ({
      evidence_id: disposition.evidence_id, disposition: disposition.disposition,
      supported: true, issue_code: 'none',
      source_quotes: [{ evidence_id: evidence.id, quote: alibabaSupport }],
    })),
  }, candidate, [evidence]);
  const proofInput = {
    lead_id: 'ml-runtime-techcrunch-article', assessment_version: 9,
    assessment: candidate, evidence: [evidence], verification,
  };
  const secret = 'a'.repeat(64);
  const proof = await createManualLeadVerificationProof(proofInput, secret, responseSecret);
  return { proofInput, proof, secret };
}

async function createAlibabaCurrentProof(
  evidence: NonNullable<Awaited<ReturnType<typeof extractManualNewsEvidence>>>,
) {
  const { proofInput, proof, secret } = await createAlibabaProof(evidence);
  return isCurrentManualLeadVerification(proofInput, proof, secret);
}

describe('manual lead evidence extraction', () => {
  test('uses one 210-second provider call per assessment or verification invocation and records only safe metrics', async () => {
    const mockedCall = vi.mocked(callDeepSeekJson);
    mockedCall
      .mockResolvedValueOnce({ data: { event_key: 'safe-result' } })
      .mockResolvedValueOnce({ data: { overall_verdict: 'supported', claim_results: [] } });
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: {} as never,
      DEEPSEEK_API_KEY: 'test-key',
    } as never, { modelContext: { leadId: 'ml-safe-request', processingAttempt: 6 } });

    await expect(adapters.assess(
      { system: 'assessment secret body', user: '{"evidence":"https://private.example/path"}' },
      { request_id: 'ml-safe-request:p6:assessment:1', evidence_count: 1, attempt: 6 },
    )).resolves.toEqual({ event_key: 'safe-result' });
    await expect(adapters.verify(
      { system: 'independent verifier', user: '{"claims":[]}' },
      { request_id: 'ml-safe-request:p6:verification:2', evidence_count: 1, attempt: 6 },
    ))
      .resolves.toEqual({ overall_verdict: 'supported', claim_results: [] });
    expect(mockedCall).toHaveBeenNthCalledWith(
      1,
      'test-key', DEEPSEEK_PRO, '{"evidence":"https://private.example/path"}',
      expect.objectContaining({
        systemPrompt: 'assessment secret body', retries: 0, timeoutMs: 210_000, maxTokens: 12_000,
        requestId: 'ml-safe-request:p6:assessment:1',
      }),
    );
    expect(mockedCall).toHaveBeenNthCalledWith(
      2,
      'test-key', DEEPSEEK_PRO, '{"claims":[]}',
      expect.objectContaining({
        systemPrompt: 'independent verifier', retries: 0, timeoutMs: 210_000, maxTokens: 12_000,
        requestId: 'ml-safe-request:p6:verification:2',
      }),
    );
    expect(mockedCall).toHaveBeenCalledTimes(2);
    const logs = info.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(logs).toContain('"stage":"assessment"');
    expect(logs).toContain('"stage":"verification"');
    expect(logs).toContain('"evidence_count":1');
    expect(logs).toContain('"attempt":6');
    expect(logs).toContain('"system_chars":22');
    expect(logs).not.toContain('assessment secret body');
    expect(logs).not.toContain('private.example');
    expect(logs).not.toContain('test-key');
    mockedCall.mockReset();
  });

  test.each(['assessment', 'verification'] as const)(
    'fails closed before the %s provider call when the fully serialized prompt exceeds its hard limit',
    async (stage) => {
      const mockedCall = vi.mocked(callDeepSeekJson);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const adapters = createManualNewsLeadRuntimeAdapters({
        DB: {} as never, DEEPSEEK_API_KEY: 'test-key',
      } as never, { modelContext: { leadId: 'ml-prompt-limit', processingAttempt: 3 } });
      const invoke = stage === 'assessment' ? adapters.assess : adapters.verify;

      const failure = await invoke(
        { system: 'trusted-rules', user: 'x'.repeat(MANUAL_NEWS_PROVIDER_PROMPT_MAX_CHARS) },
        { request_id: `ml-prompt-limit:p3:${stage}:1`, evidence_count: 6, attempt: 3 },
      ).catch((error) => error);

      expect(failure).toBeInstanceOf(ManualNewsProviderError);
      expect(failure).toMatchObject({ stage, provider_error_code: 'provider_prompt_too_large' });
      expect(mockedCall).not.toHaveBeenCalled();
      expect(info.mock.calls.flat().join(' ')).not.toContain('xxxxxxxxxx');
      mockedCall.mockReset();
    },
  );

  test('exports the provider timeout and complete serialized prompt boundary', () => {
    expect(MANUAL_NEWS_PROVIDER_TIMEOUT_MS).toBe(210_000);
    expect(MANUAL_NEWS_PROVIDER_PROMPT_MAX_CHARS).toBe(64_000);
  });

  test.each([
    ['assessment', 'AbortError', 'provider_timeout'],
    ['assessment', 'TimeoutError', 'provider_timeout'],
    ['assessment', 'TypeError', 'provider_transport_error'],
    ['assessment', 'HTTP 408', 'provider_http_408'],
    ['assessment', 'HTTP 429', 'provider_http_429'],
    ['assessment', 'HTTP 503', 'provider_http_503'],
    ['assessment', 'no_text', 'provider_no_text'],
    ['assessment', 'json_parse_fail', 'provider_json_parse_fail'],
    ['verification', 'HTTP 502', 'provider_http_502'],
  ] as const)('maps safe %s provider failures: %s', async (stage, rawCode, stableCode) => {
    const mockedCall = vi.mocked(callDeepSeekJson);
    mockedCall.mockResolvedValueOnce({ data: null, error: rawCode });
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: {} as never, DEEPSEEK_API_KEY: 'test-key',
    } as never, { modelContext: { leadId: 'ml-safe-request', processingAttempt: 2 } });
    const invoke = stage === 'assessment' ? adapters.assess : adapters.verify;

    const failure = await invoke(
      { system: 'rules', user: '{"evidence":[]}' },
      { request_id: `ml-safe-request:p2:${stage}:1`, evidence_count: 1, attempt: 2 },
    ).catch((error) => error);

    expect(failure).toBeInstanceOf(ManualNewsProviderError);
    expect(failure).toMatchObject({ stage, provider_error_code: stableCode });
    expect(String((failure as Error).message)).toMatch(
      new RegExp(`^manual_news_provider_error:${stage}:${stableCode}:`),
    );
    mockedCall.mockReset();
  });

  test('drops out-of-range or non-whitelisted provider diagnostics before audit', () => {
    expect(manualNewsProviderDiagnostics({
      finish_reason: 'length',
      content_chars: 0,
      reasoning_chars: 10_000_001,
      usage: { reasoning_tokens: 100_000_001 },
    })).toBeUndefined();
    expect(manualNewsProviderDiagnostics({
      finish_reason: 'future-provider-value' as never,
      content_chars: 0,
      reasoning_chars: 1,
      usage: {},
    })).toBeUndefined();
  });

  test.each([
    ['length', 'no_text', 3, 'provider_output_exhausted'],
    ['length', 'json_parse_fail', 17, 'provider_output_exhausted'],
    ['stop', 'no_text', 3, 'provider_empty_final'],
    ['insufficient_system_resource', 'no_text', 0, 'provider_capacity'],
    ['insufficient_system_resource', 'json_parse_fail', 17, 'provider_capacity'],
    ['unknown', 'no_text', 0, 'provider_no_text'],
  ] as const)('classifies null assessment finish=%s with bounded safe diagnostics', async (
    finishReason,
    rawError,
    contentChars,
    expectedCode,
  ) => {
    const mockedCall = vi.mocked(callDeepSeekJson);
    mockedCall.mockResolvedValueOnce({
      data: null,
      error: rawError,
      diagnostics: {
        finish_reason: finishReason,
        content_chars: contentChars,
        reasoning_chars: 3_500,
        usage: {
          prompt_tokens: 1_200,
          completion_tokens: 3_500,
          total_tokens: 4_700,
          reasoning_tokens: 3_500,
        },
      },
    } as never);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: {} as never, DEEPSEEK_API_KEY: 'test-key',
    } as never, { modelContext: { leadId: 'ml-safe-request', processingAttempt: 2 } });

    const failure = await adapters.assess(
      { system: 'rules', user: '{"evidence":[]}' },
      { request_id: 'ml-safe-request:p2:assessment:1', evidence_count: 1, attempt: 2 },
    ).catch((error) => error);

    expect(failure).toMatchObject({ provider_error_code: expectedCode });
    expect(manualNewsProviderFailureAudit(failure)).toMatchObject({
      provider_error_code: expectedCode,
      provider_diagnostics: {
        finish_reason: finishReason,
        content_chars: contentChars,
        reasoning_chars: 3_500,
        usage: { reasoning_tokens: 3_500 },
      },
    });
    expect(JSON.stringify(manualNewsProviderFailureAudit(failure))).not.toContain('reasoning_content');
    mockedCall.mockReset();
  });

  test('uses the bounded trusted article excerpt and creates a current v10 proof', async () => {
    const body = alibabaSupport;
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://techcrunch.com/2026/07/04/alibaba-claude-code/', body, 'article_text', {
        title: 'Alibaba reportedly bans employees from using Claude Code | TechCrunch',
        published_at: '2026-07-04T08:00:00.000Z',
      },
    ), undefined, 1234);

    expect(evidence).toMatchObject({
      title: 'Alibaba reportedly bans employees from using Claude Code | TechCrunch',
      excerpt: body,
      claims_supported: [body],
      published_at: '2026-07-04T08:00:00.000Z',
      retrieved_at: 1234,
      fetch_audit: {
        extraction: 'article_text',
        response_profile: responseProfile,
        parser: { version: 'chromium/149.0.7735.12' },
        document: { content_complete: true },
      },
    });
    await expect(createAlibabaCurrentProof(evidence!)).resolves.toBe(true);
  });

  test('rejects an otherwise active v9 proof at the direct current-proof boundary', async () => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://techcrunch.com/2026/07/04/alibaba-claude-code/', alibabaSupport,
    ));
    const { proofInput, proof, secret } = await createAlibabaProof(evidence!);
    const legacy = proofForLegacyPolicy(proof, proofInput, secret);

    await expect(isCurrentManualLeadVerification(proofInput, legacy, secret)).resolves.toBe(false);
  });

  test('v10 proof creation rejects unsigned and malformed gateway provenance', async () => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://techcrunch.com/2026/07/04/alibaba-claude-code/', alibabaSupport,
    ));
    const { proofInput, proof, secret } = await createAlibabaProof(evidence!);
    const unsigned = structuredClone(proofInput);
    unsigned.evidence[0]!.fetch_audit = null;
    const malformed = structuredClone(proofInput);
    malformed.evidence[0]!.fetch_audit!.protocol_version = undefined;
    const forgedBodyDigest = structuredClone(proofInput);
    forgedBodyDigest.evidence[0]!.fetch_audit!.body_sha256 = '00'.repeat(32);
    const impossiblePublishedAt = structuredClone(proofInput);
    impossiblePublishedAt.evidence[0]!.published_at = '2026-02-31';
    impossiblePublishedAt.evidence[0]!.fetch_audit!.document!.published_at = '2026-02-31';
    const legacyMax = structuredClone(proofInput);
    const legacyClaims = legacyMax.evidence[0]!.fetch_audit!.proof_excerpt! as unknown as Record<string, unknown>;
    delete legacyClaims.max_code_points;
    legacyClaims.max = 3_000;
    legacyMax.evidence[0]!.fetch_audit = withResponseHmac(legacyMax.evidence[0]!.fetch_audit!);
    const wrongMax = structuredClone(proofInput);
    (wrongMax.evidence[0]!.fetch_audit!.proof_excerpt! as unknown as Record<string, unknown>)
      .max_code_points = 2_999;
    wrongMax.evidence[0]!.fetch_audit = withResponseHmac(wrongMax.evidence[0]!.fetch_audit!);
    const ambiguousMax = structuredClone(proofInput);
    (ambiguousMax.evidence[0]!.fetch_audit!.proof_excerpt! as unknown as Record<string, unknown>).max = 3_000;
    ambiguousMax.evidence[0]!.fetch_audit = withResponseHmac(ambiguousMax.evidence[0]!.fetch_audit!);

    await expect(createManualLeadVerificationProof(unsigned, secret))
      .rejects.toThrow(/manual_news_evidence_provenance_invalid/);
    await expect(isCurrentManualLeadVerification(unsigned, proof, secret)).resolves.toBe(false);
    await expect(createManualLeadVerificationProof(malformed, secret))
      .rejects.toThrow(/manual_news_evidence_provenance_invalid/);
    await expect(isCurrentManualLeadVerification(malformed, proof, secret)).resolves.toBe(false);
    await expect(createManualLeadVerificationProof(forgedBodyDigest, secret))
      .rejects.toThrow(/manual_news_evidence_response_hmac_invalid/);
    await expect(isCurrentManualLeadVerification(forgedBodyDigest, proof, secret)).resolves.toBe(false);
    await expect(createManualLeadVerificationProof(impossiblePublishedAt, secret))
      .rejects.toThrow(/manual_news_evidence_provenance_invalid/);
    await expect(isCurrentManualLeadVerification(impossiblePublishedAt, proof, secret)).resolves.toBe(false);
    for (const malformedMax of [legacyMax, wrongMax, ambiguousMax]) {
      await expect(createManualLeadVerificationProof(malformedMax, secret))
        .rejects.toThrow(/manual_news_evidence_provenance_invalid/);
      await expect(isCurrentManualLeadVerification(malformedMax, proof, secret)).resolves.toBe(false);
    }
  });

  test('accepts the canonical HK max_code_points field at completeTrustedArticle', async () => {
    const canonical = documentFixture(
      'https://www.axios.com/canonical-proof-excerpt', alibabaSupport,
      'article_text', { title: 'Canonical proof excerpt' },
    );
    expect(Object.keys(canonical.fetch_audit.proof_excerpt!)).toEqual([
      'contract', 'algorithm', 'max_code_points', 'sha256', 'utf8_bytes', 'code_points',
    ]);
    await expect(extractManualNewsEvidence(canonical)).resolves.not.toBeNull();

    for (const mutation of ['legacy', 'wrong', 'ambiguous'] as const) {
      const malformed = structuredClone(canonical);
      const claims = malformed.fetch_audit.proof_excerpt! as unknown as Record<string, unknown>;
      if (mutation === 'legacy') {
        delete claims.max_code_points;
        claims.max = 3_000;
      } else if (mutation === 'wrong') {
        claims.max_code_points = 2_999;
      } else {
        claims.max = 3_000;
      }
      malformed.fetch_audit = withResponseHmac(malformed.fetch_audit);
      await expect(extractManualNewsEvidence(malformed)).resolves.toBeNull();
    }
  });

  test('v10 proof binds authenticated v2 body and response signature audit fields', async () => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://techcrunch.com/2026/07/04/alibaba-claude-code/', alibabaSupport,
    ));
    const { proofInput, proof, secret } = await createAlibabaProof(evidence!);
    const tampered = structuredClone(proofInput);
    const tamperedEvidence = tampered.evidence[0]!;
    const tamperedAudit = tamperedEvidence.fetch_audit!;
    const originalAudit = proofInput.evidence[0]!.fetch_audit!;
    tamperedAudit.response_hmac = '44'.repeat(32);
    await expect(isCurrentManualLeadVerification(tampered, proof, secret)).resolves.toBe(false);
    tamperedAudit.response_hmac = originalAudit.response_hmac;
    tamperedAudit.body_sha256 = '55'.repeat(32);
    await expect(isCurrentManualLeadVerification(tampered, proof, secret)).resolves.toBe(false);
  });

  test('v10 proof creation rejects a forged response HMAC before issuing a current proof', async () => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://techcrunch.com/2026/07/04/alibaba-claude-code/', alibabaSupport,
    ));
    const { proofInput, secret } = await createAlibabaProof(evidence!);
    const forged = structuredClone(proofInput);
    forged.evidence[0]!.fetch_audit!.response_hmac = '44'.repeat(32);

    await expect(createManualLeadVerificationProof(forged, secret, responseSecret))
      .rejects.toThrow(/manual_news_evidence_response_hmac_invalid/);
    await expect(createManualLeadVerificationProof(proofInput, secret, '22'.repeat(32)))
      .rejects.toThrow(/manual_news_evidence_response_hmac_invalid/);
    const validProof = await createManualLeadVerificationProof(proofInput, secret, responseSecret);
    await expect(isCurrentManualLeadVerification(
      proofInput, validProof, secret, '22'.repeat(32),
    )).resolves.toBe(false);
  });

  test.each([
    ['text/plain', 'text'],
    ['application/json', 'json'],
    ['application/pdf', 'pdf_text'],
  ] as const)('keeps signed v2 %s extraction current with %s semantics', async (sourceType, extraction) => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://techcrunch.com/2026/07/04/alibaba-claude-code/', alibabaSupport, extraction,
    ), {
      url: 'https://techcrunch.com/2026/07/04/alibaba-claude-code/',
      title: 'Alibaba reportedly bans employees from using Claude Code',
      snippet: alibabaSupport,
      published_at: '2026-07-04T08:00:00.000Z',
    });

    expect(evidence?.fetch_audit).toMatchObject({
      source_content_type: sourceType,
      extraction,
      protocol_version: 'article_text_v2',
      response_hmac: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const { proofInput, proof, secret } = await createAlibabaProof(evidence!);

    await expect(isCurrentManualLeadVerification(proofInput, proof, secret)).resolves.toBe(true);
  });

  test.each([
    ['text/plain', 'text'],
    ['application/json', 'json'],
    ['application/pdf', 'pdf_text'],
  ] as const)('derives a bounded proof excerpt from a signed complete >3000-character %s body', async (
    sourceType,
    extraction,
  ) => {
    const body = longSignedBody(extraction);
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://techcrunch.com/2026/07/04/alibaba-claude-code/', body, extraction,
    ), {
      url: 'https://techcrunch.com/2026/07/04/alibaba-claude-code/',
      title: 'Alibaba reportedly bans employees from using Claude Code',
      snippet: alibabaSupport,
      published_at: '2026-07-04T08:00:00.000Z',
    }, Date.parse('2026-08-12T00:00:00.000Z'));

    expect(evidence?.fetch_audit).toMatchObject({ source_content_type: sourceType, extraction });
    expect(Array.from(evidence!.excerpt)).toHaveLength(3_000);
    expect(evidence!.claims_supported).toEqual([evidence!.excerpt]);
    expect(JSON.stringify(evidence)).not.toContain('COMPLETE-BODY-TAIL-SENTINEL');
    const { proofInput, proof, secret } = await createAlibabaProof(evidence!);
    const verificationPrompt = JSON.parse(buildManualLeadFactVerificationPrompt({
      assessment: proofInput.assessment, evidence: proofInput.evidence,
    }).user) as { untrusted_evidence: Array<{ excerpt: string; claims_supported: string[] }> };
    expect(verificationPrompt.untrusted_evidence[0]).toMatchObject({
      excerpt: evidence!.excerpt, claims_supported: [],
    });
    await expect(isCurrentManualLeadVerification(proofInput, proof, secret)).resolves.toBe(true);
  });

  test.each([
    ['text/plain', 'text'],
    ['application/json', 'json'],
    ['application/pdf', 'pdf_text'],
  ] as const)('rejects substituted persisted excerpts for a valid signed complete %s body', async (
    _sourceType,
    extraction,
  ) => {
    const body = longSignedBody(extraction);
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://techcrunch.com/2026/07/04/alibaba-claude-code/', body, extraction,
    ), {
      url: 'https://techcrunch.com/2026/07/04/alibaba-claude-code/',
      title: 'Alibaba reportedly bans employees from using Claude Code',
      snippet: alibabaSupport,
      published_at: '2026-07-04T08:00:00.000Z',
    }, Date.parse('2026-08-12T00:00:00.000Z'));
    const { proofInput, secret } = await createAlibabaProof(evidence!);
    const substituted = structuredClone(proofInput);
    substituted.evidence[0]!.excerpt = `${alibabaSupport} substituted persisted excerpt`;
    substituted.evidence[0]!.claims_supported = [substituted.evidence[0]!.excerpt];

    await expect(createManualLeadVerificationProof(substituted, secret, responseSecret))
      .rejects.toThrow(/manual_news_evidence_proof_excerpt_invalid/);
    await expect(isCurrentManualLeadVerification(
      substituted, { policy_version: 'fact-evidence-projection-hmac-v10', canonical_digest: '0'.repeat(64), hmac_sha256: '0'.repeat(64) }, secret,
    )).resolves.toBe(false);
  });

  test('enforces the 8-source proof boundary and rejects duplicate identities or full-body claims', async () => {
    const evidence = await Promise.all(Array.from({ length: 9 }, async (_, index) => {
      const url = `https://techcrunch.com/2026/07/04/alibaba-claude-code-${index}/`;
      return (await extractManualNewsEvidence(documentFixture(url, alibabaSupport), undefined, 1_723_420_800_000))!;
    }));
    const { proofInput, secret } = await createAlibabaProof(evidence[0]);
    const eightSources = { ...proofInput, evidence: evidence.slice(0, 8) };
    const eightProof = await createManualLeadVerificationProof(eightSources, secret, responseSecret);
    await expect(isCurrentManualLeadVerification(eightSources, eightProof, secret)).resolves.toBe(true);

    await expect(createManualLeadVerificationProof(
      { ...proofInput, evidence }, secret, responseSecret,
    )).rejects.toThrow(/manual_news_evidence_set_invalid/);
    await expect(createManualLeadVerificationProof(
      { ...proofInput, evidence: [evidence[0], evidence[0]] }, secret, responseSecret,
    )).rejects.toThrow(/manual_news_evidence_set_invalid/);
    await expect(createManualLeadVerificationProof({
      ...proofInput,
      evidence: [evidence[0], { ...evidence[0], id: 'ev-duplicate-final-url' }],
    }, secret, responseSecret)).rejects.toThrow(/manual_news_evidence_set_invalid/);
    await expect(createManualLeadVerificationProof({
      ...proofInput,
      evidence: [{ ...evidence[0], claims_supported: [`${evidence[0].excerpt} COMPLETE-BODY-TAIL-SENTINEL`] }],
    }, secret, responseSecret)).rejects.toThrow(/manual_news_evidence_set_invalid/);
  });

  test('does not expire historically persisted signed evidence against the current wall clock', async () => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://techcrunch.com/2026/07/04/alibaba-claude-code/', alibabaSupport,
    ));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2036-08-12T00:00:00.000Z'));
    try {
      const { proofInput, proof, secret } = await createAlibabaProof(evidence!);
      await expect(isCurrentManualLeadVerification(proofInput, proof, secret)).resolves.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('applies the same bounded proof excerpt contract to article_text', async () => {
    const body = `Opening material. ${'A'.repeat(3_100)} Final denial remains present.`;
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://www.axios.com/complete-article', body, 'article_text', { title: 'Complete article' },
    ));
    expect(evidence?.excerpt).toBe(referenceProofExcerpt(body));
    expect(JSON.stringify(evidence)).not.toContain('Final denial remains present.');
  });

  test.each([
    'Alibaba withdrew the restriction on employees using Claude Code.',
    'Alibaba said the Claude Code restriction applies only to contractors.',
  ])('preserves visible article blockers and fails closed: %s', async (blocker) => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://techcrunch.com/2026/07/04/alibaba-claude-code/',
      `${alibabaSupport} ${blocker}`, 'article_text', { title: 'Alibaba report' },
    ));

    expect(evidence?.excerpt).toContain(blocker);
    await expect(createAlibabaCurrentProof(evidence!))
      .rejects.toThrow(/evidence_disposition|verification_semantics/);
  });

  test('rejects raw HTML and incomplete, unsafe, or over-cap article_text documents', async () => {
    const rawHtml = `<script type="application/ld+json">${JSON.stringify({
      '@type': 'NewsArticle', articleBody: alibabaSupport,
    })}</script><article>Alibaba withdrew the restriction on employees using Claude Code.</article>`;
    expect(await extractManualNewsEvidence(documentFixture(
      'https://www.axios.com/raw', rawHtml, 'html',
    ))).toBeNull();

    const incomplete = documentFixture(
      'https://www.axios.com/incomplete', alibabaSupport, 'article_text', { title: 'Report' },
    );
    incomplete.content_complete = undefined;
    expect(await extractManualNewsEvidence(incomplete)).toBeNull();

    const legacyV1 = documentFixture(
      'https://www.axios.com/v1', alibabaSupport, 'article_text', { title: 'Report' },
    );
    legacyV1.fetch_audit.protocol_version = undefined;
    expect(await extractManualNewsEvidence(legacyV1)).toBeNull();

    const forgedExcerpt = documentFixture(
      'https://www.axios.com/forged', alibabaSupport, 'article_text', { title: 'Report' },
    );
    forgedExcerpt.fetch_audit.proof_excerpt!.sha256 = '00'.repeat(32);
    expect(await extractManualNewsEvidence(forgedExcerpt)).toBeNull();

    for (const body of [
      `${alibabaSupport}\u200b hidden blocker`,
      'x'.repeat(28_001),
      '界'.repeat(9_334),
    ]) {
      expect(await extractManualNewsEvidence(documentFixture(
        'https://www.axios.com/unsafe', body, 'article_text', { title: 'Report' },
      ))).toBeNull();
    }
  });

  test('keeps trusted DOM publication time separate from retrieval time', async () => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://www.anthropic.com/news/example',
      'Scope is limited to supported products.', 'article_text', {
        title: 'Supported output provenance', published_at: '2026-08-10T13:30:00.000Z',
      },
    ), {
      url: 'https://www.anthropic.com/news/example', title: 'Search title', snippet: 'Search snippet.',
      published_at: '2026-08-09T00:00:00Z',
    }, 1234);

    expect(evidence).toMatchObject({
      source_type: 'official_primary',
      published_at: '2026-08-10T13:30:00.000Z',
      retrieved_at: 1234,
    });
  });

  test('does not invent a publication time when the source and search hint omit it', async () => {
    const evidence = await extractManualNewsEvidence(documentFixture(
      'https://www.axios.com/example', 'No machine-readable publication time.', 'article_text', {
        title: 'Report', published_at: null,
      },
    ), undefined, 1234);
    expect(evidence?.published_at).toBeNull();
  });

  test('classifies authority only from the exact allowlisted registrable domain of the final fetched URL', async () => {
    const deceptive = await extractManualNewsEvidence(documentFixture(
      'https://support.claude.com.evil.example/notice', 'Untrusted copy.', 'article_text', {
        title: 'Fake help',
      },
    ), {
      url: 'https://support.claude.com/real', title: 'Malicious hint', snippet: 'Pretend official.',
      source_type: 'official_help', publisher: 'Anthropic', reliable: true,
    }, 1234);
    expect(deceptive).toMatchObject({
      url: 'https://support.claude.com.evil.example/notice',
      source_type: 'other', publisher: 'evil.example', reliable: false,
    });

    const official = await extractManualNewsEvidence(documentFixture(
      'https://support.claude.com/en/articles/notice', 'Supported products only.', 'article_text', {
        title: 'Official help',
      },
    ), undefined, 1234);
    expect(official).toMatchObject({ source_type: 'official_help', publisher: 'claude.com', reliable: true });
  });

  test('text-only research requires and combines a trusted open-web search with existing D1 evidence', async () => {
    const db = {
      prepare() {
        const stmt = {
          bind() { return stmt; },
          async all() { return { results: [{
            title: 'Existing item', content: 'Existing body', content_translated: null,
            url: 'https://www.anthropic.com/news/existing', published_at: '2026-08-10T00:00:00Z', extra: '{}',
          }] }; },
        };
        return stmt;
      },
    };
    const baseEnv = { DB: db } as never;
    await expect(createManualNewsLeadRuntimeAdapters(baseEnv).search({
      date: '2026-08-11', text: 'Anthropic watermark', note: '',
    })).rejects.toThrow(/trusted_research_service_required/);

    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: db,
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-token',
      MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: '11'.repeat(32),
      MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-08-11',
    } as never, {
      researchFetcher: async () => new Response(JSON.stringify({ results: [{
        url: 'https://www.axios.com/report', title: 'Independent report', snippet: 'Independent evidence.',
        published_at: '2026-08-10T12:00:00Z',
      }] }), { headers: { 'Content-Type': 'application/json' } }),
    });
    const results = await adapters.search({ date: '2026-08-11', text: 'Anthropic watermark', note: '' });
    expect(results.map((item) => item.url)).toEqual([
      'https://www.anthropic.com/news/existing', 'https://www.axios.com/report',
    ]);
  });

  test('identifies a failure in the existing-news search branch without preventing open-web search startup', async () => {
    const researchFetcher = vi.fn(async () => new Response(JSON.stringify({ results: [] }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: { prepare() { throw new TypeError('D1 receiver mismatch'); } },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-token',
      MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: '11'.repeat(32),
      MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-08-11',
    } as never, { researchFetcher });

    await expect(adapters.search({ date: '2026-08-11', text: 'Anthropic watermark', note: '' }))
      .rejects.toThrow(/^search_existing:D1 receiver mismatch$/);
    expect(researchFetcher).toHaveBeenCalledTimes(1);
  });

  test('identifies a failure in the public-web search branch without exposing the gateway token', async () => {
    const statement = {
      bind() { return statement; },
      async all() { return { results: [] }; },
    };
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: { prepare() { return statement; } },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'secret-test-token',
      MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: '11'.repeat(32),
      MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-08-11',
    } as never, {
      researchFetcher: async () => {
        throw new TypeError('Illegal invocation for Bearer secret-test-token');
      },
    });

    let failure: unknown;
    try {
      await adapters.search({ date: '2026-08-11', text: 'Anthropic watermark', note: '' });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('search_public:Illegal invocation for Bearer [redacted]');
    expect((failure as Error).message).not.toContain('secret-test-token');
    expect((failure as Error).cause).toBeUndefined();
  });

  test('redacts every provider URL while preserving the search stage and stable gateway status', async () => {
    const statement = {
      bind() { return statement; },
      async all() { return { results: [] }; },
    };
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: { prepare() { return statement; } },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-token',
      MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: '11'.repeat(32),
      MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-08-11',
    } as never, {
      researchFetcher: async () => {
        throw new Error(
          'trusted_gateway_http_502 fetching https://example.com/path?token=secret#frag '
          + 'via https://provider.example/private/report?id=hidden',
        );
      },
    });

    let message = '';
    try {
      await adapters.search({ date: '2026-08-11', text: 'Anthropic watermark', note: '' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('search_public:trusted_gateway_http_502 fetching [url] via [url]');
    for (const leaked of ['example.com', '/path', 'token=secret', '#frag', 'provider.example', 'id=hidden']) {
      expect(message).not.toContain(leaked);
    }
  });

  test('redacts adversarial URL forms without leaving credential, path, query, or fragment suffixes', async () => {
    const statement = {
      bind() { return statement; },
      async all() { return { results: [] }; },
    };
    const unsafeMessage = [
      'trusted_gateway_http_503',
      '_https://u.example/p?q=1#uf',
      'HtTpS://c.example/P?Q=2#CF',
      "https://u:p's@d.example/c?t=3#df",
      "http://p.example/a'b?t=4#pf",
      '(https://r.example/i?q=5#rf),',
      'https://t.example/f?q=6#tf...',
    ].join(' ');
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: { prepare() { return statement; } },
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-token',
      MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: '11'.repeat(32),
      MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-08-11',
    } as never, {
      researchFetcher: async () => { throw new Error(unsafeMessage); },
    });

    let message = '';
    try {
      await adapters.search({ date: '2026-08-11', text: 'Anthropic watermark', note: '' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('search_public:trusted_gateway_http_503');
    expect(message.match(/\[url\]/g)).toHaveLength(6);
    expect(message).not.toMatch(/https?:\/\//i);
    for (const leaked of [
      'u.example', '/p', 'q=1', '#uf',
      'c.example', '/P', 'Q=2', '#CF',
      "u:p's", 'd.example', '/c', 't=3', '#df',
      'p.example', "/a'b", 't=4', '#pf',
      'r.example', '/i', 'q=5', '#rf',
      't.example', '/f', 'q=6', '#tf',
    ]) expect(message.toLowerCase()).not.toContain(leaked.toLowerCase());
  });

  test('Bernie letter uses bounded trusted PDF text conversion and still needs an independent report', async () => {
    const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body || '{}')) as {
        url: string; request_nonce: string; request_timestamp: string;
      };
      const target = request.url;
      const pdf = target.endsWith('.pdf');
      const body = pdf
        ? 'Senator Bernie Sanders asks OpenAI, Anthropic, and Meta leaders to pause AI development.'
        : 'Independent reporting says one senator made the request; it is not a binding congressional order.';
      return new Response(body, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-AIFeeds-Fetch-Audit': signedAudit(
            target, pdf ? 'application/pdf' : 'text/html', pdf ? 'pdf_text' : 'article_text', body, request,
          ),
        },
      });
    };
    const adapters = createManualNewsLeadRuntimeAdapters({
      DB: {} as never,
      MANUAL_NEWS_RESEARCH_ORIGIN: 'https://research-gateway.example',
      MANUAL_NEWS_RESEARCH_TOKEN: 'test-token',
      MANUAL_NEWS_RESEARCH_RESPONSE_SECRET: '11'.repeat(32),
      MANUAL_NEWS_RESEARCH_RESPONSE_KEY_ID: 'response-key-2026-08-11',
    } as never, { researchFetcher: fetcher });
    const letter = await adapters.extract(await adapters.fetch('https://www.sanders.senate.gov/letter.pdf'));
    const report = await adapters.extract(await adapters.fetch('https://www.axios.com/report'));
    expect(letter).toMatchObject({
      source_type: 'original_document',
      reliable: true,
      fetch_audit: {
        source_content_type: 'application/pdf', extraction: 'pdf_text',
        actual_sizes: { source_bytes: 48_000 },
        parser: { result: 'success', version: 'research-gateway-parser/1.0.0' },
      },
    });
    expect(report).toMatchObject({ source_type: 'independent_media', reliable: true });
    const evidence = [letter!, report!];
    const assessed = validateManualLeadAssessment({
      title: '美国参议员伯尼·桑德斯呼吁三家AI公司暂停AI开发',
      summary: '美国参议员伯尼·桑德斯呼吁三家AI公司暂停AI开发。',
      event_key: 'sanders-ai-pause-letter-2026-08-10', event_type: 'political_regulatory',
      material_update: false, score: 88, recommendation: 'recommended', occurred_at: null,
      uncertainties: ['公开信未提供有约束力的法律措施。'],
      claims: [
        {
          text: '美国参议员伯尼·桑德斯呼吁三家AI公司暂停AI开发。',
          evidence_ids: evidence.map((item) => item.id),
        },
      ],
      matched_event_key: null,
    }, evidence);
    expect(applyManualLeadEvidencePolicy(assessed, evidence))
      .toMatchObject({ recommendation: 'recommended', evidence_tier: 'original_plus_independent' });
  });
});
