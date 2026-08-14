import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { expect, test } from 'vitest';

const workerRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

test('workerd matches the pinned Unicode and v11 literal goldens', async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { normalizeNfc15, normalizeNfkc15, segmentExtendedGraphemes15 } from './src/digest/manual-news-unicode15.ts';
        import { canonicalJsonV2 } from './src/digest/manual-news-canonical-json-v2.ts';
        import {
          canonicalA11, canonicalH11, canonicalP11, canonicalV11,
          validateManualNewsV11EnvelopeDag,
        } from './src/digest/manual-news-v11-domain.ts';
        const hex = (bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        const sha256 = async (value) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
        const hmac = async (value) => {
          const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('0'.repeat(64)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
          return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
        };
        export default { async fetch() {
          const prior = {
            assessment_version: 8000001, event_key: 'openai:gpt-5-preview-2026-08-13',
            lead_id: 'ml-20260813-fedcba987654', policy_version: 'fact-evidence-projection-hmac-v10',
            review_date: '2026-08-13', verification_digest: '4'.repeat(64),
          };
          const assessment = { assessment: {
            assessment_payload_digest: '1'.repeat(64), assessment_version: 9000001,
            contract_version: 'manual-news-v11-spec-v6', domain: 'A',
            event_key: 'openai:gpt-5-release-2026-08-14', lead_id: 'ml-20260814-0123456789ab',
            prior_verifications: [prior], profile: 'unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2',
          } };
          const provenance = { provenance: {
            assessment_version: 9000001, contract_version: 'manual-news-v11-spec-v6', domain: 'P',
            event_key: 'openai:gpt-5-release-2026-08-14', lead_id: 'ml-20260814-0123456789ab',
            profile: 'unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2', provenance_payload_digest: '2'.repeat(64),
            response_key_ids: ['response-key-2026-08-14'],
          } };
          const verification = { verification: {
            assessment_digest: '635db59e6018433bbb6cd18243f9a7635d72ceb05744548e0ca683f427611e3d',
            assessment_version: 9000001, contract_version: 'manual-news-v11-spec-v6', domain: 'V',
            event_key: 'openai:gpt-5-release-2026-08-14', lead_id: 'ml-20260814-0123456789ab',
            policy_version: 'fact-evidence-projection-hmac-v11', prior_verifications: [prior],
            profile: 'unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2',
            provenance_digest: 'a5c51700296422ddb5394d996db171499f1310121a6c7c9baa7c9adff53d60c7',
            verification_payload_digest: '3'.repeat(64),
          } };
          const hmacDomain = { hmac: {
            assessment_version: 9000001, contract_version: 'manual-news-v11-spec-v6', domain: 'H',
            event_key: 'openai:gpt-5-release-2026-08-14', hmac_algorithm: 'hmac-sha256',
            lead_id: 'ml-20260814-0123456789ab', policy_version: 'fact-evidence-projection-hmac-v11',
            profile: 'unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2',
            response_key_ids: ['response-key-2026-08-14'],
            verification_digest: '0c4a32ca581993ff4810738576c801647217608bf9a878a81b057613e0cb30f1',
            verification_key_id: 'verification-key-2026-08-14',
          } };
          await validateManualNewsV11EnvelopeDag({ assessment, provenance, verification, hmac: hmacDomain });
          const invalidDag = structuredClone({ assessment, provenance, verification, hmac: hmacDomain });
          invalidDag.verification.verification.assessment_digest = '0'.repeat(64);
          const invalidPending = validateManualNewsV11EnvelopeDag(invalidDag);
          queueMicrotask(() => {
            invalidDag.verification.verification.assessment_digest = '635db59e6018433bbb6cd18243f9a7635d72ceb05744548e0ca683f427611e3d';
          });
          let queuedMutationRejected = false;
          try { await invalidPending; } catch { queuedMutationRejected = true; }
          const callerDag = structuredClone({ assessment, provenance, verification, hmac: hmacDomain });
          const callerPending = validateManualNewsV11EnvelopeDag(callerDag);
          callerDag.assessment.assessment.assessment_payload_digest = '9'.repeat(64);
          const snapshot = await callerPending;
          const immediateCallerMutationDetached = snapshot.assessment.assessment.assessment_payload_digest === '1'.repeat(64);
          const originalPriorDigest = snapshot.assessment.assessment.prior_verifications[0].verification_digest;
          const originalResponseKeyId = snapshot.provenance.provenance.response_key_ids[0];
          callerDag.assessment.assessment.prior_verifications[0].verification_digest = '9'.repeat(64);
          callerDag.provenance.provenance.response_key_ids[0] = 'another-response-key';
          let returnedMutationRejected = false;
          try { snapshot.assessment.assessment.assessment_payload_digest = '9'.repeat(64); } catch { returnedMutationRejected = true; }
          let returnedArrayMutationRejected = false;
          try { snapshot.provenance.provenance.response_key_ids.push('another-response-key'); } catch { returnedArrayMutationRejected = true; }
          const a = canonicalA11(assessment); const p = canonicalP11(provenance);
          const v = canonicalV11(verification); const h = canonicalH11(hmacDomain);
          return Response.json({
            nfc: normalizeNfc15('e\\u0301'),
            nfkc: normalizeNfkc15('①ﬃＡ'),
            graphemes: segmentExtendedGraphemes15('👩‍💻'),
            canonical: canonicalJsonV2({ '\\u{10000}': 'astral', '\\uE000': 'bmp' }),
            a, p, v, h, assessment_digest: await sha256(a), provenance_digest: await sha256(p),
            verification_digest: await sha256(v), hmac_sha256: await hmac(h),
            queuedMutationRejected,
            immediateCallerMutationDetached,
            detachedSnapshot: snapshot.assessment.assessment.prior_verifications[0].verification_digest === originalPriorDigest
              && snapshot.provenance.provenance.response_key_ids[0] === originalResponseKeyId,
            recursivelyFrozen: Object.isFrozen(snapshot) && Object.isFrozen(snapshot.assessment)
              && Object.isFrozen(snapshot.assessment.assessment.prior_verifications),
            returnedMutationRejected,
            returnedArrayMutationRejected,
          });
        } };
      `,
      resolveDir: workerRoot,
      sourcefile: 'manual-news-unicode15-workerd-entry.ts',
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
  });
  const miniflare = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0].text,
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    log: new Log(LogLevel.NONE),
  });
  try {
    await miniflare.ready;
    const response = await miniflare.dispatchFetch('http://local.test/');
    expect(await response.json()).toEqual({
      nfc: 'é',
      nfkc: '1ffiA',
      graphemes: ['👩‍💻'],
      canonical: '{"\uE000":"bmp","𐀀":"astral"}',
      a: `{"assessment":{"assessment_payload_digest":"${'1'.repeat(64)}","assessment_version":9000001,"contract_version":"manual-news-v11-spec-v6","domain":"A","event_key":"openai:gpt-5-release-2026-08-14","lead_id":"ml-20260814-0123456789ab","prior_verifications":[{"assessment_version":8000001,"event_key":"openai:gpt-5-preview-2026-08-13","lead_id":"ml-20260813-fedcba987654","policy_version":"fact-evidence-projection-hmac-v10","review_date":"2026-08-13","verification_digest":"${'4'.repeat(64)}"}],"profile":"unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2"}}`,
      p: `{"provenance":{"assessment_version":9000001,"contract_version":"manual-news-v11-spec-v6","domain":"P","event_key":"openai:gpt-5-release-2026-08-14","lead_id":"ml-20260814-0123456789ab","profile":"unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2","provenance_payload_digest":"${'2'.repeat(64)}","response_key_ids":["response-key-2026-08-14"]}}`,
      v: `{"verification":{"assessment_digest":"635db59e6018433bbb6cd18243f9a7635d72ceb05744548e0ca683f427611e3d","assessment_version":9000001,"contract_version":"manual-news-v11-spec-v6","domain":"V","event_key":"openai:gpt-5-release-2026-08-14","lead_id":"ml-20260814-0123456789ab","policy_version":"fact-evidence-projection-hmac-v11","prior_verifications":[{"assessment_version":8000001,"event_key":"openai:gpt-5-preview-2026-08-13","lead_id":"ml-20260813-fedcba987654","policy_version":"fact-evidence-projection-hmac-v10","review_date":"2026-08-13","verification_digest":"${'4'.repeat(64)}"}],"profile":"unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2","provenance_digest":"a5c51700296422ddb5394d996db171499f1310121a6c7c9baa7c9adff53d60c7","verification_payload_digest":"${'3'.repeat(64)}"}}`,
      h: `{"hmac":{"assessment_version":9000001,"contract_version":"manual-news-v11-spec-v6","domain":"H","event_key":"openai:gpt-5-release-2026-08-14","hmac_algorithm":"hmac-sha256","lead_id":"ml-20260814-0123456789ab","policy_version":"fact-evidence-projection-hmac-v11","profile":"unicode-15.1.0-nfc-nfkc-egc-scalar-canonical-json-v2","response_key_ids":["response-key-2026-08-14"],"verification_digest":"0c4a32ca581993ff4810738576c801647217608bf9a878a81b057613e0cb30f1","verification_key_id":"verification-key-2026-08-14"}}`,
      assessment_digest: '635db59e6018433bbb6cd18243f9a7635d72ceb05744548e0ca683f427611e3d',
      provenance_digest: 'a5c51700296422ddb5394d996db171499f1310121a6c7c9baa7c9adff53d60c7',
      verification_digest: '0c4a32ca581993ff4810738576c801647217608bf9a878a81b057613e0cb30f1',
      hmac_sha256: 'c76e142c73d80908cd183bbb65c58cb4c1320c0617367190d615c3af403b5290',
      queuedMutationRejected: true,
      immediateCallerMutationDetached: true,
      detachedSnapshot: true,
      recursivelyFrozen: true,
      returnedMutationRejected: true,
      returnedArrayMutationRejected: true,
    });
  } finally {
    await miniflare.dispose();
  }
}, 15_000);
