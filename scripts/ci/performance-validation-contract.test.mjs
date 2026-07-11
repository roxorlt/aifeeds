import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const readWorkflow = (name) => readFileSync(resolve(root, `.github/workflows/${name}`), 'utf8');
const operations = readFileSync(resolve(root, 'docs/operations.md'), 'utf8');
const perfStagingChangePacket = readFileSync(
  resolve(root, 'docs/reviews/c-end-perf-staging-change-packet.md'),
  'utf8',
);
const rolloutTemplate = readFileSync(
  resolve(root, 'docs/reviews/c-end-performance-rollout-template.md'),
  'utf8',
);

function assertLatestRunWinsByDeploymentTarget(workflow, name) {
  assert.match(workflow, new RegExp(`concurrency:\\s*\\n\\s+group:\\s*${name}-`));
  assert.match(workflow, /group:.*inputs\.env/);
  assert.match(workflow, /group:.*github\.ref_name\s*==\s*'main'.*'prod'.*'staging'/);
  assert.match(workflow, /cancel-in-progress:\s*true/);
}

function assertProductionRefGuard(workflow) {
  assert.match(
    workflow,
    /if \[ "\$TARGET" = "prod" \] && \[ "\$\{GITHUB_REF:-\}" != "refs\/heads\/main" \]; then/,
  );
  assert.match(workflow, /exit 1/);
}

test('dashboard deploy keeps the complete frontend gate ahead of deployment', () => {
  const workflow = readWorkflow('deploy-dashboard.yml');

  for (const command of [
    'npx playwright install --with-deps chromium webkit',
    'npx playwright install-deps chromium webkit',
    'npm run lint',
    'npm run test:unit',
    'npm run build',
    'npm run test:e2e',
  ]) {
    assert.ok(workflow.includes(command), `dashboard deploy gate missing: ${command}`);
  }
  assert.match(workflow, /needs:\s*validate-before-deploy/);
});

test('worker deploy typechecks, tests, and packages before deployment', () => {
  const workflow = readWorkflow('deploy-worker.yml');

  assert.ok(workflow.includes('npx tsc --noEmit'));
  assert.ok(workflow.includes('npm test'));
  assert.ok(workflow.includes('npx wrangler deploy --dry-run'));
  assert.doesNotMatch(workflow, /if:\s*false/);
  assert.match(workflow, /needs:\s*validate-before-deploy/);
});

test('dashboard and worker deploys cancel stale runs by normalized target', () => {
  assertLatestRunWinsByDeploymentTarget(readWorkflow('deploy-dashboard.yml'), 'deploy-dashboard');
  assertLatestRunWinsByDeploymentTarget(readWorkflow('deploy-worker.yml'), 'deploy-worker');
});

test('manual production deploys fail closed outside refs/heads/main', () => {
  assertProductionRefGuard(readWorkflow('deploy-dashboard.yml'));
  assertProductionRefGuard(readWorkflow('deploy-worker.yml'));
});

test('operations documents the active worker typecheck gate', () => {
  assert.doesNotMatch(operations, /validate tsc step 当前 `if: false`/);
  assert.match(operations, /Worker TypeScript baseline 已清零/);
});

test('PR validation tracks and executes performance operations checks', () => {
  const workflow = readWorkflow('pr-validation.yml');

  for (const path of [
    "'deploy/**'",
    "'scripts/benchmark-aifeeds-upstream*'",
    "'scripts/run-aifeeds-staging-backfill*'",
    "'docs/operations.md'",
    "'docs/reviews/c-end-perf-staging-change-packet.md'",
    "'docs/reviews/c-end-performance-rollout-template.md'",
  ]) {
    assert.ok(workflow.includes(path), `PR path trigger missing: ${path}`);
  }
  assert.ok(
    (workflow.match(/docs\/reviews\/c-end-performance-rollout-template[.]md/g) ?? []).length >= 2,
    'rollout template must trigger the workflow and the performance_ops job',
  );
  assert.match(workflow, /performance_ops:\s*\$\{\{\s*steps\.filter\.outputs\.performance_ops\s*\}\}/);
  assert.match(workflow, /validate-performance-ops:/);
  assert.ok(workflow.includes('scripts/benchmark-aifeeds-upstream.test.mjs'));
  assert.ok(workflow.includes('scripts/run-aifeeds-staging-backfill.test.mjs'));
  assert.ok(workflow.includes('deploy/nginx/*.test.mjs'));
  assert.ok(workflow.includes('deploy/nginx/check-nginx-request-id.test.py'));
  assert.ok(workflow.includes('scripts/ci/performance-validation-contract.test.mjs'));
});

