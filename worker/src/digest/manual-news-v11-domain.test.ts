import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalA11,
  canonicalH11,
  canonicalP11,
  canonicalV11,
  dispatchManualNewsV11Canonical,
  validateManualNewsV11EnvelopeDag,
} from './manual-news-v11-domain';

const D1 = '1'.repeat(64);
const D2 = '2'.repeat(64);
const D3 = '3'.repeat(64);
const D4 = '4'.repeat(64);
const ASSESSMENT_DIGEST = '635db59e6018433bbb6cd18243f9a7635d72ceb05744548e0ca683f427611e3d';
const PROVENANCE_DIGEST = 'a5c51700296422ddb5394d996db171499f1310121a6c7c9baa7c9adff53d60c7';
const VERIFICATION_DIGEST = '0c4a32ca581993ff4810738576c801647217608bf9a878a81b057613e0cb30f1';
const CONTRACT = 'manual-news-v11-spec-v6';
const PROFILE = 'unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2';
const LEAD = 'ml-20260814-0123456789ab';
const EVENT = 'openai:gpt-5-release-2026-08-14';
const VERSION = 9_000_001;
const PRIOR = {
  assessment_version: 8_000_001,
  event_key: 'openai:gpt-5-preview-2026-08-13',
  lead_id: 'ml-20260813-fedcba987654',
  policy_version: 'fact-evidence-projection-hmac-v10',
  review_date: '2026-08-13',
  verification_digest: D4,
};

function bundle() {
  const assessment = { assessment: {
    assessment_payload_digest: D1, assessment_version: VERSION, contract_version: CONTRACT,
    domain: 'A', event_key: EVENT, lead_id: LEAD, prior_verifications: [PRIOR], profile: PROFILE,
  } };
  const provenance = { provenance: {
    assessment_version: VERSION, contract_version: CONTRACT, domain: 'P', event_key: EVENT,
    lead_id: LEAD, profile: PROFILE, provenance_payload_digest: D2,
    response_key_ids: ['response-key-2026-08-14'],
  } };
  const verification = { verification: {
    assessment_digest: ASSESSMENT_DIGEST, assessment_version: VERSION, contract_version: CONTRACT,
    domain: 'V', event_key: EVENT, lead_id: LEAD,
    policy_version: 'fact-evidence-projection-hmac-v11', prior_verifications: [PRIOR], profile: PROFILE,
    provenance_digest: PROVENANCE_DIGEST, verification_payload_digest: D3,
  } };
  const hmac = { hmac: {
    assessment_version: VERSION, contract_version: CONTRACT, domain: 'H', event_key: EVENT,
    hmac_algorithm: 'hmac-sha256', lead_id: LEAD,
    policy_version: 'fact-evidence-projection-hmac-v11', profile: PROFILE,
    response_key_ids: ['response-key-2026-08-14'], verification_digest: VERIFICATION_DIGEST,
    verification_key_id: 'verification-key-2026-08-14',
  } };
  return { assessment, provenance, verification, hmac };
}

