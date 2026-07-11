import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const readWorkflow = (name) => readFileSync(resolve(root, `.github/workflows/${name}`), 'utf8');
const operations = readFileSync(resolve(root, 'docs/operations.md'), 'utf8');

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
    "'docs/operations.md'",
  ]) {
    assert.ok(workflow.includes(path), `PR path trigger missing: ${path}`);
  }
  assert.match(workflow, /performance_ops:\s*\$\{\{\s*steps\.filter\.outputs\.performance_ops\s*\}\}/);
  assert.match(workflow, /validate-performance-ops:/);
  assert.ok(workflow.includes('scripts/benchmark-aifeeds-upstream.test.mjs'));
  assert.ok(workflow.includes('deploy/nginx/*.test.mjs'));
  assert.ok(workflow.includes('deploy/nginx/check-nginx-request-id.test.py'));
  assert.ok(workflow.includes('scripts/ci/performance-validation-contract.test.mjs'));
});