test('nginx 1.24 keepalive experiment is blocked instead of installable', () => {
  assert.match(operations, /nginx 1\.24\.0/);
  assert.match(operations, /keepalive[^\n]*BLOCKED|BLOCKED[^\n]*keepalive/i);
  assert.match(operations, /1\.27\.3/);
  assert.match(operations, /aifeeds-upstream-performance\.conf[\s\S]{0,160}?不得安装/);
});

test('perf-staging change packet is fail-closed and independently reversible', () => {
  for (const required of [
    'DNS-only',
    'aifeeds-perf-staging-bootstrap.conf',
    'aifeeds-perf-staging-server.conf',
    'nginx -t',
    'certbot certonly --webroot',
    'xlist-dashboard-perf',
    'github-cover-backfill',
    'card-image-variant-backfill',
    'migration 028',
    'aifeeds-performance-log.conf',
    '回滚',
  ]) {
    assert.ok(perfStagingChangePacket.includes(required), `change packet missing: ${required}`);
  }
  assert.match(perfStagingChangePacket, /每个远端写动作[^\n]*单独审批/);
  assert.match(perfStagingChangePacket, /不(?:设置|发送)[\s\S]{0,80}?X-Origin-Secret/);
  assert.match(perfStagingChangePacket, /keepalive[^\n]*BLOCKED|BLOCKED[^\n]*keepalive/i);
  assert.match(perfStagingChangePacket, /favorite[^\n]*N\/A/);
  assert.doesNotMatch(perfStagingChangePacket, /favorite 添加\/取消/);
  assert.match(perfStagingChangePacket, /真实访客 IP[^\n]*per-IP 限流/);
  assert.match(perfStagingChangePacket, /production origin gate/);
  assert.match(perfStagingChangePacket, /SMS 禁用态[^\n]*空 JSON/);
  assert.match(perfStagingChangePacket, /reason=sms_disabled/);
  assert.match(perfStagingChangePacket, /GL[^\n]*production VPS\/nginx 写/);
  assert.match(perfStagingChangePacket, /Task 3 JSONL/);
  assert.match(perfStagingChangePacket, /card-variant-spike-candidate\.json/);
  assert.match(perfStagingChangePacket, /card-variant-spike-assets\.signature\.json/);
  assert.match(perfStagingChangePacket, /CONTENT_LENGTH/);
  assert.match(perfStagingChangePacket, /sips -g pixelWidth/);
  assert.match(perfStagingChangePacket, /map\(\.width\) == \[400, 800\]/);
  assert.match(perfStagingChangePacket, /EXPECTED_PREFIX/);
  assert.match(perfStagingChangePacket, /test "\$ASSET_SHA256" = "\$URL_SHA256"/);
  assert.match(perfStagingChangePacket, /不能把 nullable `next_cursor` 猜成/);
  assert.ok(
    (perfStagingChangePacket.match(/\.status\) == "complete"/g) ?? []).length >= 2,
    'both write backfills must reject a bounded pause as gate completion',
  );
  assert.match(perfStagingChangePacket, /"sources":\["news","x"\]/);
  assert.doesNotMatch(perfStagingChangePacket, /"sources":\["blog","podcast"\]/);
  assert.ok(
    (perfStagingChangePacket.match(/Authorization: Bearer \$CF_DNS_API_TOKEN/g) ?? []).length >= 3,
    'DNS read/create/delete must use the scoped DNS token',
  );
  assert.doesNotMatch(perfStagingChangePacket, /Authorization: Bearer \$CLOUDFLARE_API_TOKEN/);
  assert.match(perfStagingChangePacket, /G6c credential gate 当前 BLOCKED/);
  assert.match(perfStagingChangePacket, /test:e2e:perf-staging/);
  assert.match(perfStagingChangePacket, /E2E_OUTPUT_DIR="\$EVIDENCE\/playwright"/);
  assert.match(perfStagingChangePacket, /E2E_PERF_PROBE="\$E2E_PERF_PROBE"/);
  assert.match(perfStagingChangePacket, /PLAYWRIGHT_NO_COPY_PROMPT=1/);
  assert.match(perfStagingChangePacket, /PLAYWRIGHT_STATUS=\$\?/);
  assert.match(perfStagingChangePacket, /-iname '\*\.md'/);
  assert.match(perfStagingChangePacket, /nginx-worker-join-summary\.json/);
  assert.match(perfStagingChangePacket, /tail -n 20000 \/var\/log\/nginx\/aifeeds-performance\.jsonl/);
  assert.match(perfStagingChangePacket, /request_id_join/);
  assert.match(perfStagingChangePacket, /browser_request_ids_joined/);
  assert.match(perfStagingChangePacket, /matching_rows >= 6/);
  assert.match(perfStagingChangePacket, /codex_perf_probe=1/);
  assert.match(perfStagingChangePacket, /workerStart>0/);
  assert.match(perfStagingChangePacket, /aifeeds:feed-ready/);
  assert.match(perfStagingChangePacket, /cold feed-ready ≤5s \/ LCP ≤7s/);
  assert.match(perfStagingChangePacket, /CLS[^\n]*≤0\.1/);
  assert.match(perfStagingChangePacket, /feed-ready cutoff/);
  assert.match(perfStagingChangePacket, /CLS 记录 `unsupported`/);
  assert.match(perfStagingChangePacket, /desktop=`x_list \+ blog,podcast \+ product_hunt`/);
  assert.match(perfStagingChangePacket, /卡图 `\/r\/`[\s\S]{0,120}?staging-api\.ai-feeds\.com/);
  assert.match(perfStagingChangePacket, /video poster/);
  assert.match(perfStagingChangePacket, /aifeeds:cls-settled/);
  assert.match(perfStagingChangePacket, /非受信任[^\n]*pointerdown/);
  assert.match(perfStagingChangePacket, /BROWSER_UA='Mozilla\/5\.0/);
  assert.match(perfStagingChangePacket, /dns-operation-id\.txt/);
  assert.match(perfStagingChangePacket, /\.dns-operation\.lock/);
  assert.match(perfStagingChangePacket, /dns-create-prepared\.txt/);
  assert.match(
    perfStagingChangePacket,
    /attempted_tmp=.*&&[\s\S]{0,300}?mv .*ATTEMPTED_FILE.*&&[\s\S]{0,120}?exec curl -sS/,
  );
  assert.match(perfStagingChangePacket, /exec curl -sS/);
  assert.match(perfStagingChangePacket, /another DNS create\/rollback process/);
  assert.match(perfStagingChangePacket, /comment:\$comment/);
  assert.match(perfStagingChangePacket, /aifeeds-perf-staging-dns\\\.\[A-Za-z0-9\]/);
  assert.match(perfStagingChangePacket, /mktemp -d \/run\/aifeeds-perf-staging\.XXXXXX/);
  assert.match(perfStagingChangePacket, /aifeeds-perf-staging-nginx\.lock/);
  assert.match(perfStagingChangePacket, /SITE_CREATED=0/);
  assert.match(perfStagingChangePacket, /LINK_CREATED=0/);
  assert.match(perfStagingChangePacket, /if \[ "\$LINK_CREATED" = 1 \]/);
  assert.match(perfStagingChangePacket, /if \[ "\$SITE_CREATED" = 1 \]/);
  assert.match(perfStagingChangePacket, /nginx-bootstrap-remote\.sha256/);
  assert.match(perfStagingChangePacket, /nginx-final-remote\.sha256/);
  assert.doesNotMatch(perfStagingChangePacket, /\/tmp\/aifeeds-perf-staging-(?:bootstrap|server)\.conf/);
  assert.doesNotMatch(perfStagingChangePacket, /\/tmp\/perf-staging-/);
  assert.doesNotMatch(perfStagingChangePacket, /\$EVIDENCE\/worker-smoke\.json/);
  assert.doesNotMatch(perfStagingChangePacket, /\$EVIDENCE\/[^\n]*gzip-decoded\.json/);
  assert.doesNotMatch(perfStagingChangePacket, /\$EVIDENCE\/card-variant-spike-item\.json/);
  assert.match(perfStagingChangePacket, /aifeeds-perf-g1\.XXXXXX/);
  assert.match(perfStagingChangePacket, /aifeeds-perf-g2\.XXXXXX/);
  assert.match(perfStagingChangePacket, /aifeeds-perf-g4b1\.XXXXXX/);
});

test('rollout evidence is privacy-safe and distinguishes cold from warm service worker', () => {
  assert.match(rolloutTemplate, /cold-warm-page-performance\.json/);
  assert.match(rolloutTemplate, /workerStart/);
  assert.match(rolloutTemplate, /feed-ready/);
  assert.match(rolloutTemplate, /cold feed-ready ≤5s/);
  assert.match(rolloutTemplate, /CLS ≤0\.1/);
  assert.match(rolloutTemplate, /feed-ready 作为请求竞争 cutoff/);
  assert.match(rolloutTemplate, /video poster/);
  assert.match(rolloutTemplate, /字体[^\n]*CLS|CLS[^\n]*字体/);
  assert.match(rolloutTemplate, /禁止[\s\S]{0,40}?URL、query、item id/);
  assert.match(rolloutTemplate, /禁止 trace、HAR、截图、录像、HTML report 和 storageState/);
  assert.doesNotMatch(rolloutTemplate, /waterfall、trace、截图\/HAR 链接/);
});