const GOLDEN_A = `{"assessment":{"assessment_payload_digest":"${D1}","assessment_version":9000001,"contract_version":"manual-news-v11-spec-v6","domain":"A","event_key":"openai:gpt-5-release-2026-08-14","lead_id":"ml-20260814-0123456789ab","prior_verifications":[{"assessment_version":8000001,"event_key":"openai:gpt-5-preview-2026-08-13","lead_id":"ml-20260813-fedcba987654","policy_version":"fact-evidence-projection-hmac-v10","review_date":"2026-08-13","verification_digest":"${D4}"}],"profile":"unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2"}}`;
const GOLDEN_P = `{"provenance":{"assessment_version":9000001,"contract_version":"manual-news-v11-spec-v6","domain":"P","event_key":"openai:gpt-5-release-2026-08-14","lead_id":"ml-20260814-0123456789ab","profile":"unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2","provenance_payload_digest":"${D2}","response_key_ids":["response-key-2026-08-14"]}}`;
const GOLDEN_V = `{"verification":{"assessment_digest":"${ASSESSMENT_DIGEST}","assessment_version":9000001,"contract_version":"manual-news-v11-spec-v6","domain":"V","event_key":"openai:gpt-5-release-2026-08-14","lead_id":"ml-20260814-0123456789ab","policy_version":"fact-evidence-projection-hmac-v11","prior_verifications":[{"assessment_version":8000001,"event_key":"openai:gpt-5-preview-2026-08-13","lead_id":"ml-20260813-fedcba987654","policy_version":"fact-evidence-projection-hmac-v10","review_date":"2026-08-13","verification_digest":"${D4}"}],"profile":"unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2","provenance_digest":"${PROVENANCE_DIGEST}","verification_payload_digest":"${D3}"}}`;
const GOLDEN_H = `{"hmac":{"assessment_version":9000001,"contract_version":"manual-news-v11-spec-v6","domain":"H","event_key":"openai:gpt-5-release-2026-08-14","hmac_algorithm":"hmac-sha256","lead_id":"ml-20260814-0123456789ab","policy_version":"fact-evidence-projection-hmac-v11","profile":"unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2","response_key_ids":["response-key-2026-08-14"],"verification_digest":"${VERIFICATION_DIGEST}","verification_key_id":"verification-key-2026-08-14"}}`;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('manual-news v11 envelope-only canonical domain', () => {
  it('keeps static A/P/V/H literal goldens and the frozen digest chain', async () => {
    const values = bundle();
    expect(canonicalA11(values.assessment)).toBe(GOLDEN_A);
    expect(canonicalP11(values.provenance)).toBe(GOLDEN_P);
    expect(canonicalV11(values.verification)).toBe(GOLDEN_V);
    expect(canonicalH11(values.hmac)).toBe(GOLDEN_H);
    expect(digest(GOLDEN_A)).toBe(ASSESSMENT_DIGEST);
    expect(digest(GOLDEN_P)).toBe(PROVENANCE_DIGEST);
    expect(digest(GOLDEN_V)).toBe(VERIFICATION_DIGEST);
    expect(createHmac('sha256', '0'.repeat(64)).update(GOLDEN_H).digest('hex'))
      .toBe('c76e142c73d80908cd183bbb65c58cb4c1320c0617367190d615c3af403b5290');
    await expect(validateManualNewsV11EnvelopeDag(values)).resolves.toEqual(values);
  });

  it('uses primitive exact dispatch and matching roots only', () => {
    const values = bundle();
    expect(dispatchManualNewsV11Canonical({ kind: 'A', value: values.assessment })).toBe(GOLDEN_A);
    expect(dispatchManualNewsV11Canonical({ kind: 'P', value: values.provenance })).toBe(GOLDEN_P);
    expect(dispatchManualNewsV11Canonical({ kind: 'V', value: values.verification })).toBe(GOLDEN_V);
    expect(dispatchManualNewsV11Canonical({ kind: 'H', value: values.hmac })).toBe(GOLDEN_H);
    for (const input of [
      { kind: 'a', value: values.assessment }, { kind: new String('A'), value: values.assessment },
      { kind: 'A', value: values.provenance }, { kind: 'A' },
      { kind: 'A', value: values.assessment, extra: true },
    ]) expect(() => dispatchManualNewsV11Canonical(input)).toThrow('manual_news_v11_domain_invalid');
  });

  it('rejects envelope vectors E01-E11 for malformed domain values and broken DAG bindings', async () => {
    const values = bundle();
    const malformed = structuredClone(values) as ReturnType<typeof bundle>;
    Object.defineProperty(malformed.assessment.assessment, 'hidden', { value: true });
    const symbol = structuredClone(values) as ReturnType<typeof bundle>;
    Object.defineProperty(symbol.provenance.provenance, Symbol('extra'), { value: true });
    const accessor = structuredClone(values) as ReturnType<typeof bundle>;
    Object.defineProperty(accessor.verification.verification, 'event_key', { enumerable: true, get: () => EVENT });
    const inherited = structuredClone(values) as ReturnType<typeof bundle>;
    Object.setPrototypeOf(inherited.hmac.hmac, { inherited: true });
    const sparse = structuredClone(values) as ReturnType<typeof bundle>;
    sparse.provenance.provenance.response_key_ids = Array(1) as unknown as string[];
    const invalids: Array<[string, unknown]> = [
      ['A', malformed.assessment], ['P', symbol.provenance], ['V', accessor.verification], ['H', inherited.hmac],
      ['A', { assessment: { ...values.assessment.assessment, contract_version: 'wrong' } }],
      ['A', { assessment: { ...values.assessment.assessment, lead_id: 'bad' } }],
      ['A', { assessment: { ...values.assessment.assessment, event_key: 'e\u0301' } }],
      ['A', { assessment: { ...values.assessment.assessment, assessment_version: 1.5 } }],
      ['A', { assessment: { ...values.assessment.assessment, canonical_digest: D1 } }],
      ['P', { provenance: { ...values.provenance.provenance, hmac_sha256: D1 } }],
      ['P', sparse.provenance],
    ];
    for (const [kind, value] of invalids) expect(() => dispatchManualNewsV11Canonical({ kind, value })).toThrow('manual_news_v11_domain_invalid');

    const priorBad = structuredClone(values) as ReturnType<typeof bundle>;
    priorBad.assessment.assessment.prior_verifications = [{ ...PRIOR, lead_id: LEAD }];
    const priorMismatch = structuredClone(values) as ReturnType<typeof bundle>;
    priorMismatch.verification.verification.prior_verifications = [];
    const responseMismatch = structuredClone(values) as ReturnType<typeof bundle>;
    responseMismatch.hmac.hmac.response_key_ids = ['another-response-key'];
    const swapped = structuredClone(values) as ReturnType<typeof bundle>;
    swapped.verification.verification.assessment_digest = PROVENANCE_DIGEST;
    const hMismatch = structuredClone(values) as ReturnType<typeof bundle>;
    hMismatch.hmac.hmac.verification_digest = ASSESSMENT_DIGEST;
    for (const input of [priorBad, priorMismatch, responseMismatch, swapped, hMismatch]) {
      await expect(validateManualNewsV11EnvelopeDag(input)).rejects.toThrow('manual_news_v11_domain_invalid');
    }
  });

  it('rejects envelope vectors E12-E22 for bounded collections and forbidden fields', () => {
    const values = bundle();
    const priorUnsorted = { assessment: { ...values.assessment.assessment, prior_verifications: [
      { ...PRIOR, lead_id: 'ml-20260814-aaaaaaaaaaaa' }, PRIOR,
    ] } };
    const priorDuplicate = { assessment: { ...values.assessment.assessment, prior_verifications: [PRIOR, PRIOR] } };
    const priorCap = { assessment: { ...values.assessment.assessment, prior_verifications: Array.from({ length: 21 }, (_, index) => ({
      ...PRIOR, lead_id: `ml-202608${String(index + 1).padStart(2, '0')}-aaaaaaaaaaaa`, verification_digest: index.toString(16).padStart(64, '0'),
    })) } };
    const badDate = { assessment: { ...values.assessment.assessment, prior_verifications: [{ ...PRIOR, review_date: '2026-02-30' }] } };
    const responseDuplicate = { provenance: { ...values.provenance.provenance, response_key_ids: ['response-key-2026-08-14', 'response-key-2026-08-14'] } };
    const responseUnsorted = { provenance: { ...values.provenance.provenance, response_key_ids: ['z-key', 'a-key'] } };
    const forbiddenV = { verification: { ...values.verification.verification, hmac_sha256: D1 } };
    const forbiddenH = { hmac: { ...values.hmac.hmac, canonical_digest: D1 } };
    const unsafe = { assessment: { ...values.assessment.assessment, assessment_version: Number.MAX_SAFE_INTEGER + 1 } };
    const negativeZero = { assessment: { ...values.assessment.assessment, assessment_version: -0 } };
    const cycle = { assessment: { ...values.assessment.assessment } as Record<string, unknown> };
    cycle.assessment.assessment_payload_digest = cycle;
    for (const [kind, value] of [
      ['A', priorUnsorted], ['A', priorDuplicate], ['A', priorCap], ['A', badDate],
      ['P', responseDuplicate], ['P', responseUnsorted], ['V', forbiddenV], ['H', forbiddenH],
      ['A', unsafe], ['A', negativeZero], ['A', cycle],
    ] as const) expect(() => dispatchManualNewsV11Canonical({ kind, value })).toThrow('manual_news_v11_domain_invalid');
  });

  it('rejects E23 when a queued caller mutation tries to repair an invalid DAG during hashing', async () => {
    const values = bundle();
    values.verification.verification.assessment_digest = '0'.repeat(64);
    const pending = validateManualNewsV11EnvelopeDag(values);
    queueMicrotask(() => {
      values.verification.verification.assessment_digest = ASSESSMENT_DIGEST;
    });
    await expect(pending).rejects.toThrow('manual_news_v11_domain_invalid');
  });

  it('returns E24 a detached snapshot unaffected by caller mutation after invocation', async () => {
    const values = bundle();
    const pending = validateManualNewsV11EnvelopeDag(values);
    values.assessment.assessment.assessment_payload_digest = '9'.repeat(64);
    const snapshot = await pending;
    expect(snapshot).not.toBe(values);
    expect(snapshot.assessment).not.toBe(values.assessment);
    expect(snapshot.assessment.assessment.assessment_payload_digest).toBe(D1);
    expect(canonicalA11(snapshot.assessment)).toBe(GOLDEN_A);
  });

  it('returns E25 a recursively frozen snapshot', async () => {
    const snapshot = await validateManualNewsV11EnvelopeDag(bundle());
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.assessment)).toBe(true);
    expect(Object.isFrozen(snapshot.assessment.assessment.prior_verifications)).toBe(true);
    expect(() => {
      snapshot.assessment.assessment.assessment_payload_digest = '9'.repeat(64);
    }).toThrow(TypeError);
    expect(snapshot.assessment.assessment.assessment_payload_digest).toBe(D1);
  });
});
