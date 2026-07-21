import assert from 'node:assert/strict';
import {
  chmod,
  cp,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPayload } from '../build-payload.mjs';

const remoteHarnessTest = process.env.AIFEEDS_REMOTE_PAYLOAD_TEST === '1'
  ? test.skip
  : test;

const SYNC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const LINUX_FS_HELPER = path.join(SYNC_DIR, 'deployment-linux-fs.py');

async function read(relativePath) {
  return readFile(path.join(SYNC_DIR, relativePath), 'utf8');
}

async function normalizeReleaseFixture(root, relative = '') {
  await chmod(root, 0o755);
  for (const name of await readdir(root)) {
    const child = path.join(root, name);
    const childRelative = relative ? `${relative}/${name}` : name;
    const identity = await stat(child);
    if (identity.isDirectory()) {
      await normalizeReleaseFixture(child, childRelative);
    } else {
      await chmod(child, new Set([
        'cc-site/deploy.sh',
        'cc-site/sync/deploy-to-cc.sh',
        'cc-site/sync/install-remote.sh',
      ]).has(childRelative) ? 0o755 : 0o644);
    }
  }
}

function manifestWithEnvironmentDigest(manifestBytes, environmentDigest) {
  const manifest = manifestBytes.toString('utf8');
  const replaced = manifest.replace(
    /^[0-9a-f]{64}  deploy\/cc-sync\.env$/m,
    `${environmentDigest}  deploy/cc-sync.env`,
  );
  assert.notEqual(replaced, manifest, 'fixture manifest must contain the environment record');
  return Buffer.from(replaced);
}

function section(content, name) {
  const startMarker = `[${name}]\n`;
  const start = content.indexOf(startMarker);
  assert.notEqual(start, -1, `missing [${name}] section`);
  const bodyStart = start + startMarker.length;
  const next = content.indexOf('\n[', bodyStart);
  return content.slice(bodyStart, next === -1 ? content.length : next);
}

function directives(content) {
  const result = new Map();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    assert.notEqual(equals, -1, `invalid directive: ${line}`);
    const name = line.slice(0, equals);
    const value = line.slice(equals + 1);
    const values = result.get(name) ?? [];
    values.push(value);
    result.set(name, values);
  }
  return result;
}

test('systemd service confines writes to state and item roots', async () => {
  const service = await read('aifeeds-cc-sync.service');
  const unit = directives(section(service, 'Unit'));
  const serviceDirectives = directives(section(service, 'Service'));

  assert.deepEqual(unit.get('After'), ['network-online.target']);
  assert.deepEqual(unit.get('Wants'), ['network-online.target']);
  assert.deepEqual(serviceDirectives.get('Type'), ['oneshot']);
  assert.deepEqual(serviceDirectives.get('User'), ['aifeeds-sync']);
  assert.deepEqual(serviceDirectives.get('Group'), ['www']);
  assert.deepEqual(serviceDirectives.get('UMask'), ['0027']);
  assert.deepEqual(serviceDirectives.get('EnvironmentFile'), [
    '/etc/aifeeds/cc-sync.env',
  ]);
  assert.deepEqual(serviceDirectives.get('ExecStart'), [
    '/usr/bin/node /opt/aifeeds-cc-sync/sync.mjs',
  ]);
  assert.deepEqual(serviceDirectives.get('TimeoutStartSec'), ['2h']);
  assert.deepEqual(serviceDirectives.get('ReadWritePaths'), [
    '/var/lib/aifeeds-cc-sync',
    '/www/wwwroot/ai-feeds.cc/i',
  ]);
  assert.deepEqual(serviceDirectives.get('NoNewPrivileges'), ['true']);
  assert.deepEqual(serviceDirectives.get('PrivateTmp'), ['true']);
  assert.deepEqual(serviceDirectives.get('ProtectHome'), ['true']);
  assert.deepEqual(serviceDirectives.get('ProtectSystem'), ['strict']);
  assert.equal(service.includes('/www/wwwroot/ai-feeds.cc/ai-news'), false);
  assert.equal(service.includes('ReadWritePaths=/etc'), false);
  assert.equal(service.includes('ReadWritePaths=/www/wwwroot/ai-feeds.cc\n'), false);
});

test('systemd timer schedules persistent ten-minute oneshots', async () => {
  const timer = await read('aifeeds-cc-sync.timer');
  const timerDirectives = directives(section(timer, 'Timer'));
  const installDirectives = directives(section(timer, 'Install'));

  assert.deepEqual(timerDirectives.get('OnBootSec'), ['2min']);
  assert.deepEqual(timerDirectives.get('OnUnitActiveSec'), ['10min']);
  assert.deepEqual(timerDirectives.get('RandomizedDelaySec'), ['30']);
  assert.deepEqual(timerDirectives.get('Persistent'), ['true']);
  assert.deepEqual(installDirectives.get('WantedBy'), ['timers.target']);
});

function strictSitemapPattern(nginx) {
  const match = /location ~ "([^"]+)" \{\n\s+alias \/var\/lib\/aifeeds-cc-sync\/public\/generations\/\$generation\/sitemaps\/\$sitemap;/.exec(
    nginx,
  );
  assert.ok(match, 'strict generation sitemap regex missing');
  return new RegExp(
    match[1]
      .replaceAll('\\A', '^')
      .replaceAll('\\z', '$')
      .replaceAll(/\(\?<[^>]+>/g, '('),
  );
}

function strictDomesticSitemapPattern(nginx) {
  const match = /location ~ "([^"]+)" \{\n\s+alias \/var\/lib\/aifeeds-cc-sync\/public\/current\/sitemap-cn-\$part\.xml;/.exec(
    nginx,
  );
  assert.ok(match, 'strict domestic sitemap regex missing');
  return new RegExp(
    match[1]
      .replaceAll('\\A', '^')
      .replaceAll('\\z', '$')
      .replaceAll(/\(\?<[^>]+>/g, '('),
  );
}

test('nginx exposes only generated content roots without shadowing auth', async () => {
  const nginx = await read('nginx-content-mirror.conf');

  assert.match(nginx, /location \^~ \/i\/ \{/);
  assert.match(
    nginx,
    /location \^~ \/ai-news\/ \{[^}]*root \/var\/lib\/aifeeds-cc-sync\/public\/current;/,
  );
  assert.doesNotMatch(
    nginx,
    /location \^~ \/ai-news\/ \{[^}]*alias /,
  );
  assert.match(
    nginx,
    /location \^~ \/ai-news\/ \{[^}]*try_files \$uri \$uri\/ \$uri\/index\.html =404;/,
  );
  assert.match(
    nginx,
    /location = \/sitemap\.xml \{[\s\S]*?alias \/var\/lib\/aifeeds-cc-sync\/public\/current\/sitemap\.xml;/,
  );
  assert.match(
    nginx,
    /location = \/sitemap-cn\.xml \{[\s\S]*?alias \/var\/lib\/aifeeds-cc-sync\/public\/current\/sitemap-cn\.xml;/,
  );
  assert.doesNotMatch(nginx, /location[^\n]*\/auth\/wechat/);
  assert.doesNotMatch(nginx, /location \^~ \/sitemaps\//);

  const strictLocation = nginx.indexOf('location ~ "\\A/sitemaps/');
  const catchAll = nginx.indexOf(
    'location ~ "\\A/sitemaps/" {\n    return 404;\n}',
  );
  assert.ok(strictLocation >= 0, 'strict sitemap location missing');
  assert.ok(catchAll > strictLocation, 'regex catch-all must follow strict regex');
  const strictBlockEnd = nginx.indexOf('\n}\n', strictLocation);
  assert.ok(strictBlockEnd > strictLocation, 'strict sitemap block is incomplete');
  assert.doesNotMatch(
    nginx.slice(strictBlockEnd + 3, catchAll),
    /location\s/,
  );
  for (const block of nginx.matchAll(/location[^\{]+\{([\s\S]*?)\n\}/g)) {
    assert.match(block[1], /Cache-Control "public, max-age=600" always|return 404/);
  }
});

test('nginx sitemap regex accepts only v4 generation UUIDs and allowlisted XML', async () => {
  const pattern = strictSitemapPattern(await read('nginx-content-mirror.conf'));
  const generation = '123e4567-e89b-42d3-a456-426614174000';

  for (const sitemap of [
    'archive.xml',
    'news-1.xml',
    'x-9.xml',
    'gh-10.xml',
    'ph-999.xml',
    'hf-paper-2.xml',
  ]) {
    assert.equal(pattern.test(`/sitemaps/${generation}/${sitemap}`), true);
  }

  for (const requestPath of [
    `/sitemaps/${generation}/news-0.xml`,
    `/sitemaps/${generation}/news-01.xml`,
    `/sitemaps/${generation}/state.json`,
    `/sitemaps/${generation}/../manifest.json`,
    `/sitemaps/${generation}/%2e%2e/manifest.json`,
    `/sitemaps/${generation}/news-1.xml/extra`,
    '/sitemaps/123e4567-e89b-12d3-a456-426614174000/news-1.xml',
    '/sitemaps/123E4567-E89B-42D3-A456-426614174000/news-1.xml',
    `/SITEMAPS/${generation}/news-1.xml`,
  ]) {
    assert.equal(pattern.test(requestPath), false, requestPath);
  }
});

test('nginx domestic sitemap regex accepts only four-digit positive stable leaves', async () => {
  const nginx = await read('nginx-content-mirror.conf');
  const pattern = strictDomesticSitemapPattern(nginx);

  for (const requestPath of [
    '/sitemap-cn-0001.xml',
    '/sitemap-cn-0010.xml',
    '/sitemap-cn-9999.xml',
  ]) {
    assert.equal(pattern.test(requestPath), true, requestPath);
  }
  for (const requestPath of [
    '/sitemap-cn-0000.xml',
    '/sitemap-cn-1.xml',
    '/sitemap-cn-00001.xml',
    '/sitemap-cn-abcd.xml',
    '/sitemap-cn-0001.xml/extra',
    '/SITEMAP-CN-0001.XML',
  ]) {
    assert.equal(pattern.test(requestPath), false, requestPath);
  }
  assert.match(
    nginx,
    /location ~ "\\A\/sitemap-cn\(\?:-\[\^\/\]\*\)\?\\\.xml\\z" \{\n\s+return 404;/,
  );
});

test('remote installer validates and byte-smokes the domestic index and first leaf', async () => {
  const installer = await read('install-remote.sh');
  assert.match(
    installer,
    /test -r "\$CURRENT\/sitemap-cn\.xml"/,
  );
  assert.match(
    installer,
    /test -r "\$CURRENT\/sitemap-cn-0001\.xml"/,
  );
  assert.match(
    installer,
    /smoke_exact domestic-sitemap-index[\s\S]*https:\/\/ai-feeds\.cc\/sitemap-cn\.xml[\s\S]*"\$CURRENT\/sitemap-cn\.xml"/,
  );
  assert.match(
    installer,
    /smoke_exact domestic-sitemap-leaf[\s\S]*https:\/\/ai-feeds\.cc\/sitemap-cn-0001\.xml[\s\S]*"\$CURRENT\/sitemap-cn-0001\.xml"/,
  );
});

test('vhost editor inserts one managed include into only the HTTPS site block', async () => {
  const { injectManagedInclude } = await import('../nginx-vhost-editor.mjs');
  const source = `server {\n  listen 80;\n  server_name ai-feeds.cc;\n  if ($server_port !~ 443) {\n    rewrite ^(?!/shenma-site-verification\\.txt$)(/.*)$ https://$host$1 permanent;\n  }\n}\n\nserver {\n  listen 443 ssl http2;\n  server_name ai-feeds.cc www.ai-feeds.cc;\n  #REWRITE-END\n  location ^~ /auth/wechat/ { proxy_pass http://127.0.0.1:3001; }\n  location ~ ".*\\.xml$" { return 418; }\n}\n`;

  const edited = injectManagedInclude(source);
  assert.equal(
    edited.match(/# AIFEEDS-CC-CONTENT-MIRROR-BEGIN/g)?.length,
    1,
  );
  assert.equal(
    edited.match(/include \/www\/server\/panel\/vhost\/nginx\/aifeeds-cc-content-mirror\.inc;/g)?.length,
    1,
  );
  assert.match(edited, /shenma-site-verification/);
  assert.match(edited, /location \^~ \/auth\/wechat\//);
  assert.ok(
    edited.indexOf(BEGIN_MARKER_FIXTURE)
      < edited.indexOf('location ~ ".*\\.xml$"'),
    'managed include must precede later broad regex locations',
  );
  assert.equal(injectManagedInclude(edited), edited);
});

const BEGIN_MARKER_FIXTURE = '# AIFEEDS-CC-CONTENT-MIRROR-BEGIN';

test('vhost editor fails closed for ambiguous or unmanaged include state', async () => {
  const { injectManagedInclude } = await import('../nginx-vhost-editor.mjs');
  const https = `server {\n listen 443 ssl;\n server_name ai-feeds.cc;\n #REWRITE-END\n}\n`;

  assert.throws(
    () => injectManagedInclude(`${https}${https}`),
    /exactly one HTTPS ai-feeds\.cc server block/,
  );
  assert.throws(
    () => injectManagedInclude(
      https.replace(
        '\n}',
        '\n include /www/server/panel/vhost/nginx/aifeeds-cc-content-mirror.inc;\n}',
      ),
    ),
    /unmanaged content mirror include/,
  );
  assert.throws(
    () => injectManagedInclude(
      https.replace('\n}', '\n # AIFEEDS-CC-CONTENT-MIRROR-BEGIN\n}'),
    ),
    /incomplete managed include markers/,
  );
  assert.throws(
    () => injectManagedInclude(https.replace(' #REWRITE-END\n', '')),
    /exactly one top-level Nginx rewrite marker/,
  );
  assert.throws(
    () => injectManagedInclude(
      https.replace(
        ' #REWRITE-END\n',
        ' location ~ ".*\\.xml$" { return 418; }\n #REWRITE-END\n',
      ),
    ),
    /rewrite marker must precede every top-level regex location/,
  );
  const managed = injectManagedInclude(https);
  assert.throws(
    () => injectManagedInclude(
      `${INCLUDE_OUTSIDE_FIXTURE}\n${managed}`,
    ),
    /unmanaged content mirror include/,
  );
  assert.throws(
    () => injectManagedInclude(
      managed.replace(
        ' # AIFEEDS-CC-CONTENT-MIRROR-BEGIN',
        ' location ~ ".*\\.xml$" { return 418; }\n # AIFEEDS-CC-CONTENT-MIRROR-BEGIN',
      ),
    ),
    /managed include must precede every top-level regex location/,
  );
});

const INCLUDE_OUTSIDE_FIXTURE = (
  'include /www/server/panel/vhost/nginx/'
  + 'aifeeds-cc-content-mirror.inc;'
);

async function executable(file, contents) {
  await writeFile(file, contents, { mode: 0o755 });
  await chmod(file, 0o755);
}

function runBash(script, args, env = {}) {
  return spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function runBashAsync(script, args, env = {}) {
  return spawn('bash', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function waitForPath(file, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await stat(file);
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function localDeployHarness(
  secretFileContents,
  { autoDiscover = false, secretTarget = 'prod' } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-deploy-local-'));
  const home = path.join(root, 'home');
  const repo = path.join(root, 'repo');
  const deploySyncDir = autoDiscover
    ? path.join(repo, 'cc-site', 'sync')
    : SYNC_DIR;
  const secrets = autoDiscover
    ? path.join(repo, '.secrets')
    : path.join(root, '.secrets');
  const fakeBin = path.join(root, 'bin');
  const fakeRemoteBin = path.join(root, 'remote-bin');
  const log = path.join(root, 'commands.log');
  await mkdir(path.join(home, '.ssh'), { recursive: true });
  await mkdir(secrets, { recursive: true });
  await mkdir(fakeBin);
  await mkdir(fakeRemoteBin);
  if (autoDiscover) {
    await mkdir(path.join(deploySyncDir, 'test'), { recursive: true });
    for (const name of await readdir(SYNC_DIR)) {
      if ((await stat(path.join(SYNC_DIR, name))).isFile()) {
        await copyFile(
          path.join(SYNC_DIR, name),
          path.join(deploySyncDir, name),
        );
      }
    }
    for (const name of await readdir(path.join(SYNC_DIR, 'test'))) {
      if (name.endsWith('.test.mjs')) {
        await copyFile(
          path.join(SYNC_DIR, 'test', name),
          path.join(deploySyncDir, 'test', name),
        );
      }
    }
  }
  await writeFile(path.join(home, '.ssh', 'aifeeds_temp'), 'test-key', {
    mode: 0o600,
  });
  await writeFile(
    path.join(secrets, `aifeeds-${secretTarget}.env`),
    secretFileContents,
    { mode: 0o600 },
  );
  await executable(path.join(fakeBin, 'ssh'), `#!/usr/bin/env bash
set -euo pipefail
printf 'ssh' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
while (($#)); do
  case "$1" in
    -i|-o) shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) shift; break ;;
  esac
done
remote_command="$*"
case "$remote_command" in
  *'mktemp -d /tmp/aifeeds-cc-sync.XXXXXX'*)
    printf '/tmp/aifeeds-cc-sync.ABC123\n'
    ;;
  *'chmod 0600 '*)
    exit 0
    ;;
  *)
    PATH="$AIFEEDS_FAKE_REMOTE_BIN:$PATH" /bin/sh -c "$remote_command"
    ;;
esac
`);
  await executable(path.join(fakeRemoteBin, 'sudo'), `#!/usr/bin/env bash
set -euo pipefail
printf 'remote-sudo' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
[[ "$#" == 15 ]] || exit 64
[[ "$1" == env && "$2" == -i ]] || exit 64
[[ "$3" == PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin ]] || exit 64
[[ "$4" == bash && "$5" == -s && "$6" == -- ]] || exit 64
[[ "$7" =~ ^/tmp/aifeeds-cc-sync\\.[A-Za-z0-9]+$ ]] || exit 64
[[ "$8" == https://api.ai-feeds.com ]] || exit 64
for digest in "\${@:9}"; do
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || exit 64
done
bootstrap_script=$(cat)
printf 'remote-bootstrap-stdin\n%s\n' "$bootstrap_script" >> "$AIFEEDS_HARNESS_LOG"
printf '%s\n' "$bootstrap_script" | /bin/bash -n
[[ "$bootstrap_script" == *$'set -euo pipefail\numask 077\n'* ]] || exit 64
[[ "$bootstrap_script" == *'install-remote.fixed'* ]] || exit 64
[[ "$bootstrap_script" == *'"$staging" "$base_url" "$manifest_digest" </dev/null'* ]] || exit 64
exit "\${AIFEEDS_REMOTE_INSTALL_EXIT:-0}"
`);
  await executable(path.join(fakeBin, 'scp'), `#!/usr/bin/env bash
set -euo pipefail
printf 'scp' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
exit "\${AIFEEDS_SCP_EXIT:-0}"
`);
  return {
    env: {
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      AIFEEDS_FAKE_REMOTE_BIN: fakeRemoteBin,
      ...(autoDiscover ? {} : { AIFEEDS_SECRETS_DIR: secrets }),
      AIFEEDS_HARNESS_LOG: log,
    },
    deploy: path.join(deploySyncDir, 'deploy-to-cc.sh'),
    log,
    root,
  };
}

test('local deploy rejects unsafe targets and sync secret declarations', async () => {
  const deploy = path.join(SYNC_DIR, 'deploy-to-cc.sh');
  const validSecret = 'a'.repeat(64);
  const valid = await localDeployHarness(
    `CLOUDFLARE_API_TOKEN=ignored\nCC_SYNC_SECRET=${validSecret}\n`,
  );
  const badTarget = runBash(deploy, ['../../prod'], valid.env);
  assert.notEqual(badTarget.status, 0);
  assert.match(badTarget.stderr, /target must be prod/);

  const staging = runBash(deploy, ['staging'], valid.env);
  assert.notEqual(staging.status, 0);
  assert.match(staging.stderr, /target must be prod/);
  await assert.rejects(readFile(valid.log, 'utf8'), /ENOENT/);

  const duplicate = await localDeployHarness(
    `CC_SYNC_SECRET=${validSecret}\nCC_SYNC_SECRET=${validSecret}\n`,
  );
  const duplicateResult = runBash(deploy, ['prod'], duplicate.env);
  assert.notEqual(duplicateResult.status, 0);
  assert.match(duplicateResult.stderr, /duplicate CC_SYNC_SECRET/);

  const unknown = await localDeployHarness(
    `CC_SYNC_SECRET=${validSecret}\nCC_SYNC_UNEXPECTED=1\n`,
  );
  const unknownResult = runBash(deploy, ['prod'], unknown.env);
  assert.notEqual(unknownResult.status, 0);
  assert.match(unknownResult.stderr, /unknown CC_SYNC_ key/);

  const invalid = await localDeployHarness('CC_SYNC_SECRET=too-short\n');
  const invalidResult = runBash(deploy, ['prod'], invalid.env);
  assert.notEqual(invalidResult.status, 0);
  assert.match(invalidResult.stderr, /64 to 128 hexadecimal/);
});

test('local deploy stages through unique /tmp and never exposes the secret', async () => {
  const deploy = path.join(SYNC_DIR, 'deploy-to-cc.sh');
  const secret = 'b'.repeat(64);
  const harness = await localDeployHarness(
    `SOME_UNRELATED_KEY=value\nCC_SYNC_SECRET=${secret}\n`,
  );
  const result = runBash(deploy, ['prod'], harness.env);
  const commandLog = await readFile(harness.log, 'utf8');
  const combined = `${result.stdout}\n${result.stderr}\n${commandLog}`;

  assert.equal(result.status, 0, combined);
  assert.match(commandLog, /mktemp -d \/tmp\/aifeeds-cc-sync\.XXXXXX/);
  assert.match(commandLog, /\/tmp\/aifeeds-cc-sync\.ABC123/);
  assert.match(commandLog, /<sudo> <env> <-i>/);
  const bootstrapCommand = commandLog
    .split('\n')
    .find((line) => line.startsWith('ssh') && line.includes('<sudo>'));
  assert.ok(bootstrapCommand, commandLog);
  assert.match(bootstrapCommand, /<bash> <-s> <--> <\/tmp\/aifeeds-cc-sync\.ABC123>/);
  assert.doesNotMatch(bootstrapCommand, /<-c>/);
  assert.doesNotMatch(bootstrapCommand, /set -euo pipefail|install-remote\.fixed/);
  assert.match(commandLog, /remote-bootstrap-stdin\nset -euo pipefail\numask 077/);
  assert.match(commandLog, /mktemp -d \/var\/tmp\/aifeeds-cc-bootstrap\.XXXXXX/);
  assert.match(commandLog, /install-remote\.fixed/);
  assert.match(commandLog, /deployment-security\.fixed\.mjs/);
  assert.match(commandLog, /deployment-file-transaction\.fixed\.mjs/);
  assert.match(commandLog, /nginx-config-transaction\.fixed\.mjs/);
  assert.match(commandLog, /nginx-vhost-editor\.mjs/);
  assert.match(commandLog, /sha256sum --check/);
  assert.doesNotMatch(
    commandLog,
    /<bash> <\/tmp\/aifeeds-cc-sync\.[^>]+\/cc-site\/sync\/install-remote\.sh>/,
  );
  assert.equal(combined.includes(secret), false);

  const failed = await localDeployHarness(`CC_SYNC_SECRET=${secret}\n`);
  const failure = runBash(deploy, ['prod'], {
    ...failed.env,
    AIFEEDS_REMOTE_INSTALL_EXIT: '23',
  });
  assert.equal(failure.status, 23);
});

test('payload builder preserves the exact repository shape without server secrets', async () => {
  const { buildPayload } = await import('../build-payload.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-payload-'));
  const payload = path.join(root, 'payload');
  const envFile = path.join(root, 'cc-sync.env');
  await writeFile(envFile, `CC_SYNC_SECRET=${'d'.repeat(64)}\n`, { mode: 0o600 });

  const repoRoot = path.resolve(SYNC_DIR, '..', '..');
  const manifest = await buildPayload({ envFile, payload, repoRoot });
  const entries = (await readFile(manifest, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => line.slice(line.indexOf('  ') + 2));

  for (const required of [
    'cc-site/sync/sync.mjs',
    'cc-site/sync/install-remote.sh',
    'cc-site/sync/test/deployment.test.mjs',
    'cc-site/sync/test/fixtures/publish-and-pause.mjs',
    'cc-site/index.html',
    'cc-site/robots.txt',
    'cc-site/sitemap-static.xml',
    'cc-site/deploy.sh',
    'cc-site/cc-prompts/index.html',
    'cc-site/assets/gongan-icon.png',
    'cc-site/372c4ae2a3701bbe3b091dff54fb6d14.txt',
    'cc-site/sogousiteverification.txt',
    'cc-site/shenma-site-verification.txt',
    'cc-site/baidu_verify_codeva-OHhjgzJndf.html',
    'deploy/cc-sync.env',
  ]) {
    assert.ok(entries.includes(required), required);
    assert.equal((await stat(path.join(payload, required))).isFile(), true);
  }
  assert.deepEqual(entries, [...entries].sort());
  assert.equal(entries.some((entry) => entry.startsWith('cc-site/server/')), false);
  assert.equal(entries.some((entry) => /(^|\/)\.env(?:\.|$)/.test(entry)), false);
  assert.equal(entries.some((entry) => entry.includes('.secrets')), false);
});

test('payload verifier rejects tampering, extras, symlinks, and hardlinks', async (t) => {
  const { verifyPayload } = await import('../deployment-security.mjs');
  const makePayload = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-payload-verify-'));
    const payload = path.join(root, 'payload');
    const envFile = path.join(root, 'cc-sync.env');
    await writeFile(envFile, `CC_SYNC_SECRET=${'e'.repeat(64)}\n`, { mode: 0o600 });
    const manifest = await buildPayload({
      envFile,
      payload,
      repoRoot: path.resolve(SYNC_DIR, '..', '..'),
    });
    const expectedManifestDigest = createHash('sha256')
      .update(await readFile(manifest))
      .digest('hex');
    return { expectedManifestDigest, payload, root };
  };

  await t.test('tampered bytes', async () => {
    const fixture = await makePayload();
    await writeFile(path.join(fixture.payload, 'cc-site', 'index.html'), 'tampered');
    await assert.rejects(
      verifyPayload(fixture),
      /payload digest mismatch/,
    );
  });
  await t.test('extra file', async () => {
    const fixture = await makePayload();
    await writeFile(path.join(fixture.payload, 'extra.txt'), 'extra');
    await assert.rejects(verifyPayload(fixture), /unexpected payload entry/);
  });
  await t.test('symlink', async () => {
    const fixture = await makePayload();
    const target = path.join(fixture.payload, 'cc-site', 'index.html');
    await unlink(target);
    await symlink('/etc/passwd', target);
    await assert.rejects(verifyPayload(fixture), /regular file/);
  });
  await t.test('hardlink', async () => {
    const fixture = await makePayload();
    const target = path.join(fixture.payload, 'cc-site', 'index.html');
    const outside = path.join(fixture.root, 'outside.html');
    await copyFile(target, outside);
    await unlink(target);
    await link(outside, target);
    await assert.rejects(verifyPayload(fixture), /single-link regular file/);
  });
});

test('release garbage collection retains the live release and deletes only verified old trees', async () => {
  const { garbageCollectReleases } = await import('../deployment-security.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-release-gc-'));
  const releases = path.join(root, 'aifeeds-cc-sync-releases');
  const live = path.join(root, 'aifeeds-cc-sync');
  await mkdir(releases);
  const payload = path.join(root, 'payload');
  const envFile = path.join(root, 'cc-sync.env');
  await writeFile(envFile, `CC_SYNC_SECRET=${'e'.repeat(64)}\n`, { mode: 0o600 });
  await buildPayload({
    envFile,
    payload,
    repoRoot: path.resolve(SYNC_DIR, '..', '..'),
  });
  const baseManifest = await readFile(path.join(payload, 'MANIFEST.sha256'));
  const manifests = ['1', '2', '3', '4'].map((digit) => (
    manifestWithEnvironmentDigest(baseManifest, digit.repeat(64))
  ));
  const ids = manifests.map((manifest) => (
    createHash('sha256').update(manifest).digest('hex')
  ));
  for (const [index, id] of ids.entries()) {
    const release = path.join(releases, id);
    await mkdir(release);
    await cp(path.join(payload, 'cc-site'), path.join(release, 'cc-site'), {
      recursive: true,
    });
    await writeFile(path.join(release, 'MANIFEST.sha256'), manifests[index]);
    await normalizeReleaseFixture(release);
    const timestamp = new Date(1_700_000_000_000 + index * 1_000);
    await utimes(release, timestamp, timestamp);
  }
  await symlink(
    `aifeeds-cc-sync-releases/${ids[0]}/cc-site/sync`,
    live,
  );

  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'keep.txt'), 'outside\n');
  const unsafeId = 'e'.repeat(64);
  await symlink(outside, path.join(releases, unsafeId));

  const result = await garbageCollectReleases({
    allowedGid: process.getgid(),
    allowedUid: process.getuid(),
    keep: 3,
    liveLink: live,
    releases,
  });

  assert.deepEqual(result.removed, [ids[1]]);
  assert.deepEqual(
    (await readdir(releases)).sort(),
    [ids[0], ids[2], ids[3], unsafeId].sort(),
  );
  assert.equal(await readFile(path.join(outside, 'keep.txt'), 'utf8'), 'outside\n');
});

test('deployment file transaction atomically restores bytes and metadata', async () => {
  const {
    atomicInstall,
    captureFile,
    restoreFile,
  } = await import('../deployment-file-transaction.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-file-transaction-'));
  const backups = path.join(root, 'backups');
  const destination = path.join(root, 'cc-sync.env');
  const candidate = path.join(root, 'candidate.env');
  await mkdir(backups, { mode: 0o700 });
  await writeFile(destination, 'old\n', { mode: 0o640 });
  await writeFile(candidate, 'new\n', { mode: 0o600 });
  await captureFile({ backups, destination, name: 'env' });
  await atomicInstall({
    destination,
    gid: process.getgid(),
    mode: 0o600,
    source: candidate,
    uid: process.getuid(),
  });
  assert.equal(await readFile(destination, 'utf8'), 'new\n');
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  await restoreFile({ backups, destination, name: 'env' });
  assert.equal(await readFile(destination, 'utf8'), 'old\n');
  assert.equal((await stat(destination)).mode & 0o777, 0o640);

  const initiallyAbsent = path.join(root, 'new.timer');
  await captureFile({ backups, destination: initiallyAbsent, name: 'timer' });
  await atomicInstall({
    destination: initiallyAbsent,
    gid: process.getgid(),
    mode: 0o644,
    source: candidate,
    uid: process.getuid(),
  });
  await restoreFile({ backups, destination: initiallyAbsent, name: 'timer' });
  await assert.rejects(stat(initiallyAbsent), /ENOENT/);
});

test('deployment path transactions never overwrite a concurrent live object', async (t) => {
  const {
    captureFile,
    installFileTransaction,
    installSymlinkTransaction,
    recoverFileTransaction,
    recoverSymlinkTransaction,
    rollbackPathTransaction,
  } = await import('../deployment-file-transaction.mjs');
  const transaction = 'a'.repeat(64);
  const ids = {
    gid: process.getgid(),
    uid: process.getuid(),
  };

  await t.test('env receipt failure makes no live change', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-path-txn-env-'));
    const backups = path.join(root, 'backups');
    const destination = path.join(root, 'cc-sync.env');
    const source = path.join(root, 'candidate.env');
    await mkdir(backups, { mode: 0o700 });
    await writeFile(destination, 'old env\n', { mode: 0o600 });
    await writeFile(source, 'new env\n', { mode: 0o600 });
    await captureFile({ backups, destination, name: 'env' });
    const before = await stat(destination);
    await assert.rejects(
      installFileTransaction({
        ...ids,
        backups,
        destination,
        hooks: {
          beforeReceiptWrite() {
            throw new Error('injected receipt failure');
          },
        },
        mode: 0o600,
        name: 'env',
        source,
        transaction,
      }),
      /injected receipt failure/,
    );
    const after = await stat(destination);
    assert.equal(after.ino, before.ino);
    assert.equal(await readFile(destination, 'utf8'), 'old env\n');
  });

  await t.test('service commit interruption is forward-recovered by the same transaction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-path-txn-service-'));
    const backups = path.join(root, 'backups');
    const destination = path.join(root, 'aifeeds-cc-sync.service');
    const source = path.join(root, 'candidate.service');
    await mkdir(backups, { mode: 0o700 });
    await writeFile(destination, 'old service\n', { mode: 0o644 });
    await writeFile(source, 'new service\n', { mode: 0o644 });
    await captureFile({ backups, destination, name: 'service' });
    await assert.rejects(
      installFileTransaction({
        ...ids,
        backups,
        destination,
        hooks: {
          afterOldMove() {
            throw new Error('injected commit interruption');
          },
        },
        mode: 0o644,
        name: 'service',
        source,
        transaction,
      }),
      /injected commit interruption/,
    );
    await assert.rejects(stat(destination), /ENOENT/);
    await recoverFileTransaction({ destination, name: 'service', transaction });
    assert.equal(await readFile(destination, 'utf8'), 'new service\n');
  });

  await t.test('timer replacement after open is restored without overwrite', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-path-txn-timer-'));
    const backups = path.join(root, 'backups');
    const destination = path.join(root, 'aifeeds-cc-sync.timer');
    const heldOld = path.join(root, 'held-old.timer');
    const source = path.join(root, 'candidate.timer');
    await mkdir(backups, { mode: 0o700 });
    await writeFile(destination, 'old timer\n', { mode: 0o644 });
    await writeFile(source, 'new timer\n', { mode: 0o644 });
    await captureFile({ backups, destination, name: 'timer' });
    await assert.rejects(
      installFileTransaction({
        ...ids,
        backups,
        destination,
        hooks: {
          async afterLiveOpen() {
            await rename(destination, heldOld);
            await writeFile(destination, 'operator timer\n', { mode: 0o644 });
          },
        },
        mode: 0o644,
        name: 'timer',
        source,
        transaction,
      }),
      /transaction conflict/i,
    );
    assert.equal(await readFile(destination, 'utf8'), 'operator timer\n');
  });

  await t.test('OPT replacement after snapshot is restored without overwrite', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-path-txn-opt-'));
    const destination = path.join(root, 'aifeeds-cc-sync');
    const heldOld = path.join(root, 'held-old-link');
    await symlink('aifeeds-cc-sync-releases/old/cc-site/sync', destination);
    await assert.rejects(
      installSymlinkTransaction({
        destination,
        hooks: {
          async afterLiveOpen() {
            await rename(destination, heldOld);
            await symlink('operator-managed/cc-site/sync', destination);
          },
        },
        name: 'opt',
        target: 'aifeeds-cc-sync-releases/new/cc-site/sync',
        transaction,
      }),
      /transaction conflict/i,
    );
    assert.equal(
      await readlink(destination),
      'operator-managed/cc-site/sync',
    );
  });

  await t.test('OPT publish interruption keeps the receipt candidate inode recoverable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-path-txn-opt-publish-'));
    const destination = path.join(root, 'aifeeds-cc-sync');
    const target = 'aifeeds-cc-sync-releases/new/cc-site/sync';
    await symlink('aifeeds-cc-sync-releases/old/cc-site/sync', destination);
    await assert.rejects(
      installSymlinkTransaction({
        destination,
        hooks: {
          afterLivePublishBeforeReceipt() {
            throw new Error('injected post-publish interruption');
          },
        },
        name: 'opt',
        target,
        transaction,
      }),
      /injected post-publish interruption/,
    );
    const receipt = path.join(
      root,
      `.aifeeds-deploy.${transaction}.opt`,
      'receipt.jsonl',
    );
    const [headerLine] = (await readFile(receipt, 'utf8')).split('\n');
    const header = JSON.parse(headerLine);
    const liveIdentity = await lstat(destination);
    assert.equal(liveIdentity.dev, header.candidate.dev);
    assert.equal(liveIdentity.ino, header.candidate.ino);

    await recoverSymlinkTransaction({ destination, name: 'opt', transaction });
    await rollbackPathTransaction({ destination, name: 'opt', transaction });
    assert.equal(
      await readlink(destination),
      'aifeeds-cc-sync-releases/old/cc-site/sync',
    );
  });

  await t.test('same-target operator symlink is not mistaken for an interrupted candidate', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-path-txn-opt-operator-'));
    const destination = path.join(root, 'aifeeds-cc-sync');
    const target = 'aifeeds-cc-sync-releases/new/cc-site/sync';
    await symlink('aifeeds-cc-sync-releases/old/cc-site/sync', destination);
    await assert.rejects(
      installSymlinkTransaction({
        destination,
        hooks: {
          afterLivePublishBeforeReceipt() {
            throw new Error('injected post-publish interruption');
          },
        },
        name: 'opt',
        target,
        transaction,
      }),
      /injected post-publish interruption/,
    );
    const interruptedIdentity = await lstat(destination);
    await unlink(destination);
    await symlink(target, destination);
    const operatorIdentity = await lstat(destination);
    assert.notEqual(operatorIdentity.ino, interruptedIdentity.ino);

    await assert.rejects(
      recoverSymlinkTransaction({ destination, name: 'opt', transaction }),
      /operator-managed|transaction conflict/i,
    );
    await assert.rejects(
      rollbackPathTransaction({ destination, name: 'opt', transaction }),
      /rollback conflict/i,
    );
    const preserved = await lstat(destination);
    assert.equal(preserved.dev, operatorIdentity.dev);
    assert.equal(preserved.ino, operatorIdentity.ino);
    assert.equal(await readlink(destination), target);
  });
});

test('global journal publication recovers only its exact interrupted hard-link candidate', async (t) => {
  const { publishGlobalJournalMarker, recoverGlobalJournalCandidate } = await import(
    '../deployment-file-transaction.mjs'
  );
  const fixtureScript = path.join(
    SYNC_DIR,
    'test',
    'fixtures',
    'publish-and-pause.mjs',
  );
  const uid = process.getuid();
  const gid = process.getgid();

  async function killedPublication(
    phase,
    hookName = 'afterMarkerPublishBeforeCandidateUnlink',
  ) {
    const root = await mkdtemp(path.join(os.tmpdir(), `cc-global-${phase}-`));
    const journalDirectory = path.join(root, '.deployment-journal');
    const canonical = path.join(root, `.deployment-${phase}.json`);
    const ready = path.join(root, 'ready');
    await mkdir(journalDirectory, { mode: 0o700 });
    const child = spawn(process.execPath, [
      fixtureScript,
      'global-journal',
      phase,
      canonical,
      journalDirectory,
      String(uid),
      String(gid),
      ready,
      hookName,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let childError = '';
    child.stderr.on('data', (chunk) => {
      childError += chunk;
    });
    await Promise.race([
      waitForPath(ready),
      new Promise((_, reject) => {
        child.once('exit', (code, signal) => {
          reject(new Error(
            `journal fixture exited before pause: ${code ?? signal}: ${childError}`,
          ));
        });
      }),
    ]);
    child.kill('SIGKILL');
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    return { canonical, journalDirectory, phase };
  }

  for (const phase of ['preparing', 'committed']) {
    await t.test(`${phase} marker crash leaves one recoverable inode`, async () => {
      const fixture = await killedPublication(phase);
      const canonicalBefore = await lstat(fixture.canonical);
      assert.equal(canonicalBefore.isFile(), true);
      assert.equal(canonicalBefore.nlink, 2);
      const candidates = (await readdir(fixture.journalDirectory))
        .filter((name) => (
          name.startsWith('.marker-mutation.') && name.endsWith('.candidate')
        ));
      assert.equal(candidates.length, 1);
      const candidate = path.join(fixture.journalDirectory, candidates[0]);
      const candidateIdentity = await lstat(candidate);
      assert.equal(candidateIdentity.dev, canonicalBefore.dev);
      assert.equal(candidateIdentity.ino, canonicalBefore.ino);

      await recoverGlobalJournalCandidate({
        canonical: fixture.canonical,
        gid,
        journalDirectory: fixture.journalDirectory,
        phase,
        uid,
      });

      assert.equal((await lstat(fixture.canonical)).nlink, 1);
      await assert.rejects(lstat(candidate), /ENOENT/);
      assert.deepEqual(await readdir(fixture.journalDirectory), []);
    });
  }

  await t.test('create interruption boundaries converge exactly', async (createT) => {
    for (const phase of ['preparing', 'committed']) {
      for (const hookName of [
        'afterMutationRecordSync',
        'afterMarkerCandidateSync',
        'afterMarkerCanonicalPublishSync',
        'afterMarkerCandidateRemovalSync',
      ]) {
        await createT.test(`${phase} ${hookName}`, async () => {
          const fixture = await killedPublication(phase, hookName);
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const identity = await recoverGlobalJournalCandidate({
              canonical: fixture.canonical,
              gid,
              journalDirectory: fixture.journalDirectory,
              phase,
              uid,
            });
            assert.equal(identity.isFile(), true);
            assert.equal(identity.nlink, 1);
          }
          const marker = JSON.parse(await readFile(fixture.canonical, 'utf8'));
          assert.equal(marker.phase, phase);
          assert.deepEqual(await readdir(fixture.journalDirectory), []);
        });
      }
    }
  });

  await t.test('foreign canonical during create is preserved and remains fail-closed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-global-create-conflict-'));
    const journalDirectory = path.join(root, '.deployment-journal');
    const canonical = path.join(root, '.deployment-preparing.json');
    await mkdir(journalDirectory, { mode: 0o700 });
    await assert.rejects(publishGlobalJournalMarker({
      canonical,
      gid,
      hooks: {
        async beforeMarkerLink() {
          await writeFile(canonical, 'operator create marker\n', { mode: 0o600 });
        },
      },
      journalDirectory,
      marker: {
        manifest: 'a'.repeat(64),
        phase: 'preparing',
        release: `/opt/aifeeds-cc-sync-releases/${'a'.repeat(64)}`,
        schema: 2,
        transactions: [],
      },
      phase: 'preparing',
      uid,
    }), /conflict|canonical|marker/i);
    assert.equal(await readFile(canonical, 'utf8'), 'operator create marker\n');
    await assert.rejects(recoverGlobalJournalCandidate({
      canonical,
      gid,
      journalDirectory,
      phase: 'preparing',
      uid,
    }), /conflict|canonical|marker/i);
    assert.equal(await readFile(canonical, 'utf8'), 'operator create marker\n');
  });

  await t.test('same-inode operation record mutation fails closed', async () => {
    const fixture = await killedPublication('preparing', 'afterMutationRecordSync');
    const [recordName] = (await readdir(fixture.journalDirectory))
      .filter((name) => name.endsWith('.json'));
    assert.ok(recordName);
    const record = path.join(fixture.journalDirectory, recordName);
    const before = await lstat(record);
    await writeFile(record, '{}\n');
    const after = await lstat(record);
    assert.equal(after.ino, before.ino);
    await assert.rejects(recoverGlobalJournalCandidate({
      canonical: fixture.canonical,
      gid,
      journalDirectory: fixture.journalDirectory,
      phase: 'preparing',
      uid,
    }), /operation record|invalid|marker mutation/i);
    assert.equal((await lstat(record)).ino, before.ino);
  });

  async function adversarialFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-global-adversarial-'));
    const journalDirectory = path.join(root, '.deployment-journal');
    const canonical = path.join(root, '.deployment-preparing.json');
    await mkdir(journalDirectory, { mode: 0o700 });
    await writeFile(canonical, '{"phase":"preparing"}\n', { mode: 0o600 });
    return { canonical, journalDirectory };
  }

  await t.test('multiple controlled candidates fail closed', async () => {
    const fixture = await adversarialFixture();
    for (const uuid of [
      '123e4567-e89b-42d3-a456-426614174000',
      '123e4567-e89b-42d3-a456-426614174001',
    ]) {
      await link(
        fixture.canonical,
        path.join(fixture.journalDirectory, `.preparing.${uuid}.candidate`),
      );
    }
    await assert.rejects(recoverGlobalJournalCandidate({
      ...fixture,
      gid,
      phase: 'preparing',
      uid,
    }), /candidate|link/i);
    assert.equal((await lstat(fixture.canonical)).nlink, 3);
  });

  await t.test('orphan durable mutation artifact fails closed', async () => {
    const fixture = await adversarialFixture();
    const candidate = path.join(
      fixture.journalDirectory,
      '.marker-mutation.123e4567-e89b-42d3-a456-426614174000.candidate',
    );
    await writeFile(candidate, '{"phase":"preparing"}\n', { mode: 0o600 });
    await assert.rejects(recoverGlobalJournalCandidate({
      ...fixture,
      gid,
      phase: 'preparing',
      uid,
    }), /orphan|operation record|mutation artifact/i);
    assert.equal((await lstat(candidate)).isFile(), true);
  });

  await t.test('different-inode controlled candidate fails closed', async () => {
    const fixture = await adversarialFixture();
    const candidate = path.join(
      fixture.journalDirectory,
      '.preparing.123e4567-e89b-42d3-a456-426614174000.candidate',
    );
    await writeFile(candidate, '{"phase":"preparing"}\n', { mode: 0o600 });
    await assert.rejects(recoverGlobalJournalCandidate({
      ...fixture,
      gid,
      phase: 'preparing',
      uid,
    }), /candidate|inode|link/i);
    assert.equal((await lstat(candidate)).isFile(), true);
  });

  await t.test('arbitrary hard link fails closed', async () => {
    const fixture = await adversarialFixture();
    await link(fixture.canonical, path.join(fixture.journalDirectory, 'operator-link'));
    await assert.rejects(recoverGlobalJournalCandidate({
      ...fixture,
      gid,
      phase: 'preparing',
      uid,
    }), /candidate|unexpected|link/i);
    assert.equal((await lstat(fixture.canonical)).nlink, 2);
  });

  await t.test('symbolic candidate fails closed', async () => {
    const fixture = await adversarialFixture();
    const candidate = path.join(
      fixture.journalDirectory,
      '.preparing.123e4567-e89b-42d3-a456-426614174000.candidate',
    );
    await symlink(fixture.canonical, candidate);
    await assert.rejects(recoverGlobalJournalCandidate({
      ...fixture,
      gid,
      phase: 'preparing',
      uid,
    }), /candidate|regular|symbolic/i);
    assert.equal((await lstat(candidate)).isSymbolicLink(), true);
  });
});

test('preparing marker update SIGKILL windows always recover exactly', async (t) => {
  const { recoverGlobalDeployment, recoverGlobalJournalCandidate } = await import(
    '../deployment-file-transaction.mjs'
  );
  const fixtureScript = path.join(
    SYNC_DIR,
    'test',
    'fixtures',
    'publish-and-pause.mjs',
  );

  for (const hookName of [
    'afterMutationRecordSync',
    'afterMarkerCandidateSync',
    'afterMarkerQuarantineSync',
    'afterMarkerCanonicalPublishSync',
    'afterMarkerQuarantineRemovalSync',
    'afterMarkerCandidateRemovalSync',
  ]) {
    await t.test(hookName, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cc-marker-kill-'));
      const ready = path.join(root, 'ready');
      const child = spawn(process.execPath, [
        fixtureScript,
        'preparing-marker-update',
        root,
        hookName,
        ready,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let childError = '';
      child.stderr.on('data', (chunk) => {
        childError += chunk;
      });
      await Promise.race([
        waitForPath(ready),
        new Promise((_, reject) => {
          child.once('exit', (code, signal) => {
            reject(new Error(
              `marker fixture exited before ${hookName}: ${code ?? signal}: ${childError}`,
            ));
          });
        }),
      ]);
      child.kill('SIGKILL');
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });

      const releases = path.join(root, 'aifeeds-cc-sync-releases');
      const preparingJournal = path.join(releases, '.deployment-preparing.json');
      const committedJournal = path.join(releases, '.deployment-committed.json');
      const journalDirectory = path.join(releases, '.deployment-journal');
      const destinations = [
        path.join(root, 'aifeeds-cc-sync'),
        path.join(root, 'systemd', 'aifeeds-cc-sync.service'),
        path.join(root, 'systemd', 'aifeeds-cc-sync.timer'),
        path.join(root, 'aifeeds', 'cc-sync.env'),
      ];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const recovered = await recoverGlobalJournalCandidate({
          canonical: preparingJournal,
          gid: process.getgid(),
          journalDirectory,
          phase: 'preparing',
          uid: process.getuid(),
        });
        assert.equal(recovered.isFile(), true);
        assert.equal(recovered.nlink, 1);
        assert.equal((await stat(preparingJournal)).isFile(), true);
      }
      const marker = JSON.parse(await readFile(preparingJournal, 'utf8'));
      assert.equal(marker.recovery.candidate_timer_stop, 'attempted');
      assert.deepEqual(
        (await readdir(journalDirectory)).filter((name) => (
          name.startsWith('.marker-') || name.startsWith('.mutation-')
        )),
        [],
      );
      await assert.rejects(recoverGlobalDeployment({
        committedJournal,
        destinations,
        gid: process.getgid(),
        journalDirectory,
        preparingJournal,
        releases,
        uid: process.getuid(),
      }), /ambiguous preparing recovery step: candidate_timer_stop/);
    });
  }
});

test('cleanup receipt initial create SIGKILL windows recover exact durable evidence', async (t) => {
  const {
    completePreparingDeployment,
    recoverGlobalDeployment,
    recoverGlobalJournalCandidate,
  } = await import('../deployment-file-transaction.mjs');
  const fixtureScript = path.join(
    SYNC_DIR,
    'test',
    'fixtures',
    'publish-and-pause.mjs',
  );

  for (const hookName of [
    'afterMutationRecordSync',
    'afterMarkerCandidateSync',
    'afterMarkerCanonicalPublishSync',
    'afterMarkerCandidateRemovalSync',
  ]) {
    await t.test(hookName, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cc-cleanup-create-kill-'));
      const ready = path.join(root, 'ready');
      const child = spawn(process.execPath, [
        fixtureScript,
        'cleanup-receipt-create',
        root,
        hookName,
        ready,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      let childError = '';
      child.stderr.on('data', (chunk) => {
        childError += chunk;
      });
      await Promise.race([
        waitForPath(ready),
        new Promise((_, reject) => {
          child.once('exit', (code, signal) => {
            reject(new Error(
              `cleanup create fixture exited before ${hookName}: `
              + `${code ?? signal}: ${childError}`,
            ));
          });
        }),
      ]);
      child.kill('SIGKILL');
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });

      const releases = path.join(root, 'aifeeds-cc-sync-releases');
      const preparingJournal = path.join(releases, '.deployment-preparing.json');
      const committedJournal = path.join(releases, '.deployment-committed.json');
      const journalDirectory = path.join(releases, '.deployment-journal');
      const destinations = [
        path.join(root, 'aifeeds-cc-sync'),
        path.join(root, 'systemd', 'aifeeds-cc-sync.service'),
        path.join(root, 'systemd', 'aifeeds-cc-sync.timer'),
        path.join(root, 'aifeeds', 'cc-sync.env'),
      ];
      const options = {
        committedJournal,
        destinations,
        gid: process.getgid(),
        journalDirectory,
        preparingJournal,
        releases,
        uid: process.getuid(),
      };
      const marker = JSON.parse(await readFile(preparingJournal, 'utf8'));
      const receipt = marker.snapshot.cleanup.receipt;
      const expectedReceipt = {
        canonical: marker.snapshot.path,
        deployment_id: marker.snapshot.cleanup.deployment_id,
        identity: {
          dev: marker.snapshot.dev,
          gid: marker.snapshot.gid,
          ino: marker.snapshot.ino,
          mode: marker.snapshot.mode,
          uid: marker.snapshot.uid,
        },
        quarantine: marker.snapshot.cleanup.quarantine,
        phase: 'planned',
        schema: 2,
      };
      let canonicalBytes = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const recovered = await recoverGlobalJournalCandidate({
          canonical: preparingJournal,
          gid: options.gid,
          journalDirectory,
          phase: 'preparing',
          uid: options.uid,
        });
        assert.equal(recovered.isFile(), true);
        const identity = await lstat(receipt);
        assert.equal(identity.isFile(), true);
        assert.equal(identity.nlink, 1);
        assert.equal(identity.mode & 0o7777, 0o600);
        const bytes = await readFile(receipt);
        assert.deepEqual(JSON.parse(bytes), expectedReceipt);
        if (canonicalBytes === null) {
          canonicalBytes = bytes;
        } else {
          assert.deepEqual(bytes, canonicalBytes);
        }
        assert.deepEqual(
          (await readdir(journalDirectory)).filter((name) => (
            name.startsWith('.marker-') || name.startsWith('.mutation-')
          )),
          [],
        );
      }
      assert.equal(await completePreparingDeployment(options), 'cleared');
      assert.deepEqual(await recoverGlobalDeployment(options), { phase: 'none' });
      await assert.rejects(lstat(marker.snapshot.path), /ENOENT/);
      assert.deepEqual(await readdir(journalDirectory), []);
    });
  }
});

test('preparing delete and cleanup receipt mutations survive real SIGKILL', async (t) => {
  const {
    recoverGlobalDeployment,
    recoverGlobalMarkerMutations,
  } = await import('../deployment-file-transaction.mjs');
  const fixtureScript = path.join(
    SYNC_DIR,
    'test',
    'fixtures',
    'publish-and-pause.mjs',
  );
  const cases = [
    {
      hooks: [
        'afterMutationRecordSync',
        'afterMarkerQuarantineSync',
        'afterMarkerQuarantineRemovalSync',
      ],
      mutation: 'preparing-delete',
    },
    {
      hooks: [
        'afterMutationRecordSync',
        'afterMarkerCandidateSync',
        'afterMarkerQuarantineSync',
        'afterMarkerCanonicalPublishSync',
        'afterMarkerQuarantineRemovalSync',
        'afterMarkerCandidateRemovalSync',
      ],
      mutation: 'cleanup-replace',
    },
    {
      hooks: [
        'afterMutationRecordSync',
        'afterMarkerQuarantineSync',
        'afterMarkerQuarantineRemovalSync',
      ],
      mutation: 'cleanup-delete',
    },
  ];

  for (const currentCase of cases) {
    await t.test(currentCase.mutation, async (mutationT) => {
      for (const hookName of currentCase.hooks) {
        await mutationT.test(hookName, async () => {
          const root = await mkdtemp(path.join(os.tmpdir(), 'cc-cleanup-kill-'));
          const ready = path.join(root, 'ready');
          const child = spawn(process.execPath, [
            fixtureScript,
            'cleanup-mutation',
            root,
            currentCase.mutation,
            hookName,
            ready,
          ], { stdio: ['ignore', 'ignore', 'pipe'] });
          let childError = '';
          child.stderr.on('data', (chunk) => {
            childError += chunk;
          });
          await Promise.race([
            waitForPath(ready),
            new Promise((_, reject) => {
              child.once('exit', (code, signal) => {
                reject(new Error(
                  `cleanup mutation fixture exited before ${hookName}: `
                  + `${code ?? signal}: ${childError}`,
                ));
              });
            }),
          ]);
          child.kill('SIGKILL');
          await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', resolve);
          });

          const releases = path.join(root, 'aifeeds-cc-sync-releases');
          const journalDirectory = path.join(releases, '.deployment-journal');
          const options = {
            committedJournal: path.join(releases, '.deployment-committed.json'),
            destinations: [
              path.join(root, 'aifeeds-cc-sync'),
              path.join(root, 'systemd', 'aifeeds-cc-sync.service'),
              path.join(root, 'systemd', 'aifeeds-cc-sync.timer'),
              path.join(root, 'aifeeds', 'cc-sync.env'),
            ],
            gid: process.getgid(),
            journalDirectory,
            preparingJournal: path.join(releases, '.deployment-preparing.json'),
            releases,
            uid: process.getuid(),
          };
          for (let attempt = 0; attempt < 2; attempt += 1) {
            await recoverGlobalMarkerMutations({
              gid: options.gid,
              journalDirectory,
              uid: options.uid,
            });
            assert.deepEqual(
              (await readdir(journalDirectory)).filter((name) => (
                name.startsWith('.marker-') || name.startsWith('.mutation-')
              )),
              [],
            );
          }
          assert.deepEqual(await recoverGlobalDeployment(options), { phase: 'none' });
          assert.deepEqual(await recoverGlobalDeployment(options), { phase: 'none' });
          assert.deepEqual(await readdir(journalDirectory), []);
          assert.deepEqual(
            (await readdir(path.join(
              root,
              'var',
              'lib',
              'aifeeds-cc-deploy-snapshots',
            ))).filter((name) => name.includes('.cleanup.')),
            [],
          );
        });
      }
    });
  }
});

test('preparing journal owns every path transaction before live mutation', async (t) => {
  const {
    armPreparingTransaction,
    captureFile,
    clearCommittedDeployment,
    commitGlobalDeployment,
    completePreparingDeployment,
    finalizePathTransaction,
    installFileTransaction,
    installSymlinkTransaction,
    prepareGlobalDeployment,
    recordPreparingRecoveryStep,
    recoverGlobalDeployment,
  } = await import('../deployment-file-transaction.mjs');
  const uid = process.getuid();
  const gid = process.getgid();

  async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-global-preparing-'));
    const releases = path.join(root, 'aifeeds-cc-sync-releases');
    const journalDirectory = path.join(releases, '.deployment-journal');
    const preparingJournal = path.join(releases, '.deployment-preparing.json');
    const committedJournal = path.join(releases, '.deployment-committed.json');
    const manifest = 'a'.repeat(64);
    const release = path.join(releases, manifest);
    const snapshot = path.join(
      root,
      'var',
      'lib',
      'aifeeds-cc-deploy-snapshots',
      'aifeeds-cc-root-snapshot.ABC123',
    );
    const destinations = [
      path.join(root, 'aifeeds-cc-sync'),
      path.join(root, 'systemd', 'aifeeds-cc-sync.service'),
      path.join(root, 'systemd', 'aifeeds-cc-sync.timer'),
      path.join(root, 'aifeeds', 'cc-sync.env'),
    ];
    await mkdir(release, { recursive: true, mode: 0o755 });
    await chmod(releases, 0o755);
    await chmod(release, 0o755);
    await mkdir(path.dirname(destinations[1]), { recursive: true });
    await mkdir(path.dirname(destinations[3]), { recursive: true });
    await mkdir(snapshot, { recursive: true, mode: 0o755 });
    await chmod(path.dirname(snapshot), 0o700);
    await chmod(snapshot, 0o755);
    await writeFile(destinations[1], 'OLD_SERVICE\n', { mode: 0o644 });
    return {
      committedJournal,
      destinations,
      gid,
      journalDirectory,
      manifest,
      preparingJournal,
      release,
      releases,
      root,
      snapshot,
      uid,
    };
  }

  async function armedCommitFixture() {
    const current = await fixture();
    const secretFile = path.join(current.snapshot, 'deploy', 'cc-sync.env');
    await mkdir(path.dirname(secretFile), { recursive: true });
    await writeFile(
      secretFile,
      `CC_SYNC_SECRET=${'d'.repeat(64)}\n`,
      { mode: 0o600 },
    );
    await prepareGlobalDeployment({
      ...current,
      nginxTransaction: path.join(current.snapshot, '.rollback', 'nginx'),
      runtime: {
        service_active: 'inactive',
        timer_active: 'inactive',
        timer_enabled: 'disabled',
      },
    });
    const arm = (name) => armPreparingTransaction({
      gid,
      journalDirectory: current.journalDirectory,
      name,
      preparingJournal: current.preparingJournal,
      uid,
    });
    await installSymlinkTransaction({
      destination: current.destinations[0],
      hooks: { afterReceiptPrepared: () => arm('opt') },
      name: 'opt',
      target: `${current.manifest}/cc-site/sync`,
      transaction: current.manifest,
    });
    const backups = path.join(current.snapshot, '.rollback');
    for (const [index, name] of ['service', 'timer', 'env'].entries()) {
      const destination = current.destinations[index + 1];
      const source = path.join(current.root, `new-${name}`);
      await writeFile(source, `NEW_${name.toUpperCase()}\n`, { mode: 0o600 });
      await captureFile({ backups, destination, name });
      await installFileTransaction({
        backups,
        destination,
        gid,
        hooks: { afterReceiptPrepared: () => arm(name) },
        mode: name === 'env' ? 0o600 : 0o644,
        name,
        source,
        transaction: current.manifest,
        uid,
      });
    }
    return current;
  }

  async function committedAndPreparingFixture() {
    const current = await armedCommitFixture();
    await assert.rejects(commitGlobalDeployment({
      ...current,
      hooks: {
        async afterCommittedPublishBeforePreparingCleanup() {
          throw new Error('simulated cross-process commit interruption');
        },
      },
    }), /simulated cross-process commit interruption/);
    assert.equal((await lstat(current.committedJournal)).isFile(), true);
    assert.equal((await lstat(current.preparingJournal)).isFile(), true);
    return current;
  }

  async function committedFixture() {
    const current = await armedCommitFixture();
    await commitGlobalDeployment(current);
    await assert.rejects(lstat(current.preparingJournal), /ENOENT/);
    await assert.rejects(lstat(current.snapshot), /ENOENT/);
    assert.equal((await lstat(current.committedJournal)).isFile(), true);
    return current;
  }

  async function orphanCleanupFixture() {
    const current = await fixture();
    const secretFile = path.join(current.snapshot, 'deploy', 'cc-sync.env');
    await mkdir(path.dirname(secretFile), { recursive: true });
    await writeFile(secretFile, `CC_SYNC_SECRET=${'e'.repeat(64)}\n`, {
      mode: 0o600,
    });
    await prepareGlobalDeployment({
      ...current,
      nginxTransaction: path.join(current.snapshot, '.rollback', 'nginx'),
      runtime: {
        service_active: 'inactive',
        timer_active: 'inactive',
        timer_enabled: 'disabled',
      },
    });
    await assert.rejects(completePreparingDeployment({
      ...current,
      hooks: {
        async afterMarkerRemovalBeforeSnapshotDelete() {
          throw new Error('simulated orphan cleanup interruption');
        },
      },
    }), /simulated orphan cleanup interruption/);
    const [receiptName] = (await readdir(current.journalDirectory))
      .filter((name) => name.startsWith('.snapshot-cleanup.'));
    assert.ok(receiptName);
    const receipt = path.join(current.journalDirectory, receiptName);
    const record = JSON.parse(await readFile(receipt, 'utf8'));
    return {
      ...current,
      quarantine: record.quarantine,
      receipt,
    };
  }

  async function cleanupReceiptFixture() {
    const current = await fixture();
    const secretFile = path.join(current.snapshot, 'deploy', 'cc-sync.env');
    await mkdir(path.dirname(secretFile), { recursive: true });
    await writeFile(secretFile, `CC_SYNC_SECRET=${'f'.repeat(64)}\n`, {
      mode: 0o600,
    });
    await prepareGlobalDeployment({
      ...current,
      nginxTransaction: path.join(current.snapshot, '.rollback', 'nginx'),
      runtime: {
        service_active: 'inactive',
        timer_active: 'inactive',
        timer_enabled: 'disabled',
      },
    });
    return current;
  }

  await t.test('marker is durable before transaction directories exist', async () => {
    const current = await fixture();
    const marker = await prepareGlobalDeployment({
      ...current,
      nginxTransaction: path.join(current.snapshot, '.rollback', 'nginx'),
      runtime: {
        service_active: 'active',
        timer_active: 'active',
        timer_enabled: 'enabled',
      },
    });
    assert.equal(marker.phase, 'preparing');
    assert.equal(marker.snapshot.path, current.snapshot);
    assert.equal(marker.snapshot.parent, path.dirname(current.snapshot));
    assert.equal(marker.snapshot.mode, 0o755);
    assert.equal(Number.isSafeInteger(marker.snapshot.dev), true);
    assert.equal(Number.isSafeInteger(marker.snapshot.ino), true);
    assert.equal((await lstat(current.preparingJournal)).nlink, 1);
    assert.equal((await lstat(current.preparingJournal)).mode & 0o777, 0o600);
    assert.equal((await lstat(current.journalDirectory)).mode & 0o777, 0o700);
    assert.deepEqual(
      marker.transactions.map(({ name, state }) => [name, state]),
      [
        ['opt', 'planned'],
        ['service', 'planned'],
        ['timer', 'planned'],
        ['env', 'planned'],
      ],
    );
    assert.equal(marker.transactions[1].expected.type, 'file');
    for (const transaction of marker.transactions) {
      await assert.rejects(lstat(transaction.transaction), /ENOENT/);
    }
  });

  await t.test('receipt is armed and fsynced while the old live file still exists', async () => {
    const current = await fixture();
    await prepareGlobalDeployment({
      ...current,
      nginxTransaction: path.join(current.snapshot, '.rollback', 'nginx'),
      runtime: {
        service_active: 'inactive',
        timer_active: 'inactive',
        timer_enabled: 'disabled',
      },
    });
    const backups = path.join(current.root, 'backups');
    const source = path.join(current.root, 'new.service');
    await writeFile(source, 'NEW_SERVICE\n', { mode: 0o644 });
    await captureFile({
      backups,
      destination: current.destinations[1],
      name: 'service',
    });
    let armedBeforeMutation = false;
    await installFileTransaction({
      backups,
      destination: current.destinations[1],
      gid,
      hooks: {
        async afterReceiptPrepared() {
          assert.equal(
            await readFile(current.destinations[1], 'utf8'),
            'OLD_SERVICE\n',
          );
          await armPreparingTransaction({
            gid,
            journalDirectory: current.journalDirectory,
            name: 'service',
            preparingJournal: current.preparingJournal,
            uid,
          });
          armedBeforeMutation = true;
        },
      },
      mode: 0o644,
      name: 'service',
      source,
      transaction: current.manifest,
      uid,
    });
    assert.equal(armedBeforeMutation, true);
    const marker = JSON.parse(await readFile(current.preparingJournal, 'utf8'));
    assert.equal(marker.transactions[1].state, 'armed');
    assert.match(marker.transactions[1].receipt_header_digest, /^[0-9a-f]{64}$/);
    assert.equal(Number.isSafeInteger(
      marker.transactions[1].receipt_identity.ino,
    ), true);
    assert.equal(
      await readFile(current.destinations[1], 'utf8'),
      'NEW_SERVICE\n',
    );
  });

  await t.test('a receipt without a matching journal is never forward-finalized', async () => {
    const current = await fixture();
    const backups = path.join(current.root, 'backups');
    const source = path.join(current.root, 'new.service');
    await writeFile(source, 'NEW_SERVICE\n', { mode: 0o644 });
    await captureFile({
      backups,
      destination: current.destinations[1],
      name: 'service',
    });
    await installFileTransaction({
      backups,
      destination: current.destinations[1],
      gid,
      mode: 0o644,
      name: 'service',
      source,
      transaction: current.manifest,
      uid,
    });
    const transaction = path.join(
      path.dirname(current.destinations[1]),
      `.aifeeds-deploy.${current.manifest}.service`,
    );
    await assert.rejects(recoverGlobalDeployment({
      committedJournal: current.committedJournal,
      destinations: current.destinations,
      gid,
      journalDirectory: current.journalDirectory,
      preparingJournal: current.preparingJournal,
      releases: current.releases,
      uid,
    }), /orphan|journal/i);
    assert.equal(await readFile(current.destinations[1], 'utf8'), 'NEW_SERVICE\n');
    assert.equal((await lstat(path.join(transaction, 'receipt.jsonl'))).isFile(), true);
  });

  await t.test('marker replacement is full-content CAS across rename, link, and unlink', async (replaceT) => {
    const cases = [
      {
        name: 'foreign canonical before rename',
        async hook(current) {
          await unlink(current.preparingJournal);
          await writeFile(current.preparingJournal, 'operator marker\n', { mode: 0o600 });
        },
        hookName: 'beforeMarkerRename',
        expected: 'operator marker\n',
      },
      {
        name: 'same inode content mutation before rename',
        async hook(current) {
          await writeFile(current.preparingJournal, 'same inode operator mutation\n');
        },
        hookName: 'beforeMarkerRename',
        expected: 'same inode operator mutation\n',
      },
      {
        name: 'ABA relink before rename',
        async hook(current) {
          const parked = `${current.preparingJournal}.parked`;
          const bytes = await readFile(current.preparingJournal);
          await link(current.preparingJournal, parked);
          await unlink(current.preparingJournal);
          await writeFile(current.preparingJournal, bytes, { mode: 0o600 });
          await unlink(current.preparingJournal);
          await link(parked, current.preparingJournal);
          await unlink(parked);
        },
        hookName: 'beforeMarkerRename',
        expected: null,
      },
      {
        name: 'foreign canonical before candidate link',
        async hook(current) {
          await writeFile(current.preparingJournal, 'operator before link\n', { mode: 0o600 });
        },
        hookName: 'beforeMarkerLink',
        expected: 'operator before link\n',
      },
      {
        name: 'foreign canonical before quarantine unlink',
        async hook(current) {
          await unlink(current.preparingJournal);
          await writeFile(current.preparingJournal, 'operator before unlink\n', { mode: 0o600 });
        },
        hookName: 'beforeMarkerUnlink',
        expected: 'operator before unlink\n',
      },
    ];

    for (const scenario of cases) {
      await replaceT.test(scenario.name, async () => {
        const current = await fixture();
        await prepareGlobalDeployment({
          ...current,
          nginxTransaction: path.join(current.snapshot, '.rollback', 'nginx'),
          runtime: {
            service_active: 'inactive',
            timer_active: 'inactive',
            timer_enabled: 'disabled',
          },
        });
        const before = await lstat(current.preparingJournal);
        let hookCalled = false;
        await assert.rejects(recordPreparingRecoveryStep({
          ...current,
          hooks: {
            async [scenario.hookName]() {
              hookCalled = true;
              await scenario.hook(current);
            },
          },
          state: 'attempted',
          step: 'candidate_timer_stop',
        }), /changed|conflict|operator|marker|canonical|CAS/i);
        assert.equal(hookCalled, true);
        if (scenario.expected !== null) {
          assert.equal(await readFile(current.preparingJournal, 'utf8'), scenario.expected);
        } else {
          const after = await lstat(current.preparingJournal);
          assert.equal(after.dev, before.dev);
          assert.equal(after.ino, before.ino);
        }
        await assert.rejects(
          recoverGlobalDeployment(current),
          /changed|conflict|identity|marker|canonical|CAS/i,
        );
        if (scenario.expected !== null) {
          assert.equal(await readFile(current.preparingJournal, 'utf8'), scenario.expected);
        }
      });
    }
  });

  await t.test('marker deletion is CAS and preserves concurrent canonical files', async (deleteT) => {
    for (const scenario of [
      {
        name: 'replacement before quarantine rename',
        hookName: 'beforeMarkerRename',
        expected: 'operator delete replacement\n',
        async hook(current) {
          await unlink(current.preparingJournal);
          await writeFile(
            current.preparingJournal,
            'operator delete replacement\n',
            { mode: 0o600 },
          );
        },
      },
      {
        name: 'replacement before quarantine unlink',
        hookName: 'beforeMarkerUnlink',
        expected: 'operator delete unlink replacement\n',
        async hook(current) {
          await writeFile(
            current.preparingJournal,
            'operator delete unlink replacement\n',
            { mode: 0o600 },
          );
        },
      },
    ]) {
      await deleteT.test(scenario.name, async () => {
        const current = await fixture();
        await prepareGlobalDeployment({
          ...current,
          nginxTransaction: path.join(current.snapshot, '.rollback', 'nginx'),
          runtime: {
            service_active: 'inactive',
            timer_active: 'inactive',
            timer_enabled: 'disabled',
          },
        });
        let hookCalled = false;
        await assert.rejects(completePreparingDeployment({
          ...current,
          hooks: {
            async [scenario.hookName]() {
              hookCalled = true;
              await scenario.hook(current);
            },
          },
        }), /changed|conflict|operator|marker|canonical|CAS/i);
        assert.equal(hookCalled, true);
        assert.equal(await readFile(current.preparingJournal, 'utf8'), scenario.expected);
        await assert.rejects(
          recoverGlobalDeployment(current),
          /changed|conflict|identity|marker|canonical|CAS/i,
        );
        assert.equal(await readFile(current.preparingJournal, 'utf8'), scenario.expected);
        const retained = (await readdir(path.dirname(current.snapshot)))
          .filter((name) => name.startsWith(
            `${path.basename(current.snapshot)}.cleanup.`,
          ));
        assert.equal(retained.length, 1);
        assert.equal(
          (await lstat(path.join(path.dirname(current.snapshot), retained[0]))).isDirectory(),
          true,
        );
      });
    }
  });

  await t.test('committed marker deletion interruption boundaries converge exactly', async (deleteT) => {
    for (const hookName of [
      'afterMutationRecordSync',
      'afterMarkerQuarantineSync',
      'afterMarkerQuarantineRemovalSync',
    ]) {
      await deleteT.test(hookName, async () => {
        const current = await committedFixture();
        for (const [index, name] of ['opt', 'service', 'timer', 'env'].entries()) {
          await finalizePathTransaction({
            destination: current.destinations[index],
            name,
            transaction: current.manifest,
          });
        }
        await assert.rejects(clearCommittedDeployment({
          ...current,
          hooks: {
            async [hookName]() {
              throw new Error(`injected committed delete ${hookName}`);
            },
          },
        }), new RegExp(`injected committed delete ${hookName}`));
        assert.deepEqual(await recoverGlobalDeployment(current), { phase: 'none' });
        assert.deepEqual(await recoverGlobalDeployment(current), { phase: 'none' });
        assert.deepEqual(
          (await readdir(current.journalDirectory)).filter((name) => (
            name.startsWith('.marker-') || name.startsWith('.mutation-')
          )),
          [],
        );
      });
    }
  });

  await t.test('cleanup receipt replacement interruption boundaries converge exactly', async (receiptT) => {
    for (const hookName of [
      'afterMutationRecordSync',
      'afterMarkerCandidateSync',
      'afterMarkerQuarantineSync',
      'afterMarkerCanonicalPublishSync',
      'afterMarkerQuarantineRemovalSync',
      'afterMarkerCandidateRemovalSync',
    ]) {
      await receiptT.test(hookName, async () => {
        const current = await cleanupReceiptFixture();
        let interrupted = false;
        await assert.rejects(completePreparingDeployment({
          ...current,
          hooks: {
            async [hookName]({ action, location }) {
              if (action !== 'replace' || location !== 'snapshot-cleanup') return;
              interrupted = true;
              throw new Error(`injected cleanup receipt replace ${hookName}`);
            },
          },
        }), new RegExp(`injected cleanup receipt replace ${hookName}`));
        assert.equal(interrupted, true);
        assert.deepEqual(await recoverGlobalDeployment(current), { phase: 'none' });
        assert.deepEqual(await recoverGlobalDeployment(current), { phase: 'none' });
        await assert.rejects(lstat(current.snapshot), /ENOENT/);
        assert.deepEqual(await readdir(current.journalDirectory), []);
      });
    }
  });

  await t.test('cleanup receipt deletion interruption boundaries converge exactly', async (receiptT) => {
    for (const hookName of [
      'afterMutationRecordSync',
      'afterMarkerQuarantineSync',
      'afterMarkerQuarantineRemovalSync',
    ]) {
      await receiptT.test(hookName, async () => {
        const current = await cleanupReceiptFixture();
        let interrupted = false;
        await assert.rejects(completePreparingDeployment({
          ...current,
          hooks: {
            async [hookName]({ action, location }) {
              if (action !== 'delete' || location !== 'snapshot-cleanup') return;
              interrupted = true;
              throw new Error(`injected cleanup receipt delete ${hookName}`);
            },
          },
        }), new RegExp(`injected cleanup receipt delete ${hookName}`));
        assert.equal(interrupted, true);
        assert.deepEqual(await recoverGlobalDeployment(current), { phase: 'none' });
        assert.deepEqual(await recoverGlobalDeployment(current), { phase: 'none' });
        await assert.rejects(lstat(current.snapshot), /ENOENT/);
        assert.deepEqual(await readdir(current.journalDirectory), []);
      });
    }
  });

  await t.test('cleanup receipt create conflicts fail closed and preserve evidence', async (conflictT) => {
    for (const scenario of [
      {
        bytes: 'operator-owned cleanup receipt\n',
        name: 'foreign canonical preoccupation',
      },
      {
        bytes: '{"schema":2,"phase":"plan',
        name: 'partial canonical preoccupation',
      },
    ]) {
      await conflictT.test(scenario.name, async () => {
        const current = await cleanupReceiptFixture();
        let receipt = null;
        await assert.rejects(completePreparingDeployment({
          ...current,
          hooks: {
            async afterMarkerCandidateSync({
              action,
              canonical,
              location,
            }) {
              if (action !== 'create' || location !== 'snapshot-cleanup') return;
              receipt = canonical;
              await writeFile(receipt, scenario.bytes, { mode: 0o600 });
            },
          },
        }), /canonical|conflict|creation/i);
        assert.ok(receipt);
        assert.equal(await readFile(receipt, 'utf8'), scenario.bytes);
        await assert.rejects(
          recoverGlobalDeployment(current),
          /canonical|conflict|creation/i,
        );
        assert.equal(await readFile(receipt, 'utf8'), scenario.bytes);
      });
    }

    await conflictT.test('same-inode operation record mutation', async () => {
      const current = await cleanupReceiptFixture();
      let operation = null;
      let operationIdentity = null;
      await assert.rejects(completePreparingDeployment({
        ...current,
        hooks: {
          async afterMutationRecordSync({
            action,
            location,
            record,
          }) {
            if (action !== 'create' || location !== 'snapshot-cleanup') return;
            operation = record;
            operationIdentity = await lstat(record);
            await writeFile(record, '{}\n');
            throw new Error('injected operation record mutation');
          },
        },
      }), /injected operation record mutation/);
      assert.ok(operation);
      const mutatedIdentity = await lstat(operation);
      assert.equal(mutatedIdentity.dev, operationIdentity.dev);
      assert.equal(mutatedIdentity.ino, operationIdentity.ino);
      assert.equal(await readFile(operation, 'utf8'), '{}\n');
      await assert.rejects(
        recoverGlobalDeployment(current),
        /invalid marker mutation operation record/i,
      );
      const preservedIdentity = await lstat(operation);
      assert.equal(preservedIdentity.dev, operationIdentity.dev);
      assert.equal(preservedIdentity.ino, operationIdentity.ino);
      assert.equal(await readFile(operation, 'utf8'), '{}\n');
    });

    await conflictT.test('orphan mutation candidate', async () => {
      const current = await cleanupReceiptFixture();
      const orphan = path.join(
        current.journalDirectory,
        '.marker-mutation.123e4567-e89b-42d3-a456-426614174000.candidate',
      );
      const evidence = 'orphan cleanup candidate\n';
      await writeFile(orphan, evidence, { mode: 0o600 });
      await assert.rejects(
        completePreparingDeployment(current),
        /orphan marker mutation artifact/i,
      );
      assert.equal(await readFile(orphan, 'utf8'), evidence);
      await assert.rejects(
        recoverGlobalDeployment(current),
        /orphan marker mutation artifact/i,
      );
      assert.equal(await readFile(orphan, 'utf8'), evidence);
    });
  });

  await t.test('successful preparing recovery removes the exact bound snapshot', async () => {
    const current = await fixture();
    const secretFile = path.join(current.snapshot, 'deploy', 'cc-sync.env');
    await mkdir(path.dirname(secretFile), { recursive: true });
    await writeFile(secretFile, `CC_SYNC_SECRET=${'c'.repeat(64)}\n`, { mode: 0o600 });
    await prepareGlobalDeployment({
      ...current,
      nginxTransaction: path.join(current.snapshot, '.rollback', 'nginx'),
      runtime: {
        service_active: 'inactive',
        timer_active: 'inactive',
        timer_enabled: 'disabled',
      },
    });
    assert.equal(await completePreparingDeployment(current), 'cleared');
    await assert.rejects(lstat(current.snapshot), /ENOENT/);
    await assert.rejects(lstat(current.preparingJournal), /ENOENT/);
  });

  await t.test('committed recovery cleans its preparing marker and secret snapshot', async () => {
    const current = await committedAndPreparingFixture();

    assert.deepEqual(await recoverGlobalDeployment(current), { phase: 'committed' });

    await assert.rejects(lstat(current.committedJournal), /ENOENT/);
    await assert.rejects(lstat(current.preparingJournal), /ENOENT/);
    await assert.rejects(lstat(current.snapshot), /ENOENT/);
    assert.deepEqual(await readdir(current.journalDirectory), []);
    assert.equal(
      (await readdir(path.dirname(current.snapshot))).some((name) => (
        name.startsWith(`${path.basename(current.snapshot)}.cleanup.`)
      )),
      false,
    );
  });

  await t.test('committed cleanup SIGKILL is finished from its orphan receipt', async () => {
    const current = await committedAndPreparingFixture();
    const fixtureScript = path.join(
      SYNC_DIR,
      'test',
      'fixtures',
      'publish-and-pause.mjs',
    );
    const optionsFile = path.join(current.root, 'recovery-options.json');
    const ready = path.join(current.root, 'snapshot-delete-paused');
    await writeFile(optionsFile, JSON.stringify({
      committedJournal: current.committedJournal,
      destinations: current.destinations,
      gid,
      journalDirectory: current.journalDirectory,
      preparingJournal: current.preparingJournal,
      releases: current.releases,
      uid,
    }));
    const child = spawn(process.execPath, [
      fixtureScript,
      'recover-committed-and-pause',
      optionsFile,
      ready,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let childError = '';
    child.stderr.on('data', (chunk) => {
      childError += chunk;
    });
    await Promise.race([
      waitForPath(ready),
      new Promise((_, reject) => {
        child.once('exit', (code, signal) => {
          reject(new Error(
            `committed cleanup exited before pause: ${code ?? signal}: ${childError}`,
          ));
        });
      }),
    ]);
    child.kill('SIGKILL');
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    await assert.rejects(lstat(current.preparingJournal), /ENOENT/);
    await assert.rejects(lstat(current.snapshot), /ENOENT/);
    assert.equal((await lstat(current.committedJournal)).isFile(), true);
    assert.equal(
      (await readdir(current.journalDirectory)).filter((name) => (
        name.startsWith('.snapshot-cleanup.')
      )).length,
      1,
    );
    assert.equal(
      (await readdir(path.dirname(current.snapshot))).filter((name) => (
        name.startsWith(`${path.basename(current.snapshot)}.cleanup.`)
      )).length,
      1,
    );

    assert.deepEqual(await recoverGlobalDeployment(current), { phase: 'committed' });
    await assert.rejects(lstat(current.committedJournal), /ENOENT/);
    assert.deepEqual(await readdir(current.journalDirectory), []);
    assert.equal(
      (await readdir(path.dirname(current.snapshot))).some((name) => (
        name.startsWith(`${path.basename(current.snapshot)}.cleanup.`)
      )),
      false,
    );
  });

  await t.test('committed cleanup resumes after quarantine removal before receipt unlink', async () => {
    const current = await committedAndPreparingFixture();
    const fixtureScript = path.join(
      SYNC_DIR,
      'test',
      'fixtures',
      'publish-and-pause.mjs',
    );
    const optionsFile = path.join(current.root, 'receipt-recovery-options.json');
    const ready = path.join(current.root, 'receipt-unlink-paused');
    await writeFile(optionsFile, JSON.stringify({
      committedJournal: current.committedJournal,
      destinations: current.destinations,
      gid,
      journalDirectory: current.journalDirectory,
      preparingJournal: current.preparingJournal,
      releases: current.releases,
      uid,
    }));
    const child = spawn(process.execPath, [
      fixtureScript,
      'recover-committed-after-quarantine-delete-pause',
      optionsFile,
      ready,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let childError = '';
    child.stderr.on('data', (chunk) => {
      childError += chunk;
    });
    await Promise.race([
      waitForPath(ready),
      new Promise((_, reject) => {
        child.once('exit', (code, signal) => {
          reject(new Error(
            `receipt cleanup exited before pause: ${code ?? signal}: ${childError}`,
          ));
        });
      }),
    ]);
    child.kill('SIGKILL');
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });

    await assert.rejects(lstat(current.preparingJournal), /ENOENT/);
    await assert.rejects(lstat(current.snapshot), /ENOENT/);
    assert.equal((await lstat(current.committedJournal)).isFile(), true);
    const [receiptName] = (await readdir(current.journalDirectory))
      .filter((name) => name.startsWith('.snapshot-cleanup.'));
    assert.ok(receiptName);
    const receipt = JSON.parse(await readFile(
      path.join(current.journalDirectory, receiptName),
      'utf8',
    ));
    assert.equal(receipt.phase, 'deleted');
    await assert.rejects(lstat(receipt.quarantine), /ENOENT/);

    assert.deepEqual(await recoverGlobalDeployment(current), { phase: 'committed' });
    await assert.rejects(lstat(current.committedJournal), /ENOENT/);
    assert.deepEqual(await readdir(current.journalDirectory), []);
  });

  await t.test('committed cleanup conflicts retain recovery evidence and fail closed', async (conflictT) => {
    await conflictT.test('snapshot identity replacement', async () => {
      const current = await committedAndPreparingFixture();
      const preserved = `${current.snapshot}.operator-preserved`;
      await rename(current.snapshot, preserved);
      await mkdir(current.snapshot, { mode: 0o755 });

      await assert.rejects(
        recoverGlobalDeployment(current),
        /snapshot|identity|replacement/i,
      );
      assert.equal((await lstat(current.committedJournal)).isFile(), true);
      assert.equal((await lstat(current.preparingJournal)).isFile(), true);
      assert.equal((await lstat(preserved)).isDirectory(), true);
      assert.equal((await lstat(current.snapshot)).isDirectory(), true);
    });

    await conflictT.test('preparing marker CAS during cleanup removal', async () => {
      const current = await committedAndPreparingFixture();
      let preparingRenames = 0;
      await assert.rejects(recoverGlobalDeployment({
        ...current,
        hooks: {
          async beforeMarkerRename({ canonical }) {
            if (canonical !== current.preparingJournal) return;
            preparingRenames += 1;
            if (preparingRenames !== 1) return;
            await unlink(current.preparingJournal);
            await writeFile(
              current.preparingJournal,
              'operator committed-cleanup marker\n',
              { mode: 0o600 },
            );
          },
        },
      }), /changed|conflict|marker|canonical|CAS/i);
      assert.equal(preparingRenames, 1);
      assert.equal((await lstat(current.committedJournal)).isFile(), true);
      assert.equal(
        await readFile(current.preparingJournal, 'utf8'),
        'operator committed-cleanup marker\n',
      );
      assert.equal(
        (await readdir(current.journalDirectory)).filter((name) => (
          name.startsWith('.snapshot-cleanup.')
        )).length,
        1,
      );
      assert.equal(
        (await readdir(path.dirname(current.snapshot))).filter((name) => (
          name.startsWith(`${path.basename(current.snapshot)}.cleanup.`)
        )).length,
        1,
      );
    });
  });

  await t.test('orphan cleanup receipt finishes snapshot deletion after marker removal', async () => {
    const current = await fixture();
    await writeFile(path.join(current.snapshot, 'secret.txt'), 'secret snapshot bytes\n');
    await prepareGlobalDeployment({
      ...current,
      nginxTransaction: path.join(current.snapshot, '.rollback', 'nginx'),
      runtime: {
        service_active: 'inactive',
        timer_active: 'inactive',
        timer_enabled: 'disabled',
      },
    });
    await assert.rejects(completePreparingDeployment({
      ...current,
      hooks: {
        async afterMarkerRemovalBeforeSnapshotDelete() {
          throw new Error('simulated cleanup interruption');
        },
      },
    }), /simulated cleanup interruption/);
    await assert.rejects(lstat(current.preparingJournal), /ENOENT/);
    await assert.rejects(lstat(current.snapshot), /ENOENT/);
    assert.ok((await readdir(current.journalDirectory)).some((name) => (
      name.startsWith('.snapshot-cleanup.')
    )));

    assert.deepEqual(await recoverGlobalDeployment(current), { phase: 'none' });
    assert.deepEqual(await readdir(current.journalDirectory), []);
    assert.equal(
      (await readdir(path.dirname(current.snapshot))).some((name) => (
        name.startsWith(`${path.basename(current.snapshot)}.cleanup.`)
      )),
      false,
    );
  });

  await t.test('orphan cleanup rejects unproven deletion and receipt tampering', async (attackT) => {
    await attackT.test('quarantine deleted before cleanup phase', async () => {
      const current = await orphanCleanupFixture();
      await rm(current.quarantine, { recursive: true });

      await assert.rejects(
        recoverGlobalDeployment(current),
        /receipt|quarantine|snapshot|unsafe|identity/i,
      );
      assert.equal((await lstat(current.receipt)).isFile(), true);
    });

    await attackT.test('quarantine identity replacement', async () => {
      const current = await orphanCleanupFixture();
      const preserved = `${current.quarantine}.operator-preserved`;
      await rename(current.quarantine, preserved);
      await mkdir(current.quarantine, { mode: 0o755 });

      await assert.rejects(
        recoverGlobalDeployment(current),
        /receipt|quarantine|snapshot|unsafe|identity/i,
      );
      assert.equal((await lstat(current.receipt)).isFile(), true);
      assert.equal((await lstat(preserved)).isDirectory(), true);
      assert.equal((await lstat(current.quarantine)).isDirectory(), true);
    });

    await attackT.test('receipt identity mutation', async () => {
      const current = await orphanCleanupFixture();
      const record = JSON.parse(await readFile(current.receipt, 'utf8'));
      record.identity.ino += 1;
      await writeFile(current.receipt, `${JSON.stringify(record)}\n`);

      await assert.rejects(
        recoverGlobalDeployment(current),
        /receipt|snapshot|unsafe|identity|mismatch/i,
      );
      assert.equal((await lstat(current.receipt)).isFile(), true);
      assert.equal((await lstat(current.quarantine)).isDirectory(), true);
    });

    await attackT.test('forged deleted phase without a digest chain', async () => {
      const current = await orphanCleanupFixture();
      const record = JSON.parse(await readFile(current.receipt, 'utf8'));
      record.schema = 2;
      record.phase = 'deleted';
      await writeFile(current.receipt, `${JSON.stringify(record)}\n`);
      await rm(current.quarantine, { recursive: true });

      await assert.rejects(
        recoverGlobalDeployment(current),
        /receipt|snapshot|unsafe|phase|digest/i,
      );
      assert.equal((await lstat(current.receipt)).isFile(), true);
    });

    await attackT.test('receipt parent mismatch', async () => {
      const current = await orphanCleanupFixture();
      const record = JSON.parse(await readFile(current.receipt, 'utf8'));
      record.canonical = path.join(
        current.root,
        'other',
        'var',
        'tmp',
        path.basename(current.snapshot),
      );
      await writeFile(current.receipt, `${JSON.stringify(record)}\n`);

      await assert.rejects(
        recoverGlobalDeployment(current),
        /receipt|snapshot|unsafe|parent|quarantine/i,
      );
      assert.equal((await lstat(current.receipt)).isFile(), true);
      assert.equal((await lstat(current.quarantine)).isDirectory(), true);
    });
  });

  await t.test('snapshot root replacement or symlink substitution fails closed', async (snapshotT) => {
    for (const kind of ['directory', 'symlink']) {
      await snapshotT.test(kind, async () => {
        const current = await fixture();
        await prepareGlobalDeployment({
          ...current,
          nginxTransaction: path.join(current.snapshot, '.rollback', 'nginx'),
          runtime: {
            service_active: 'inactive',
            timer_active: 'inactive',
            timer_enabled: 'disabled',
          },
        });
        const preserved = `${current.snapshot}.operator-preserved`;
        await rename(current.snapshot, preserved);
        if (kind === 'directory') {
          await mkdir(current.snapshot, { mode: 0o755 });
        } else {
          await symlink(preserved, current.snapshot);
        }
        await assert.rejects(recoverGlobalDeployment(current), /snapshot|identity|symlink/i);
        assert.equal((await lstat(current.preparingJournal)).isFile(), true);
        assert.equal((await lstat(preserved)).isDirectory(), true);
        assert.equal((await lstat(current.snapshot)).isSymbolicLink(), kind === 'symlink');
      });
    }
  });
});

test('managed state validation accepts private lock artifacts but rejects unsafe trees', async (t) => {
  const { validateManagedRoot } = await import('../deployment-security.mjs');
  const { acquireSyncLock } = await import('../state.mjs');
  const uid = process.getuid();
  const gid = process.getgid();
  const generation = '123e4567-e89b-42d3-a456-426614174000';

  async function stateFixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-managed-state-'));
    await chmod(root, 0o750);
    const publicRoot = path.join(root, 'public');
    const generationRoot = path.join(publicRoot, 'generations', generation);
    await mkdir(path.join(generationRoot, 'sitemaps'), {
      mode: 0o750,
      recursive: true,
    });
    for (const directory of [
      publicRoot,
      path.join(publicRoot, 'generations'),
      generationRoot,
      path.join(generationRoot, 'sitemaps'),
    ]) {
      await chmod(directory, 0o750);
    }
    await writeFile(path.join(generationRoot, 'sitemap.xml'), '<sitemapindex/>\n', {
      mode: 0o640,
    });
    await writeFile(
      path.join(generationRoot, 'sitemaps', 'archive.xml'),
      '<urlset/>\n',
      { mode: 0o640 },
    );
    await symlink(`generations/${generation}`, path.join(publicRoot, 'current'));
    const deadOwner = {
      schema: 2,
      pid: 999_999_999,
      hostname: os.hostname(),
      process_start: 'dead-deployment-owner',
      created_at: Date.now(),
    };
    await writeFile(
      path.join(root, 'state.json'),
      `${JSON.stringify({ schema: 1, last_seq: 0, bootstrap: null, pages: {} })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(root, 'sync.lock'),
      `${JSON.stringify({ ...deadOwner, token: 'dead-main' })}\n`,
      { mode: 0o600 },
    );
    for (const privateFile of [
      `.sync.lock.999999999.${generation}.candidate`,
      `.sync.lock.stale.${generation}`,
      `.state.json.999999999.${generation}.tmp`,
    ]) {
      await writeFile(path.join(root, privateFile), 'private crash artifact\n', {
        mode: 0o600,
      });
    }
    const guard = path.join(root, 'sync.lock.guard');
    await mkdir(guard, { mode: 0o700 });
    await writeFile(
      path.join(guard, 'owner-dead-guard.json'),
      `${JSON.stringify({ ...deadOwner, token: 'dead-guard' })}\n`,
      { mode: 0o600 },
    );
    const abandoned = path.join(
      root,
      `.sync.lock.guard.999999999.${generation}.candidate`,
    );
    await mkdir(abandoned, { mode: 0o700 });
    await writeFile(
      path.join(abandoned, 'owner-abandoned.json'),
      'crash-left owner metadata\n',
      { mode: 0o600 },
    );
    return { root, guard };
  }

  await t.test('a stopped active oneshot can recover its legitimate private state', async () => {
    const fixture = await stateFixture();
    await validateManagedRoot({
      gid,
      kind: 'state',
      root: fixture.root,
      uid,
    });
    const lock = await acquireSyncLock(fixture.root);
    assert.notEqual(lock.owner.token, 'dead-main');
    await lock.release();
    await assert.rejects(stat(path.join(fixture.root, 'sync.lock')), /ENOENT/);
    await assert.rejects(stat(fixture.guard), /ENOENT/);
  });

  await t.test('0700 is forbidden below the Nginx public tree', async () => {
    const fixture = await stateFixture();
    const privatePublic = path.join(fixture.root, 'public', 'private');
    await mkdir(privatePublic, { mode: 0o700 });
    await assert.rejects(
      validateManagedRoot({ gid, kind: 'state', root: fixture.root, uid }),
      /unsafe identity or mode/,
    );
  });

  await t.test('unknown state symlinks remain forbidden', async () => {
    const fixture = await stateFixture();
    await symlink('state.json', path.join(fixture.root, 'unknown-link'));
    await assert.rejects(
      validateManagedRoot({ gid, kind: 'state', root: fixture.root, uid }),
      /unsafe entry/,
    );
  });

  await t.test('group-writable private state remains forbidden', async () => {
    const fixture = await stateFixture();
    await chmod(fixture.guard, 0o770);
    await assert.rejects(
      validateManagedRoot({ gid, kind: 'state', root: fixture.root, uid }),
      /unsafe identity or mode/,
    );
  });
});

test('Nginx transaction uses compare-before-commit and compare-before-rollback', async (t) => {
  const {
    commitNginxTransaction,
    prepareNginxTransaction,
    rollbackNginxTransaction,
  } = await import('../nginx-config-transaction.mjs');
  const fixture = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-nginx-transaction-'));
    const vhost = path.join(root, 'site.conf');
    const snippet = path.join(root, 'mirror.conf');
    const snippetSource = path.join(root, 'snippet-source.conf');
    const transaction = path.join(root, 'transaction');
    await writeFile(vhost, VHOST_FIXTURE, { mode: 0o640 });
    await writeFile(snippetSource, 'location = /transaction-proof { return 204; }\n');
    await prepareNginxTransaction({
      defaultGid: process.getgid(),
      defaultUid: process.getuid(),
      snippet,
      snippetSource,
      transaction,
      vhost,
    });
    return { root, snippet, transaction, vhost };
  };

  await t.test('panel change before commit', async () => {
    const current = await fixture();
    await writeFile(current.vhost, 'panel changed before commit\n');
    await assert.rejects(
      commitNginxTransaction({ transaction: current.transaction }),
      /vhost changed before commit/,
    );
    assert.equal(await readFile(current.vhost, 'utf8'), 'panel changed before commit\n');
    await assert.rejects(stat(current.snippet), /ENOENT/);
  });

  await t.test('panel change before rollback', async () => {
    const current = await fixture();
    await commitNginxTransaction({ transaction: current.transaction });
    await writeFile(current.vhost, 'panel changed after commit\n');
    await assert.rejects(
      rollbackNginxTransaction({ transaction: current.transaction }),
      /rollback conflict.*vhost/,
    );
    assert.equal(await readFile(current.vhost, 'utf8'), 'panel changed after commit\n');
    await assert.rejects(stat(current.snippet), /ENOENT/);
  });

  await t.test('uncontended rollback', async () => {
    const current = await fixture();
    await commitNginxTransaction({ transaction: current.transaction });
    assert.match(await readFile(current.vhost, 'utf8'), /AIFEEDS-CC-CONTENT-MIRROR-BEGIN/);
    await rollbackNginxTransaction({ transaction: current.transaction });
    assert.equal(await readFile(current.vhost, 'utf8'), VHOST_FIXTURE);
    assert.equal((await stat(current.vhost)).mode & 0o777, 0o640);
    await assert.rejects(stat(current.snippet), /ENOENT/);
  });
});

test('snapshot directory operations are no-replace and descriptor-bound', async (t) => {
  async function pausedHelper(args, root) {
    const ready = path.join(root, `ready-${Math.random()}`);
    const gate = path.join(root, `gate-${Math.random()}`);
    await writeFile(gate, 'hold\n');
    const child = spawn('/usr/bin/python3', [
      LINUX_FS_HELPER,
      ...args,
      '--test-ready',
      ready,
      '--test-gate',
      gate,
    ], {
      env: {
        ...process.env,
        AIFEEDS_LINUX_FS_TEST_MODE: '1',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    await Promise.race([
      waitForPath(ready),
      new Promise((_, reject) => {
        child.once('exit', (code, signal) => {
          reject(new Error(
            `filesystem helper exited before pause: ${code ?? signal}: ${stderr}`,
          ));
        });
      }),
    ]);
    return {
      child,
      gate,
      async release() {
        await rm(gate, { force: true });
        return new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code, signal) => resolve({ code, signal, stderr }));
        });
      },
    };
  }

  await t.test('occupied quarantine is never overwritten', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-snapshot-move-dest-'));
    const source = path.join(root, 'snapshot');
    const quarantine = path.join(root, 'snapshot.cleanup');
    await mkdir(source, { mode: 0o755 });
    const identity = await lstat(source);
    const paused = await pausedHelper([
      'move-directory-no-replace',
      source,
      quarantine,
      String(identity.dev),
      String(identity.ino),
      String(identity.uid),
      String(identity.gid),
      String(identity.mode & 0o7777),
    ], root);
    await mkdir(quarantine, { mode: 0o700 });
    await writeFile(path.join(quarantine, 'operator.txt'), 'operator directory\n');
    const replacement = await lstat(quarantine);

    const result = await paused.release();

    assert.notEqual(result.code, 0, result.stderr);
    assert.equal((await lstat(source)).ino, identity.ino);
    assert.equal((await lstat(quarantine)).ino, replacement.ino);
    assert.equal(
      await readFile(path.join(quarantine, 'operator.txt'), 'utf8'),
      'operator directory\n',
    );
  });

  await t.test('directory identity is reported for later bound cleanup', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-snapshot-identity-'));
    const snapshot = path.join(root, 'snapshot');
    await mkdir(snapshot, { mode: 0o700 });
    const expected = await lstat(snapshot);

    const result = spawnSync('/usr/bin/python3', [
      LINUX_FS_HELPER,
      'inspect-directory',
      snapshot,
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      `${expected.dev}\t${expected.ino}\t${expected.uid}\t${expected.gid}\t${expected.mode & 0o7777}\n`,
    );
  });

  await t.test('source replacement is restored instead of quarantined', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-snapshot-move-source-'));
    const source = path.join(root, 'snapshot');
    const quarantine = path.join(root, 'snapshot.cleanup');
    const preserved = path.join(root, 'snapshot.preserved');
    await mkdir(source, { mode: 0o755 });
    await writeFile(path.join(source, 'owned.txt'), 'owned snapshot\n');
    const identity = await lstat(source);
    const paused = await pausedHelper([
      'move-directory-no-replace',
      source,
      quarantine,
      String(identity.dev),
      String(identity.ino),
      String(identity.uid),
      String(identity.gid),
      String(identity.mode & 0o7777),
    ], root);
    await rename(source, preserved);
    await mkdir(source, { mode: 0o700 });
    await writeFile(path.join(source, 'operator.txt'), 'operator replacement\n');
    const replacement = await lstat(source);

    const result = await paused.release();

    assert.notEqual(result.code, 0, result.stderr);
    assert.equal((await lstat(source)).ino, replacement.ino);
    await assert.rejects(lstat(quarantine), /ENOENT/);
    assert.equal(await readFile(path.join(source, 'operator.txt'), 'utf8'), 'operator replacement\n');
    assert.equal(await readFile(path.join(preserved, 'owned.txt'), 'utf8'), 'owned snapshot\n');
  });

  await t.test('cleanup rejects a pathname replacement before descriptor traversal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-snapshot-cleanup-fd-'));
    const quarantine = path.join(root, 'snapshot.cleanup');
    const preserved = path.join(root, 'snapshot.preserved');
    await mkdir(path.join(quarantine, 'nested'), { recursive: true, mode: 0o755 });
    await writeFile(path.join(quarantine, 'nested', 'secret.txt'), 'owned secret\n');
    const identity = await lstat(quarantine);
    const paused = await pausedHelper([
      'remove-directory-bound',
      quarantine,
      String(identity.dev),
      String(identity.ino),
      String(identity.uid),
      String(identity.gid),
      String(identity.mode & 0o7777),
    ], root);
    await rename(quarantine, preserved);
    await mkdir(quarantine, { mode: 0o700 });
    await writeFile(path.join(quarantine, 'operator.txt'), 'operator replacement\n');
    const replacement = await lstat(quarantine);

    const result = await paused.release();

    assert.notEqual(result.code, 0, result.stderr);
    assert.equal((await lstat(quarantine)).ino, replacement.ino);
    assert.equal(await readFile(path.join(quarantine, 'operator.txt'), 'utf8'), 'operator replacement\n');
    assert.equal(
      await readFile(path.join(preserved, 'nested', 'secret.txt'), 'utf8'),
      'owned secret\n',
    );
  });
});

test('installer allocates snapshots under a managed root without modifying var tmp', async () => {
  const installer = await read('install-remote.sh');
  const deployer = await read('deploy-to-cc.sh');
  const payloadFiles = await read('payload-files.txt');
  assert.match(installer, /\/var\/lib\/aifeeds-cc-deploy-snapshots/);
  assert.doesNotMatch(installer, /(?:install\s+-d|chmod|chown)[^\n]*\/var\/tmp/);
  assert.doesNotMatch(installer, /SNAPSHOT_PARENT=.*\/var\/tmp/);
  assert.match(payloadFiles, /^cc-site\/sync\/deployment-linux-fs\.py$/m);
  assert.match(deployer, /LINUX_FS_DIGEST/);
  assert.match(deployer, /deployment-linux-fs\.fixed\.py/);
  assert.match(deployer, /AIFEEDS_FIXED_LINUX_FS_HELPER/);
});

test('snapshot parent validation rejects an unexpected owner without repair', async () => {
  const { ensurePrivateSnapshotParent } = await import('../deployment-security.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-snapshot-parent-owner-'));
  const snapshotParent = path.join(root, 'var', 'lib', 'aifeeds-cc-deploy-snapshots');
  await mkdir(snapshotParent, { recursive: true, mode: 0o700 });
  await chmod(snapshotParent, 0o700);
  const before = await lstat(snapshotParent);

  await assert.rejects(ensurePrivateSnapshotParent({
    gid: before.gid,
    root: snapshotParent,
    uid: before.uid + 1,
  }), /owner|identity|unsafe/i);

  const after = await lstat(snapshotParent);
  assert.equal(after.ino, before.ino);
  assert.equal(after.uid, before.uid);
  assert.equal(after.mode & 0o7777, 0o700);
});

test('trusted Python resolver accepts system symlinks and rejects unsafe chains', async (t) => {
  const { resolveTrustedExecutable } = await import('../deployment-security.mjs');
  const uid = process.getuid();

  async function fixture() {
    const boundary = await mkdtemp(path.join(os.tmpdir(), 'cc-python-chain-'));
    const bin = path.join(boundary, 'usr', 'bin');
    const python = path.join(bin, 'python3');
    const target = path.join(bin, 'python3.11');
    await mkdir(bin, { recursive: true, mode: 0o755 });
    await chmod(boundary, 0o700);
    await chmod(path.join(boundary, 'usr'), 0o755);
    await chmod(bin, 0o755);
    await executable(target, '#!/usr/bin/env bash\nexit 0\n');
    await symlink('python3.11', python);
    return { bin, boundary, python, target };
  }

  await t.test('Debian relative python3 symlink', async () => {
    const current = await fixture();
    assert.equal(await resolveTrustedExecutable({
      boundary: current.boundary,
      executable: current.python,
      logicalRoot: '/usr/bin',
      uid,
    }), current.target);
  });

  await t.test('absolute target remains mapped inside trusted system bin', async () => {
    const current = await fixture();
    await unlink(current.python);
    await symlink('/usr/bin/python3.11', current.python);
    assert.equal(await resolveTrustedExecutable({
      boundary: current.boundary,
      executable: current.python,
      logicalRoot: '/usr/bin',
      uid,
    }), current.target);
  });

  for (const scenario of [
    {
      name: 'world-writable parent',
      async mutate(current) {
        await chmod(current.bin, 0o777);
      },
      uid,
    },
    {
      name: 'unexpected owner',
      async mutate() {},
      uid: uid + 1,
    },
    {
      name: 'symlink loop',
      async mutate(current) {
        await unlink(current.target);
        await symlink('python3', current.target);
      },
      uid,
    },
    {
      name: 'trusted-root escape',
      async mutate(current) {
        const escaped = path.join(current.boundary, 'tmp', 'python3.11');
        await mkdir(path.dirname(escaped), { recursive: true });
        await executable(escaped, '#!/usr/bin/env bash\nexit 0\n');
        await unlink(current.python);
        await symlink('../../tmp/python3.11', current.python);
      },
      uid,
    },
    {
      name: 'final target is not regular',
      async mutate(current) {
        await unlink(current.target);
        await mkdir(current.target);
      },
      uid,
    },
  ]) {
    await t.test(scenario.name, async () => {
      const current = await fixture();
      await scenario.mutate(current);
      await assert.rejects(resolveTrustedExecutable({
        boundary: current.boundary,
        executable: current.python,
        logicalRoot: '/usr/bin',
        uid: scenario.uid,
      }), /owner|writable|loop|escape|trusted|regular|executable/i);
    });
  }
});

test('Linux filesystem helper probe proves no-replace and leaves no artifacts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-linux-fs-probe-'));
  const parent = path.join(root, 'run');
  await mkdir(parent, { mode: 0o700 });
  const args = [
    LINUX_FS_HELPER,
    'probe',
    parent,
    String(process.getuid()),
    String(process.getgid()),
  ];
  const supported = spawnSync('/usr/bin/python3', args, { encoding: 'utf8' });
  assert.equal(supported.status, 0, supported.stderr);
  assert.deepEqual(await readdir(parent), []);

  const unsupported = spawnSync('/usr/bin/python3', args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      AIFEEDS_LINUX_FS_FORCE_UNSUPPORTED: '1',
      AIFEEDS_LINUX_FS_TEST_MODE: '1',
    },
  });
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stderr, /unsupported|not implemented|rename/i);
  assert.deepEqual(await readdir(parent), []);
});

test('legacy var tmp snapshots are accepted only under an unchanged root sticky parent', async (t) => {
  const { prepareGlobalDeployment } = await import(
    '../deployment-file-transaction.mjs'
  );
  const uid = process.getuid();
  const gid = process.getgid();

  async function legacyFixture(kind) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-legacy-snapshot-'));
    const releases = path.join(root, 'aifeeds-cc-sync-releases');
    const manifest = 'b'.repeat(64);
    const release = path.join(releases, manifest);
    const varRoot = path.join(root, 'var');
    const varTmp = path.join(varRoot, 'tmp');
    await mkdir(release, { recursive: true, mode: 0o755 });
    await chmod(releases, 0o755);
    await chmod(release, 0o755);
    if (kind === 'symlink') {
      await mkdir(varRoot, { recursive: true, mode: 0o755 });
      const outside = path.join(root, 'operator-tmp');
      await mkdir(outside, { mode: 0o1777 });
      await chmod(outside, 0o1777);
      await symlink(outside, varTmp);
    } else {
      await mkdir(varTmp, { recursive: true, mode: kind === 'valid' ? 0o1777 : 0o755 });
      await chmod(varTmp, kind === 'valid' ? 0o1777 : 0o755);
    }
    const snapshot = path.join(varTmp, 'aifeeds-cc-root-snapshot.ABC123');
    await mkdir(snapshot, { mode: 0o755 });
    await chmod(snapshot, 0o755);
    return {
      committedJournal: path.join(releases, '.deployment-committed.json'),
      destinations: [
        path.join(root, 'opt', 'aifeeds-cc-sync'),
        path.join(root, 'systemd', 'aifeeds-cc-sync.service'),
        path.join(root, 'systemd', 'aifeeds-cc-sync.timer'),
        path.join(root, 'aifeeds', 'cc-sync.env'),
      ],
      gid,
      journalDirectory: path.join(releases, '.deployment-journal'),
      manifest,
      nginxTransaction: path.join(snapshot, '.rollback', 'nginx'),
      preparingJournal: path.join(releases, '.deployment-preparing.json'),
      release,
      releases,
      runtime: {
        service_active: 'inactive',
        timer_active: 'inactive',
        timer_enabled: 'disabled',
      },
      snapshot,
      uid,
      varTmp,
    };
  }

  await t.test('01777 directory is accepted and not modified', async () => {
    const current = await legacyFixture('valid');
    const before = await lstat(current.varTmp);
    const marker = await prepareGlobalDeployment(current);
    const after = await lstat(current.varTmp);
    assert.equal(marker.snapshot.parent, current.varTmp);
    assert.equal(after.ino, before.ino);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.mode & 0o7777, 0o1777);
  });

  for (const kind of ['wrong-mode', 'symlink']) {
    await t.test(`${kind} parent is rejected without repair`, async () => {
      const current = await legacyFixture(kind);
      const before = await lstat(current.varTmp);
      await assert.rejects(
        prepareGlobalDeployment(current),
        /snapshot parent|unsafe/i,
      );
      const after = await lstat(current.varTmp);
      assert.equal(after.ino, before.ino);
      assert.equal(after.isSymbolicLink(), before.isSymbolicLink());
      assert.equal(after.mode & 0o7777, before.mode & 0o7777);
    });
  }
});

const VHOST_FIXTURE = `server {
    listen 80;
    server_name ai-feeds.cc;
    if ($server_port !~ 443) {
        rewrite ^(?!/shenma-site-verification\\.txt$)(/.*)$ https://$host$1 permanent;
    }
}

server {
    listen 443 ssl http2;
    server_name ai-feeds.cc www.ai-feeds.cc;
    #REWRITE-END
    location ^~ /auth/wechat/ {
        proxy_pass http://127.0.0.1:3001;
    }
    location / { try_files $uri $uri/ =404; }
}
`;

async function remoteDeployHarness({
  existingSnippet = null,
  priorDeployment = false,
  serviceActive = false,
  serviceState = serviceActive ? 'active' : 'inactive',
  timerActive = false,
  timerState = timerActive ? 'active' : 'inactive',
  timerEnabled = false,
  timerEnabledState = timerEnabled ? 'enabled' : 'disabled',
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-deploy-remote-'));
  const fakeBin = path.join(root, 'fake-bin');
  const stage = path.join(root, 'tmp', 'aifeeds-cc-sync.ABC123');
  const siteRoot = path.join(root, 'www', 'wwwroot', 'ai-feeds.cc');
  const vhostDir = path.join(root, 'www', 'server', 'panel', 'vhost', 'nginx');
  const vhost = path.join(vhostDir, 'html_ai-feeds.cc.conf');
  const snippet = path.join(vhostDir, 'aifeeds-cc-content-mirror.inc');
  const log = path.join(root, 'commands.log');
  const systemctlState = path.join(root, 'systemctl-state');
  const payloadTestProof = path.join(root, 'payload-tests-ran');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(systemctlState);
  await mkdir(path.join(root, 'run'), { mode: 0o755 });
  const pythonBin = path.join(root, 'usr', 'bin');
  const python = path.join(pythonBin, 'python3');
  const pythonTarget = path.join(pythonBin, 'python3.11');
  await mkdir(pythonBin, { recursive: true, mode: 0o755 });
  await chmod(path.join(root, 'usr'), 0o755);
  await chmod(pythonBin, 0o755);
  await executable(
    pythonTarget,
    '#!/usr/bin/env bash\nexec /usr/bin/python3 "$@"\n',
  );
  await symlink('python3.11', python);
  await writeFile(log, '');
  await mkdir(path.dirname(stage), { recursive: true });
  await mkdir(path.join(root, 'var', 'lib'), { recursive: true });
  await mkdir(siteRoot, { recursive: true });
  await mkdir(vhostDir, { recursive: true });
  await writeFile(path.join(siteRoot, 'sitemap-static.xml'), '<urlset/>\n');
  await writeFile(vhost, VHOST_FIXTURE);
  if (existingSnippet !== null) await writeFile(snippet, existingSnippet);
  const stagedEnv = path.join(root, 'cc-sync.env');
  await writeFile(
    stagedEnv,
    `${[
      `CC_SYNC_SECRET=${'c'.repeat(64)}`,
      'CC_SYNC_BASE_URL=https://api.ai-feeds.com',
      'CC_SITE_ROOT=/www/wwwroot/ai-feeds.cc',
      'CC_SYNC_STATE_DIR=/var/lib/aifeeds-cc-sync',
      'CC_SYNC_CONCURRENCY=8',
      'CC_SYNC_PAGE_LIMIT=200',
      'CC_SYNC_REQUEST_TIMEOUT_MS=15000',
    ].join('\n')}\n`,
    { mode: 0o600 },
  );
  await buildPayload({
    envFile: stagedEnv,
    payload: stage,
    repoRoot: path.resolve(SYNC_DIR, '..', '..'),
  });
  const manifestDigest = createHash('sha256')
    .update(await readFile(path.join(stage, 'MANIFEST.sha256')))
    .digest('hex');

  let oldReleaseId = null;
  if (priorDeployment) {
    const oldManifest = manifestWithEnvironmentDigest(
      await readFile(path.join(stage, 'MANIFEST.sha256')),
      '1'.repeat(64),
    );
    oldReleaseId = createHash('sha256').update(oldManifest).digest('hex');
    const oldRelease = path.join(
      root,
      'opt',
      'aifeeds-cc-sync-releases',
      oldReleaseId,
    );
    await mkdir(oldRelease, { recursive: true });
    await cp(path.join(stage, 'cc-site'), path.join(oldRelease, 'cc-site'), {
      recursive: true,
    });
    await writeFile(path.join(oldRelease, 'MANIFEST.sha256'), oldManifest);
    await normalizeReleaseFixture(oldRelease);
    await symlink(
      `aifeeds-cc-sync-releases/${oldReleaseId}/cc-site/sync`,
      path.join(root, 'opt', 'aifeeds-cc-sync'),
    );
    const etcAifeeds = path.join(root, 'etc', 'aifeeds');
    const unitDir = path.join(root, 'etc', 'systemd', 'system');
    await mkdir(etcAifeeds, { recursive: true });
    await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(etcAifeeds, 'cc-sync.env'), 'OLD_ENV=1\n');
    await writeFile(path.join(unitDir, 'aifeeds-cc-sync.service'), 'OLD_SERVICE\n');
    await writeFile(path.join(unitDir, 'aifeeds-cc-sync.timer'), 'OLD_TIMER\n');
  }
  if (timerEnabledState !== 'disabled') {
    await writeFile(path.join(systemctlState, 'timer-enabled'), `${timerEnabledState}\n`);
  }
  if (timerState !== 'inactive') {
    await writeFile(path.join(systemctlState, 'timer-active'), `${timerState}\n`);
  }
  if (serviceState !== 'inactive') {
    await writeFile(path.join(systemctlState, 'service-active'), `${serviceState}\n`);
  }

  await executable(path.join(fakeBin, 'install'), `#!/usr/bin/env bash
set -euo pipefail
printf 'install' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
args=()
while (($#)); do
  case "$1" in
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
/usr/bin/install "\${args[@]}"
`);
  await executable(path.join(fakeBin, 'chown'), `#!/usr/bin/env bash
printf 'chown' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
`);
  await executable(path.join(fakeBin, 'useradd'), `#!/usr/bin/env bash
printf 'useradd' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
: > "$AIFEEDS_DEPLOY_ROOT/user-created"
`);
  await executable(path.join(fakeBin, 'getent'), `#!/usr/bin/env bash
if [[ "$*" == 'passwd www' ]]; then
  printf 'www:x:%s:%s::/nonexistent:/sbin/nologin\n' \
    "$AIFEEDS_ROOT_UID" "$AIFEEDS_ROOT_GID"
  exit 0
fi
if [[ "$*" == 'group www' ]]; then
  printf 'www:x:%s:\n' "$AIFEEDS_ROOT_GID"
  exit 0
fi
if [[ "$*" == 'passwd aifeeds-sync' && -n "\${AIFEEDS_SYNC_PASSWD:-}" ]]; then
  printf '%s\n' "$AIFEEDS_SYNC_PASSWD"
  exit 0
fi
if [[ "$*" == 'passwd aifeeds-sync' && -f "$AIFEEDS_DEPLOY_ROOT/user-created" ]]; then
  printf 'aifeeds-sync:x:%s:%s::/nonexistent:/sbin/nologin\n' \
    "$AIFEEDS_ROOT_UID" "$AIFEEDS_ROOT_GID"
  exit 0
fi
if [[ "$*" == 'passwd aifeeds-sync' ]]; then exit 2; fi
exit 2
`);
  await executable(path.join(fakeBin, 'userdel'), `#!/usr/bin/env bash
set -euo pipefail
printf 'userdel' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
[[ "\${AIFEEDS_USERDEL_EXIT:-0}" == 0 ]] || exit "$AIFEEDS_USERDEL_EXIT"
rm -f "$AIFEEDS_DEPLOY_ROOT/user-created"
`);
  await executable(path.join(fakeBin, 'runuser'), `#!/usr/bin/env bash
set -euo pipefail
printf 'runuser' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
if [[ "\${AIFEEDS_PAUSE_PAYLOAD_TESTS:-0}" == 1 && "$*" == *AIFEEDS_REMOTE_PAYLOAD_TEST=1* ]]; then
  : > "$AIFEEDS_PAUSE_READY"
  while [[ -e "$AIFEEDS_PAUSE_GATE" ]]; do sleep 0.05; done
fi
if [[ "\${AIFEEDS_ENFORCE_RUNUSER_TRAVERSAL:-0}" == 1 \
  && "$*" == *'/var/lib/aifeeds-cc-deploy-snapshots/'* ]]; then
  printf 'runuser cannot traverse the root-private snapshot parent\n' >&2
  exit 7
fi
if [[ "\${AIFEEDS_ENFORCE_RUNUSER_CLEAN_ENV:-0}" == 1 \
  && "$*" == *'AIFEEDS_REMOTE_PAYLOAD_TEST=1'* \
  && "$*" != *'-- env -i '* ]]; then
  printf 'runuser payload tests did not request a clean environment\n' >&2
  exit 8
fi
while (($#)) && [[ "$1" != '--' ]]; do shift; done
shift
if [[ "\${1:-}" == env && "\${2:-}" == -i ]]; then
  shift 2
  clean_assignments=()
  while (($#)) && [[ "$1" == *=* ]]; do
    clean_assignments+=("$1")
    shift
  done
  env -i "\${clean_assignments[@]}" \
    PATH="$AIFEEDS_HARNESS_CHILD_PATH" \
    TMPDIR="$AIFEEDS_HARNESS_CHILD_TMPDIR" \
    AIFEEDS_HARNESS_LOG="$AIFEEDS_HARNESS_LOG" \
    AIFEEDS_REAL_NODE="$AIFEEDS_REAL_NODE" \
    AIFEEDS_PAYLOAD_TEST_PROOF="$AIFEEDS_PAYLOAD_TEST_PROOF" \
    AIFEEDS_NODE_TEST_EXIT="\${AIFEEDS_NODE_TEST_EXIT:-0}" \
    AIFEEDS_FAST_PAYLOAD_TESTS="\${AIFEEDS_FAST_PAYLOAD_TESTS:-0}" \
    "$@"
  exit
fi
"$@"
`);
  await executable(path.join(fakeBin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
printf 'node' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
if [[ "\${2:-}" == 'commit-global' \
  && "\${AIFEEDS_GLOBAL_COMMIT_EXIT:-0}" != 0 ]]; then
  exit "$AIFEEDS_GLOBAL_COMMIT_EXIT"
fi
if [[ "\${2:-}" == 'commit-global' \
  && "\${AIFEEDS_CREATE_FOREIGN_COMMITTED_BEFORE_COMMIT:-0}" == 1 ]]; then
  committed="$AIFEEDS_DEPLOY_ROOT/opt/aifeeds-cc-sync-releases/.deployment-committed.json"
  printf '%s\n' '{"schema":2,"phase":"committed","manifest":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","release":"/operator/release","transactions":[]}' > "$committed"
  chmod 0600 "$committed"
fi
if [[ "\${2:-}" == 'commit-global' \
  && "\${AIFEEDS_KILL_BEFORE_GLOBAL_COMMIT:-0}" == 1 ]]; then
  kill -KILL "$PPID"
  exit 137
fi
if [[ "\${2:-}" == 'finalize-path' \
  && -f "$AIFEEDS_DEPLOY_ROOT/opt/aifeeds-cc-sync-releases/.deployment-committed.json" ]]; then
  finalize_count_file="$AIFEEDS_DEPLOY_ROOT/global-finalize-count"
  finalize_count=0
  [[ ! -f "$finalize_count_file" ]] || read -r finalize_count < "$finalize_count_file"
  finalize_count=$((finalize_count + 1))
  printf '%s\n' "$finalize_count" > "$finalize_count_file"
  if [[ "$finalize_count" == "\${AIFEEDS_FINALIZE_FAIL_AT:-0}" ]]; then
    exit 67
  fi
fi
if [[ "\${AIFEEDS_ASSERT_CANDIDATE_STOPPED_BEFORE_ROLLBACK:-0}" == 1 \
  && -f "$AIFEEDS_DEPLOY_ROOT/systemctl-state/service-active" \
  && ("\${2:-}" == 'rollback-path' \
    || ("\${1:-}" == *nginx-config-transaction.mjs \
      && "\${2:-}" == 'rollback')) ]]; then
  : > "$AIFEEDS_DEPLOY_ROOT/rollback-while-candidate-active"
  exit 91
fi
if [[ "\${1:-}" == '-p' ]]; then printf '%s\n' "\${AIFEEDS_NODE_MAJOR:-18}"; exit 0; fi
if [[ "\${1:-}" == '--test' ]]; then
  [[ "\${AIFEEDS_NODE_TEST_EXIT:-0}" == 0 ]] || exit "$AIFEEDS_NODE_TEST_EXIT"
  unset NODE_TEST_CONTEXT
  if [[ "\${AIFEEDS_FAST_PAYLOAD_TESTS:-0}" == 1 ]]; then
    "$AIFEEDS_REAL_NODE" --test "\${2:?first payload test is required}"
  else
    "$AIFEEDS_REAL_NODE" "$@"
  fi
  : > "$AIFEEDS_PAYLOAD_TEST_PROOF"
  exit 0
fi
node_status=0
"$AIFEEDS_REAL_NODE" "$@" || node_status=$?
if ((node_status == 0)) && [[ "\${AIFEEDS_KILL_AFTER_PATH_PUBLISH:-0}" != 0 ]] \
  && [[ "\${2:-}" == 'install-symlink-transaction' \
    || "\${2:-}" == 'install-transaction' ]]; then
  publish_count_file="$AIFEEDS_DEPLOY_ROOT/path-publish-count"
  publish_count=0
  [[ ! -f "$publish_count_file" ]] || read -r publish_count < "$publish_count_file"
  publish_count=$((publish_count + 1))
  printf '%s\n' "$publish_count" > "$publish_count_file"
  if [[ "$publish_count" == "$AIFEEDS_KILL_AFTER_PATH_PUBLISH" ]]; then
    kill -KILL "$PPID"
    exit 137
  fi
fi
if ((node_status == 0)) && [[ "\${2:-}" == 'complete-preparing' \
  && "\${AIFEEDS_EXIT_AFTER_PREPARING_RECOVERY:-0}" != 0 ]]; then
  exit "$AIFEEDS_EXIT_AFTER_PREPARING_RECOVERY"
fi
exit "$node_status"
`);
await executable(path.join(fakeBin, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
state="$AIFEEDS_DEPLOY_ROOT/systemctl-state"
unit_dir="$AIFEEDS_DEPLOY_ROOT/etc/systemd/system"
read_state() {
  local file=$1
  local fallback=$2
  if [[ -f "$file" ]]; then
    tr -d '\n' < "$file"
  else
    printf '%s' "$fallback"
  fi
}
load_state() {
  local unit=$1
  local override=$2
  if [[ -n "$override" ]]; then
    printf '%s\n' "$override"
  elif [[ -f "$unit_dir/$unit" ]]; then
    printf 'loaded\n'
  else
    printf 'not-found\n'
  fi
}
case "$*" in
  'show --property=LoadState --value aifeeds-cc-sync.service')
    [[ "\${AIFEEDS_SYSTEMCTL_SHOW_EXIT:-0}" == 0 ]] || exit "$AIFEEDS_SYSTEMCTL_SHOW_EXIT"
    load_state aifeeds-cc-sync.service "\${AIFEEDS_SERVICE_LOAD_STATE:-}" ;;
  'show --property=LoadState --value aifeeds-cc-sync.timer')
    [[ "\${AIFEEDS_SYSTEMCTL_SHOW_EXIT:-0}" == 0 ]] || exit "$AIFEEDS_SYSTEMCTL_SHOW_EXIT"
    load_state aifeeds-cc-sync.timer "\${AIFEEDS_TIMER_LOAD_STATE:-}" ;;
  'is-enabled aifeeds-cc-sync.timer')
    if [[ -f "$state/timer-enabled" ]]; then
      enabled=$(read_state "$state/timer-enabled" disabled)
    elif [[ -f "$unit_dir/aifeeds-cc-sync.timer" ]]; then
      enabled=disabled
    else
      enabled=not-found
    fi
    printf '%s\n' "$enabled"
    case "$enabled" in
      enabled) exit 0 ;;
      disabled|masked) exit 1 ;;
      not-found) exit 4 ;;
      static|enabled-runtime) exit 0 ;;
      *) exit 1 ;;
    esac ;;
  'is-active aifeeds-cc-sync.timer')
    active=$(read_state "$state/timer-active" inactive)
    printf '%s\n' "$active"
    case "$active" in
      active|activating|deactivating) exit 0 ;;
      inactive)
        if [[ "\${AIFEEDS_ABSENT_IS_ACTIVE_EXIT:-3}" == 4 \
          && ! -f "$unit_dir/aifeeds-cc-sync.timer" ]]; then
          exit 4
        fi
        exit 3 ;;
      failed) exit 3 ;;
      *) exit 4 ;;
    esac ;;
  'is-active aifeeds-cc-sync.service')
    active=$(read_state "$state/service-active" inactive)
    printf '%s\n' "$active"
    case "$active" in
      active|activating|deactivating) exit 0 ;;
      inactive)
        if [[ "\${AIFEEDS_ABSENT_IS_ACTIVE_EXIT:-3}" == 4 \
          && ! -f "$unit_dir/aifeeds-cc-sync.service" ]]; then
          exit 4
        fi
        exit 3 ;;
      failed) exit 3 ;;
      *) exit 4 ;;
    esac ;;
  'disable aifeeds-cc-sync.timer')
    if [[ "\${AIFEEDS_TIMER_DISABLE_MUTATE_THEN_EXIT:-0}" != 0 ]]; then
      rm -f "$state/timer-enabled"
      exit "$AIFEEDS_TIMER_DISABLE_MUTATE_THEN_EXIT"
    fi
    [[ "\${AIFEEDS_TIMER_DISABLE_EXIT:-0}" == 0 ]] || exit "$AIFEEDS_TIMER_DISABLE_EXIT"
    rm -f "$state/timer-enabled"
    if [[ "\${AIFEEDS_KILL_AFTER_SYSTEMCTL:-}" == "$*" ]]; then
      kill -KILL "$PPID"
      exit 137
    fi
    exit 0 ;;
  'enable aifeeds-cc-sync.timer')
    printf 'enabled\n' > "$state/timer-enabled"
    if [[ "\${AIFEEDS_KILL_AFTER_SYSTEMCTL:-}" == "$*" ]]; then
      kill -KILL "$PPID"
      exit 137
    fi
    exit 0 ;;
  'enable --now aifeeds-cc-sync.timer')
    [[ "\${AIFEEDS_TIMER_ENABLE_EXIT:-0}" == 0 ]] || exit "$AIFEEDS_TIMER_ENABLE_EXIT"
    printf 'enabled\n' > "$state/timer-enabled"
    printf 'active\n' > "$state/timer-active"
    exit 0 ;;
  'stop aifeeds-cc-sync.timer')
    if [[ "\${AIFEEDS_TIMER_STOP_MUTATE_THEN_EXIT:-0}" != 0 ]]; then
      rm -f "$state/timer-active"
      exit "$AIFEEDS_TIMER_STOP_MUTATE_THEN_EXIT"
    fi
    [[ "\${AIFEEDS_TIMER_STOP_EXIT:-0}" == 0 ]] || exit "$AIFEEDS_TIMER_STOP_EXIT"
    rm -f "$state/timer-active"
    if [[ "\${AIFEEDS_KILL_AFTER_SYSTEMCTL:-}" == "$*" ]]; then
      kill -KILL "$PPID"
      exit 137
    fi
    exit 0 ;;
  'start aifeeds-cc-sync.timer')
    printf 'active\n' > "$state/timer-active"
    if [[ "\${AIFEEDS_KILL_AFTER_SYSTEMCTL:-}" == "$*" ]]; then
      kill -KILL "$PPID"
      exit 137
    fi
    exit 0 ;;
  'stop aifeeds-cc-sync.service')
    if [[ "\${AIFEEDS_SERVICE_STOP_MUTATE_THEN_EXIT:-0}" != 0 ]]; then
      rm -f "$state/service-active"
      exit "$AIFEEDS_SERVICE_STOP_MUTATE_THEN_EXIT"
    fi
    [[ "\${AIFEEDS_SERVICE_STOP_EXIT:-0}" == 0 ]] || exit "$AIFEEDS_SERVICE_STOP_EXIT"
    rm -f "$state/service-active"
    if [[ "\${AIFEEDS_KILL_AFTER_SYSTEMCTL:-}" == "$*" ]]; then
      kill -KILL "$PPID"
      exit 137
    fi
    exit 0 ;;
esac
if [[ "$*" == 'start aifeeds-cc-sync.service' ]]; then
  count_file="$state/service-start-count"
  count=0; [[ ! -f "$count_file" ]] || read -r count < "$count_file"
  count=$((count + 1)); printf '%s\n' "$count" > "$count_file"
  if [[ "$count" == 1 && -n "\${AIFEEDS_OPERATOR_MUTATE_RELATIVE_PATH:-}" ]]; then
    printf 'operator mutation\n' \
      > "$AIFEEDS_DEPLOY_ROOT/$AIFEEDS_OPERATOR_MUTATE_RELATIVE_PATH"
  fi
  if [[ "$count" == 1 && -n "\${AIFEEDS_OPERATOR_MUTATE_OPT_TARGET:-}" ]]; then
    rm -f "$AIFEEDS_DEPLOY_ROOT/opt/aifeeds-cc-sync"
    ln -s "$AIFEEDS_OPERATOR_MUTATE_OPT_TARGET" \
      "$AIFEEDS_DEPLOY_ROOT/opt/aifeeds-cc-sync"
  fi
  if [[ "$count" == 1 && "\${AIFEEDS_SERVICE_START_EXIT:-0}" != 0 ]]; then
    exit "$AIFEEDS_SERVICE_START_EXIT"
  fi
  printf 'active\n' > "$state/service-active"
  if [[ "\${AIFEEDS_KILL_AFTER_SYSTEMCTL:-}" == "$*" ]]; then
    kill -KILL "$PPID"
    exit 137
  fi
  generation='123e4567-e89b-42d3-a456-426614174000'
  state="$AIFEEDS_DEPLOY_ROOT/var/lib/aifeeds-cc-sync/public"
  mkdir -p "$state/generations/$generation/sitemaps" "$state/generations/$generation/ai-news"
  printf '<urlset/>\n' > "$state/generations/$generation/sitemaps/archive.xml"
  printf '<urlset><url><loc>https://ai-feeds.cc/ai-news/</loc></url></urlset>\n' > "$state/generations/$generation/sitemap-cn-0001.xml"
  printf '<sitemapindex><sitemap><loc>https://ai-feeds.cc/sitemap-cn-0001.xml</loc><lastmod>2026-07-21T00:00:00.000Z</lastmod></sitemap></sitemapindex>\n' > "$state/generations/$generation/sitemap-cn.xml"
  printf '<html></html>\n' > "$state/generations/$generation/ai-news/index.html"
  printf '<sitemapindex><sitemap><loc>https://ai-feeds.cc/sitemaps/%s/archive.xml</loc></sitemap></sitemapindex>\n' "$generation" > "$state/generations/$generation/sitemap.xml"
  rm -f "$state/current"
  ln -s "generations/$generation" "$state/current"
fi
`);
  await executable(path.join(fakeBin, 'nginx'), `#!/usr/bin/env bash
set -euo pipefail
printf 'nginx' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
if [[ "$*" == '-T' ]]; then printf 'user www www;\n'; exit 0; fi
if [[ "$*" == '-t' ]]; then
  count_file="$AIFEEDS_DEPLOY_ROOT/nginx-test-count"
  count=0
  [[ ! -f "$count_file" ]] || read -r count < "$count_file"
  count=$((count + 1)); printf '%s\n' "$count" > "$count_file"
  if [[ "$count" == 1 && "\${AIFEEDS_PANEL_MUTATE_AT_NGINX_TEST:-0}" == 1 ]]; then
    printf 'panel concurrent edit\n' > "$AIFEEDS_DEPLOY_ROOT/www/server/panel/vhost/nginx/html_ai-feeds.cc.conf"
    exit 1
  fi
  [[ ",\${AIFEEDS_FAIL_NGINX_TEST_AT:-0}," != *",$count,"* ]] || exit 1
  exit 0
fi
if [[ "$*" == '-s reload' ]]; then
  count_file="$AIFEEDS_DEPLOY_ROOT/nginx-reload-count"
  count=0
  [[ ! -f "$count_file" ]] || read -r count < "$count_file"
  count=$((count + 1)); printf '%s\n' "$count" > "$count_file"
  [[ ",\${AIFEEDS_FAIL_NGINX_RELOAD_AT:-0}," != *",$count,"* ]] || exit 1
fi
`);
  await executable(path.join(fakeBin, 'curl'), `#!/usr/bin/env bash
set -euo pipefail
printf 'curl' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
output=''
write_out=''
url=''
while (($#)); do
  case "$1" in
    --output) output=$2; shift 2 ;;
    --write-out) write_out=$2; shift 2 ;;
    --resolve|--max-time|--noproxy) shift 2 ;;
    --silent|--show-error) shift ;;
    https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
status=\${AIFEEDS_CURL_STATUS:-200}
state="$AIFEEDS_DEPLOY_ROOT/var/lib/aifeeds-cc-sync/public"
case "$url" in
  https://ai-feeds.cc/sitemap.xml)
    source="$state/current/sitemap.xml" ;;
  https://ai-feeds.cc/sitemap-cn.xml)
    source="$state/current/sitemap-cn.xml" ;;
  https://ai-feeds.cc/sitemap-cn-[0-9][0-9][0-9][0-9].xml)
    relative=\${url#https://ai-feeds.cc/}
    source="$state/current/$relative" ;;
  https://ai-feeds.cc/sitemaps/*)
    relative=\${url#https://ai-feeds.cc/sitemaps/}
    generation=\${relative%%/*}
    sitemap=\${relative#*/}
    source="$state/generations/$generation/sitemaps/$sitemap" ;;
  https://ai-feeds.cc/ai-news/)
    source="$state/current/ai-news/index.html" ;;
  *)
    printf 'unexpected curl URL: %s\n' "$url" >&2
    exit 64 ;;
esac
if [[ -n "$output" && "$output" != /dev/null ]]; then
  stale_file="$AIFEEDS_DEPLOY_ROOT/curl-stale-response-served"
  if [[ "\${AIFEEDS_CURL_STALE_ONCE_URL:-}" == "$url" && ! -f "$stale_file" ]]; then
    printf 'served\n' > "$stale_file"
    printf 'stale response\n' > "$output"
  elif [[ "\${AIFEEDS_CURL_CORRUPT_URL:-}" == "$url" ]]; then
    printf 'corrupt response\n' > "$output"
  else
    cp "$source" "$output"
  fi
fi
if [[ -n "$write_out" ]]; then
  [[ "$write_out" == '%{http_code}' ]] || exit 64
  printf '%s' "$status"
fi
exit "\${AIFEEDS_CURL_EXIT:-0}"
`);
  await executable(path.join(fakeBin, 'flock'), `#!/usr/bin/env bash
set -euo pipefail
printf 'flock' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)'
`);

  return {
    env: {
      AIFEEDS_DEPLOY_TEST_MODE: '1',
      AIFEEDS_DEPLOY_ROOT: root,
      AIFEEDS_HARNESS_LOG: log,
      AIFEEDS_HARNESS_CHILD_PATH: process.env.PATH,
      AIFEEDS_HARNESS_CHILD_TMPDIR: os.tmpdir(),
      AIFEEDS_REAL_NODE: process.execPath,
      AIFEEDS_PAYLOAD_TEST_PROOF: payloadTestProof,
      AIFEEDS_INSTALL: path.join(fakeBin, 'install'),
      AIFEEDS_CHOWN: path.join(fakeBin, 'chown'),
      AIFEEDS_USERADD: path.join(fakeBin, 'useradd'),
      AIFEEDS_USERDEL: path.join(fakeBin, 'userdel'),
      AIFEEDS_GETENT: path.join(fakeBin, 'getent'),
      AIFEEDS_RUNUSER: path.join(fakeBin, 'runuser'),
      AIFEEDS_NODE_BIN: path.join(fakeBin, 'node'),
      AIFEEDS_SYSTEMCTL: path.join(fakeBin, 'systemctl'),
      AIFEEDS_NGINX: path.join(fakeBin, 'nginx'),
      AIFEEDS_CURL: path.join(fakeBin, 'curl'),
      AIFEEDS_FLOCK: path.join(fakeBin, 'flock'),
      AIFEEDS_PYTHON_BIN: python,
      AIFEEDS_ROOT_GID: String(process.getgid()),
      AIFEEDS_ROOT_UID: String(process.getuid()),
    },
    log,
    manifestDigest,
    oldReleaseId,
    payloadTestProof,
    python,
    pythonBin,
    pythonTarget,
    root,
    siteRoot,
    snippet,
    stage,
    stagedEnv,
    systemctlState,
    vhost,
  };
}

remoteHarnessTest('Python chain and filesystem capability preflight precede user creation', async (t) => {
  await t.test('Debian-style relative python symlink and supported probe continue', async () => {
    const harness = await remoteDeployHarness();
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      { ...harness.env, AIFEEDS_FAST_PAYLOAD_TESTS: '1' },
    );
    assert.equal(result.status, 0, result.stderr);
  });

  for (const scenario of [
    {
      name: 'world-writable chain',
      async mutate(harness) {
        await chmod(harness.pythonBin, 0o777);
      },
    },
    {
      name: 'unexpected chain owner',
      async mutate(harness) {
        harness.env.AIFEEDS_ROOT_UID = String(process.getuid() + 1);
      },
    },
    {
      name: 'symlink loop',
      async mutate(harness) {
        await unlink(harness.pythonTarget);
        await symlink('python3', harness.pythonTarget);
      },
    },
    {
      name: 'trusted-root escape',
      async mutate(harness) {
        const escaped = path.join(harness.root, 'tmp', 'python3.11');
        await executable(escaped, '#!/usr/bin/env bash\nexit 0\n');
        await unlink(harness.python);
        await symlink('../../tmp/python3.11', harness.python);
      },
    },
    {
      name: 'final target is not regular',
      async mutate(harness) {
        await unlink(harness.pythonTarget);
        await mkdir(harness.pythonTarget);
      },
    },
    {
      name: 'rename no-replace unsupported',
      async mutate(harness) {
        harness.env.AIFEEDS_LINUX_FS_TEST_MODE = '1';
        harness.env.AIFEEDS_LINUX_FS_FORCE_UNSUPPORTED = '1';
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const harness = await remoteDeployHarness();
      await scenario.mutate(harness);
      const result = runBash(
        path.join(SYNC_DIR, 'install-remote.sh'),
        [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
        { ...harness.env, AIFEEDS_FAST_PAYLOAD_TESTS: '1' },
      );
      assert.notEqual(result.status, 0);
      const log = await readFile(harness.log, 'utf8');
      assert.doesNotMatch(log, /useradd/);
      await assert.rejects(lstat(path.join(harness.root, 'user-created')), /ENOENT/);
      await assert.rejects(lstat(path.join(
        harness.root,
        'var',
        'lib',
        'aifeeds-cc-deploy-snapshots',
      )), /ENOENT/);
      assert.deepEqual(
        (await readdir(path.join(harness.root, 'run')))
          .filter((name) => name.startsWith('.aifeeds-cc-fs-probe.')),
        [],
      );
      await assert.rejects(lstat(path.join(
        harness.root,
        'run',
        'aifeeds-cc-sync-deploy',
      )), /ENOENT/);
    });
  }
});

remoteHarnessTest('snapshot parent is private and existing var tmp mode is preserved', async (t) => {
  await t.test('successful deployment leaves var tmp at 01777', async () => {
    const harness = await remoteDeployHarness();
    const varTmp = path.join(harness.root, 'var', 'tmp');
    await mkdir(varTmp, { recursive: true, mode: 0o1777 });
    await chmod(varTmp, 0o1777);

    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal((await lstat(varTmp)).mode & 0o7777, 0o1777);
    const snapshotParent = path.join(
      harness.root,
      'var',
      'lib',
      'aifeeds-cc-deploy-snapshots',
    );
    const identity = await lstat(snapshotParent);
    assert.equal(identity.isDirectory(), true);
    assert.equal(identity.isSymbolicLink(), false);
    assert.equal(identity.mode & 0o7777, 0o700);
    assert.deepEqual(await readdir(snapshotParent), []);
  });

  for (const fixture of ['symlink', 'wrong-mode']) {
    await t.test(`rejects an existing snapshot parent ${fixture}`, async () => {
      const harness = await remoteDeployHarness();
      const snapshotParent = path.join(
        harness.root,
        'var',
        'lib',
        'aifeeds-cc-deploy-snapshots',
      );
      if (fixture === 'symlink') {
        const outside = path.join(harness.root, 'operator-snapshot-parent');
        await mkdir(outside, { mode: 0o700 });
        await symlink(outside, snapshotParent);
      } else {
        await mkdir(snapshotParent, { mode: 0o755 });
        await chmod(snapshotParent, 0o755);
      }

      const result = runBash(
        path.join(SYNC_DIR, 'install-remote.sh'),
        [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
        {
          ...harness.env,
          AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        },
      );

      assert.notEqual(result.status, 0);
      await assert.rejects(lstat(path.join(harness.root, 'user-created')), /ENOENT/);
      if (fixture === 'symlink') {
        assert.equal((await lstat(snapshotParent)).isSymbolicLink(), true);
      } else {
        assert.equal((await lstat(snapshotParent)).mode & 0o7777, 0o755);
      }
    });
  }
});

test('immutable releases are cryptographically bound to their manifest', async (t) => {
  const { verifyBoundRelease } = await import('../deployment-security.mjs');

  async function fixture(releaseId = null) {
    const harness = await remoteDeployHarness();
    const id = releaseId ?? harness.manifestDigest;
    const release = path.join(
      harness.root,
      'opt',
      'aifeeds-cc-sync-releases',
      id,
    );
    await mkdir(release, { recursive: true });
    await cp(path.join(harness.stage, 'cc-site'), path.join(release, 'cc-site'), {
      recursive: true,
    });
    await copyFile(
      path.join(harness.stage, 'MANIFEST.sha256'),
      path.join(release, 'MANIFEST.sha256'),
    );
    await normalizeReleaseFixture(release);
    return { harness, release };
  }

  const verify = ({ harness, release }) => verifyBoundRelease({
    allowedGid: process.getgid(),
    allowedUid: process.getuid(),
    expectedManifestDigest: harness.manifestDigest,
    release,
    requireReleaseId: true,
  });

  await t.test('normal prior release passes', async () => {
    const bound = await fixture();
    await verify(bound);
    const manifest = await readFile(
      path.join(bound.release, 'MANIFEST.sha256'),
      'utf8',
    );
    assert.match(manifest, /^[0-9a-f]{64}  deploy\/cc-sync\.env$/m);
    await assert.rejects(stat(path.join(bound.release, 'deploy')), /ENOENT/);
  });

  await t.test('release content tampering is rejected', async () => {
    const bound = await fixture();
    await writeFile(
      path.join(bound.release, 'cc-site', 'sync', 'sync.mjs'),
      'tampered release code\n',
    );
    await assert.rejects(verify(bound), /release digest mismatch|damaged/i);
  });

  await t.test('manifest byte tampering is rejected', async () => {
    const bound = await fixture();
    const manifest = path.join(bound.release, 'MANIFEST.sha256');
    await writeFile(manifest, `${await readFile(manifest, 'utf8')}\n`);
    await assert.rejects(verify(bound), /manifest digest mismatch|release id/i);
  });

  await t.test('release directory id must equal the manifest digest', async () => {
    const bound = await fixture('2'.repeat(64));
    await assert.rejects(verify(bound), /release id|manifest digest/i);
  });

  await t.test('the bound payload path list cannot be edited independently', async () => {
    const bound = await fixture();
    const allowlist = path.join(
      bound.release,
      'cc-site',
      'sync',
      'payload-files.txt',
    );
    await writeFile(
      allowlist,
      `${await readFile(allowlist, 'utf8')}cc-site/unlisted.html\n`,
    );
    await assert.rejects(verify(bound), /release digest mismatch|allowlist/i);
  });
});

remoteHarnessTest('remote installer gates activation on tests, service output readability and Nginx', async () => {
  const harness = await remoteDeployHarness();
  const installer = path.join(SYNC_DIR, 'install-remote.sh');
  const result = runBash(
    installer,
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    harness.env,
  );
  const commandLog = await readFile(harness.log, 'utf8');
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `${output}\n${commandLog}`);
  assert.equal((await stat(harness.payloadTestProof)).isFile(), true);
  const liveCode = path.join(harness.root, 'opt', 'aifeeds-cc-sync');
  const liveTarget = await readlink(liveCode);
  assert.match(liveTarget, /aifeeds-cc-sync-releases\/[0-9a-f]{64}\/cc-site\/sync$/);
  assert.equal(
    (await stat(path.join(harness.root, 'opt', liveTarget, 'test', 'fixtures', 'publish-and-pause.mjs'))).isFile(),
    true,
  );

  const position = (needle) => {
    const index = commandLog.indexOf(needle);
    assert.notEqual(index, -1, `missing command ${needle}\n${commandLog}`);
    return index;
  };
  assert.ok(position('node <--test>') < position('systemctl <start> <aifeeds-cc-sync.service>'));
  assert.ok(position('systemctl <start> <aifeeds-cc-sync.service>') < position('runuser <-u> <www>'));
  assert.ok(position('runuser <-u> <www>') < position('nginx <-t>'));
  assert.ok(position('nginx <-t>') < position('nginx <-s> <reload>'));
  assert.ok(position('nginx <-s> <reload>') < position('curl'));
  assert.ok(position('curl') < position('systemctl <enable> <--now> <aifeeds-cc-sync.timer>'));
  const curlLines = commandLog.split('\n').filter((line) => line.startsWith('curl'));
  assert.equal(curlLines.length, 5, commandLog);
  for (const line of curlLines) {
    assert.match(line, /<--resolve> <ai-feeds\.cc:443:127\.0\.0\.1>/);
    assert.match(line, /<--write-out> <%\{http_code\}>/);
  }
  assert.equal(
    curlLines.some((line) => line.includes('<https://ai-feeds.cc/sitemap.xml>')),
    true,
  );
  assert.equal(
    curlLines.some((line) => line.includes('<https://ai-feeds.cc/sitemap-cn.xml>')),
    true,
  );
  assert.equal(
    curlLines.some((line) => line.includes('<https://ai-feeds.cc/sitemap-cn-0001.xml>')),
    true,
  );
  assert.equal(
    curlLines.some((line) => line.includes(
      '<https://ai-feeds.cc/sitemaps/123e4567-e89b-42d3-a456-426614174000/archive.xml>',
    )),
    true,
  );
  assert.equal(
    curlLines.some((line) => line.includes('<https://ai-feeds.cc/ai-news/>')),
    true,
  );
  assert.match(
    commandLog,
    /deployment-security\.mjs> <gc-releases> <[^>]+\/aifeeds-cc-sync-releases> <[^>]+\/aifeeds-cc-sync> <3> <[0-9]+>/,
  );
  assert.match(commandLog, /current\/sitemaps\/archive\.xml/);
  assert.match(commandLog, /current\/sitemap-cn\.xml/);
  assert.match(commandLog, /current\/sitemap-cn-0001\.xml/);
  assert.match(
    commandLog,
    /generations\/123e4567-e89b-42d3-a456-426614174000\/sitemaps\/archive\.xml/,
  );

  const vhost = await readFile(harness.vhost, 'utf8');
  assert.match(vhost, /AIFEEDS-CC-CONTENT-MIRROR-BEGIN/);
  assert.match(vhost, /shenma-site-verification/);
  assert.match(vhost, /location \^~ \/auth\/wechat\//);
  assert.ok(
    vhost.indexOf('AIFEEDS-CC-CONTENT-MIRROR-BEGIN')
      < vhost.indexOf('location ^~ /auth/wechat/'),
  );
  assert.equal((await stat(path.join(harness.root, 'var/lib/aifeeds-cc-sync'))).mode & 0o777, 0o750);
  assert.equal((await stat(path.join(harness.siteRoot, 'i'))).mode & 0o777, 0o750);
  assert.equal((await stat(path.join(harness.root, 'etc/aifeeds/cc-sync.env'))).mode & 0o777, 0o600);
  assert.equal(output.includes('c'.repeat(64)), false);
});

remoteHarnessTest('first install accepts systemd 255 exit 4 for absent inactive units', async () => {
  const harness = await remoteDeployHarness();
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_ABSENT_IS_ACTIVE_EXIT: '4',
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
    },
  );
  const commandLog = await readFile(harness.log, 'utf8');

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${commandLog}`);
  assert.match(
    commandLog,
    /systemctl <show> <--property=LoadState> <--value> <aifeeds-cc-sync\.service>/,
  );
  assert.match(commandLog, /systemctl <is-active> <aifeeds-cc-sync\.service>/);
  assert.equal(
    await readFile(path.join(harness.systemctlState, 'timer-enabled'), 'utf8'),
    'enabled\n',
  );
});

remoteHarnessTest('payload tests run outside the root-private rollback snapshot', async () => {
  const harness = await remoteDeployHarness();
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_ENFORCE_RUNUSER_TRAVERSAL: '1',
      AIFEEDS_ENFORCE_RUNUSER_CLEAN_ENV: '1',
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
    },
  );
  const commandLog = await readFile(harness.log, 'utf8');

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${commandLog}`);
  const runuserLine = commandLog.split('\n').find((line) => line.startsWith('runuser'));
  assert.ok(runuserLine, commandLog);
  assert.match(runuserLine, /<env> <-i>/);
  assert.doesNotMatch(runuserLine, /aifeeds-cc-deploy-snapshots/);
  assert.match(runuserLine, /aifeeds-cc-sync-releases/);
});

remoteHarnessTest('deployment lock refuses prepositioned links and non-regular files without touching shared paths', async (t) => {
  for (const kind of ['symlink', 'directory']) {
    await t.test(kind, async () => {
      const harness = await remoteDeployHarness();
      const run = path.join(harness.root, 'run');
      const sharedLock = path.join(run, 'lock');
      const privateLock = path.join(run, 'aifeeds-cc-sync-deploy');
      const lockFile = path.join(privateLock, 'deployment.lock');
      await mkdir(sharedLock, { recursive: true, mode: 0o755 });
      await chmod(sharedLock, 0o755);
      await mkdir(privateLock, { mode: 0o700 });
      const outside = path.join(harness.root, 'outside-lock-target');
      await writeFile(outside, 'do-not-truncate\n', { mode: 0o600 });
      if (kind === 'symlink') {
        await symlink(outside, lockFile);
      } else {
        await mkdir(lockFile);
      }
      const sharedMode = (await stat(sharedLock)).mode & 0o777;

      const result = runBash(
        path.join(SYNC_DIR, 'install-remote.sh'),
        [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
        {
          ...harness.env,
          AIFEEDS_FAST_PAYLOAD_TESTS: '1',
          AIFEEDS_NODE_TEST_EXIT: '44',
        },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /deployment lock.*regular|lock.*unsafe/i);
      assert.equal(await readFile(outside, 'utf8'), 'do-not-truncate\n');
      assert.equal((await stat(sharedLock)).mode & 0o777, sharedMode);
      assert.doesNotMatch(await readFile(harness.log, 'utf8'), /node <--test>/);
      await assert.rejects(
        stat(path.join(harness.root, 'var', 'lock', 'aifeeds-cc-sync-deploy.lock')),
        /ENOENT/,
      );
    });
  }
});

remoteHarnessTest('remote installer holds a nonblocking deployment lock without changing live state', async () => {
  const harness = await remoteDeployHarness();
  const installer = path.join(SYNC_DIR, 'install-remote.sh');
  const gate = path.join(harness.root, 'pause-payload-tests');
  const ready = path.join(harness.root, 'payload-tests-paused');
  await writeFile(gate, 'hold');
  const first = runBashAsync(
    installer,
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_NODE_TEST_EXIT: '44',
      AIFEEDS_PAUSE_GATE: gate,
      AIFEEDS_PAUSE_PAYLOAD_TESTS: '1',
      AIFEEDS_PAUSE_READY: ready,
    },
  );
  await waitForPath(ready);

  const second = runBash(
    installer,
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    { ...harness.env, AIFEEDS_NODE_TEST_EXIT: '45' },
  );
  assert.equal(second.status, 75, second.stderr);
  assert.match(second.stderr, /deployment is in progress/);
  await assert.rejects(
    stat(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
    /ENOENT/,
  );

  await unlink(gate);
  const [firstExit] = await Promise.all([
    new Promise((resolve, reject) => {
      first.once('error', reject);
      first.once('exit', resolve);
    }),
    new Promise((resolve) => first.stdout.resume().once('end', resolve)),
    new Promise((resolve) => first.stderr.resume().once('end', resolve)),
  ]);
  assert.equal(firstExit, 44);
});

remoteHarnessTest('remote installer replaces an incomplete non-live release left by a killed legacy install', async () => {
  const harness = await remoteDeployHarness();
  const releases = path.join(harness.root, 'opt', 'aifeeds-cc-sync-releases');
  const incomplete = path.join(releases, harness.manifestDigest);
  const staleStage = path.join(
    releases,
    `.stage.${harness.manifestDigest}.123e4567-e89b-42d3-a456-426614174000`,
  );
  await mkdir(path.join(incomplete, 'cc-site', 'sync'), { recursive: true });
  await writeFile(path.join(incomplete, 'cc-site', 'sync', 'partial.mjs'), 'partial\n');
  await mkdir(staleStage);
  await writeFile(path.join(staleStage, 'partial'), 'stale\n');

  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    { ...harness.env, AIFEEDS_FAST_PAYLOAD_TESTS: '1' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
    `aifeeds-cc-sync-releases/${harness.manifestDigest}/cc-site/sync`,
  );
  assert.equal(
    (await stat(path.join(incomplete, 'cc-site', 'sync', 'sync.mjs'))).isFile(),
    true,
  );
  await assert.rejects(stat(path.join(incomplete, 'cc-site', 'sync', 'partial.mjs')), /ENOENT/);
  await assert.rejects(stat(staleStage), /ENOENT/);
});

remoteHarnessTest('redeploying the same verified manifest safely reuses its immutable release', async () => {
  const harness = await remoteDeployHarness();
  const installer = path.join(SYNC_DIR, 'install-remote.sh');
  const args = [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest];
  const first = runBash(installer, args, {
    ...harness.env,
    AIFEEDS_FAST_PAYLOAD_TESTS: '1',
  });
  assert.equal(first.status, 0, first.stderr);
  const release = path.join(
    harness.root,
    'opt',
    'aifeeds-cc-sync-releases',
    harness.manifestDigest,
  );
  const releaseIdentity = await stat(release);

  await buildPayload({
    envFile: harness.stagedEnv,
    payload: harness.stage,
    repoRoot: path.resolve(SYNC_DIR, '..', '..'),
  });
  const second = runBash(installer, args, {
    ...harness.env,
    AIFEEDS_FAST_PAYLOAD_TESTS: '1',
  });

  assert.equal(second.status, 0, second.stderr);
  assert.equal((await stat(release)).ino, releaseIdentity.ino);
  assert.equal(
    await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
    `aifeeds-cc-sync-releases/${harness.manifestDigest}/cc-site/sync`,
  );
});

remoteHarnessTest('global commit makes local transaction finalization retryable housekeeping', async (t) => {
  for (const failAt of [2, 3, 4]) {
    await t.test(`finalize ${failAt} failure is recovered by the next deployment`, async () => {
      const harness = await remoteDeployHarness();
      const installer = path.join(SYNC_DIR, 'install-remote.sh');
      const args = [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest];
      const journal = path.join(
        harness.root,
        'opt',
        'aifeeds-cc-sync-releases',
        '.deployment-committed.json',
      );
      const transactions = [
        path.join(
          harness.root,
          'opt',
          `.aifeeds-deploy.${harness.manifestDigest}.opt`,
        ),
        path.join(
          harness.root,
          'etc',
          'systemd',
          'system',
          `.aifeeds-deploy.${harness.manifestDigest}.service`,
        ),
        path.join(
          harness.root,
          'etc',
          'systemd',
          'system',
          `.aifeeds-deploy.${harness.manifestDigest}.timer`,
        ),
        path.join(
          harness.root,
          'etc',
          'aifeeds',
          `.aifeeds-deploy.${harness.manifestDigest}.env`,
        ),
      ];

      const first = runBash(installer, args, {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        AIFEEDS_FINALIZE_FAIL_AT: String(failAt),
      });
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stderr, /WARNING:.*finaliz/i);
      assert.equal((await stat(journal)).mode & 0o777, 0o600);
      assert.equal(
        await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
        `aifeeds-cc-sync-releases/${harness.manifestDigest}/cc-site/sync`,
      );
      assert.equal(
        await readFile(path.join(harness.systemctlState, 'timer-active'), 'utf8'),
        'active\n',
      );
      assert.equal(
        await readFile(path.join(harness.systemctlState, 'timer-enabled'), 'utf8'),
        'enabled\n',
      );
      assert.equal((await stat(transactions[failAt - 1])).isDirectory(), true);

      await buildPayload({
        envFile: harness.stagedEnv,
        payload: harness.stage,
        repoRoot: path.resolve(SYNC_DIR, '..', '..'),
      });
      const second = runBash(installer, args, {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      });
      assert.equal(second.status, 0, second.stderr);
      await assert.rejects(stat(journal), /ENOENT/);
      for (const transactionDirectory of transactions) {
        await assert.rejects(stat(transactionDirectory), /ENOENT/);
      }
    });
  }
});

remoteHarnessTest('global journal failure remains before the rollback boundary', async () => {
  const harness = await remoteDeployHarness({
    priorDeployment: true,
    serviceState: 'active',
    timerEnabledState: 'enabled',
    timerState: 'active',
  });
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      AIFEEDS_GLOBAL_COMMIT_EXIT: '61',
    },
  );

  assert.equal(result.status, 61, result.stderr);
  assert.equal(
    await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
    `aifeeds-cc-sync-releases/${harness.oldReleaseId}/cc-site/sync`,
  );
  assert.equal(
    await readFile(path.join(harness.root, 'etc', 'aifeeds', 'cc-sync.env'), 'utf8'),
    'OLD_ENV=1\n',
  );
  assert.equal(
    await readFile(
      path.join(harness.root, 'etc', 'systemd', 'system', 'aifeeds-cc-sync.service'),
      'utf8',
    ),
    'OLD_SERVICE\n',
  );
  assert.equal(
    await readFile(
      path.join(harness.root, 'etc', 'systemd', 'system', 'aifeeds-cc-sync.timer'),
      'utf8',
    ),
    'OLD_TIMER\n',
  );
  assert.equal(
    await readFile(path.join(harness.systemctlState, 'service-active'), 'utf8'),
    'active\n',
  );
  assert.equal(
    await readFile(path.join(harness.systemctlState, 'timer-active'), 'utf8'),
    'active\n',
  );
  assert.equal(
    await readFile(path.join(harness.systemctlState, 'timer-enabled'), 'utf8'),
    'enabled\n',
  );
  await assert.rejects(stat(path.join(
    harness.root,
    'opt',
    'aifeeds-cc-sync-releases',
    '.deployment-committed.json',
  )), /ENOENT/);
});

remoteHarnessTest('foreign committed marker cannot create a false commit boundary', async () => {
  const harness = await remoteDeployHarness({
    priorDeployment: true,
    serviceState: 'active',
    timerEnabledState: 'enabled',
    timerState: 'active',
  });
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_CREATE_FOREIGN_COMMITTED_BEFORE_COMMIT: '1',
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
    },
  );
  assert.notEqual(result.status, 0);
  const releases = path.join(
    harness.root,
    'opt',
    'aifeeds-cc-sync-releases',
  );
  const committedJournal = path.join(releases, '.deployment-committed.json');
  const preparingJournal = path.join(releases, '.deployment-preparing.json');
  assert.match(await readFile(committedJournal, 'utf8'), /"manifest":"f{64}"/);
  const preparing = JSON.parse(await readFile(preparingJournal, 'utf8'));
  assert.equal(preparing.manifest, harness.manifestDigest);
  const snapshot = path.dirname(path.dirname(preparing.nginx_transaction));
  assert.equal((await stat(snapshot)).isDirectory(), true);
  assert.match(result.stderr, /committed|marker|mismatch|already exists|rollback/i);
});

remoteHarnessTest('global journal and local receipts must remain mutually consistent', async (t) => {
  for (const mutation of ['receipt', 'marker']) {
    await t.test(`${mutation} mutation fails closed`, async () => {
      const harness = await remoteDeployHarness();
      const installer = path.join(SYNC_DIR, 'install-remote.sh');
      const args = [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest];
      const journal = path.join(
        harness.root,
        'opt',
        'aifeeds-cc-sync-releases',
        '.deployment-committed.json',
      );
      const serviceTransaction = path.join(
        harness.root,
        'etc',
        'systemd',
        'system',
        `.aifeeds-deploy.${harness.manifestDigest}.service`,
      );
      const receipt = path.join(serviceTransaction, 'receipt.jsonl');
      const first = runBash(installer, args, {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        AIFEEDS_FINALIZE_FAIL_AT: '2',
      });
      assert.equal(first.status, 0, first.stderr);

      if (mutation === 'receipt') {
        await writeFile(receipt, `${await readFile(receipt, 'utf8')}\n`);
      } else {
        const marker = JSON.parse(await readFile(journal, 'utf8'));
        marker.transactions[1].receipt_digest = '0'.repeat(64);
        await writeFile(journal, `${JSON.stringify(marker)}\n`);
      }
      await buildPayload({
        envFile: harness.stagedEnv,
        payload: harness.stage,
        repoRoot: path.resolve(SYNC_DIR, '..', '..'),
      });
      const second = runBash(installer, args, {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      });

      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /global deployment marker and receipt mismatch/i);
      assert.equal((await stat(journal)).isFile(), true);
      assert.equal((await stat(serviceTransaction)).isDirectory(), true);
      assert.equal(
        await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
        `aifeeds-cc-sync-releases/${harness.manifestDigest}/cc-site/sync`,
      );
    });
  }
});

remoteHarnessTest('preparing journal rolls every pre-commit crash back before redeploy', async (t) => {
  const scenarios = [
    { env: { AIFEEDS_KILL_AFTER_PATH_PUBLISH: '1' }, name: 'path 1' },
    { env: { AIFEEDS_KILL_AFTER_PATH_PUBLISH: '2' }, name: 'path 2' },
    { env: { AIFEEDS_KILL_AFTER_PATH_PUBLISH: '3' }, name: 'path 3' },
    { env: { AIFEEDS_KILL_AFTER_PATH_PUBLISH: '4' }, name: 'path 4' },
    { env: { AIFEEDS_KILL_BEFORE_GLOBAL_COMMIT: '1' }, name: 'post-health' },
  ];

  for (const scenario of scenarios) {
    await t.test(`${scenario.name} crash restores the prior deployment`, async () => {
      const harness = await remoteDeployHarness({
        priorDeployment: true,
        serviceState: 'active',
        timerEnabledState: 'enabled',
        timerState: 'active',
      });
      const installer = path.join(SYNC_DIR, 'install-remote.sh');
      const args = [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest];
      const preparingJournal = path.join(
        harness.root,
        'opt',
        'aifeeds-cc-sync-releases',
        '.deployment-preparing.json',
      );

      const killed = runBash(installer, args, {
        ...harness.env,
        ...scenario.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      });
      assert.equal(
        killed.signal === 'SIGKILL' || killed.status === 137,
        true,
        killed.stderr,
      );
      const interruptedMarker = JSON.parse(
        await readFile(preparingJournal, 'utf8'),
      );
      assert.equal(interruptedMarker.phase, 'preparing');
      const interruptedSnapshot = path.dirname(
        path.dirname(interruptedMarker.nginx_transaction),
      );

      await rm(harness.stage, { force: true, recursive: true });
      await buildPayload({
        envFile: harness.stagedEnv,
        payload: harness.stage,
        repoRoot: path.resolve(SYNC_DIR, '..', '..'),
      });
      const recovered = runBash(installer, args, {
        ...harness.env,
        AIFEEDS_EXIT_AFTER_PREPARING_RECOVERY: '66',
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      });
      assert.equal(recovered.status, 66, recovered.stderr);
      assert.equal(
        await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
        `aifeeds-cc-sync-releases/${harness.oldReleaseId}/cc-site/sync`,
      );
      assert.equal(
        await readFile(path.join(harness.root, 'etc', 'aifeeds', 'cc-sync.env'), 'utf8'),
        'OLD_ENV=1\n',
      );
      assert.equal(
        await readFile(
          path.join(
            harness.root,
            'etc',
            'systemd',
            'system',
            'aifeeds-cc-sync.service',
          ),
          'utf8',
        ),
        'OLD_SERVICE\n',
      );
      assert.equal(
        await readFile(
          path.join(
            harness.root,
            'etc',
            'systemd',
            'system',
            'aifeeds-cc-sync.timer',
          ),
          'utf8',
        ),
        'OLD_TIMER\n',
      );
      assert.equal(
        await readFile(path.join(harness.systemctlState, 'service-active'), 'utf8'),
        'active\n',
      );
      assert.equal(
        await readFile(path.join(harness.systemctlState, 'timer-active'), 'utf8'),
        'active\n',
      );
      assert.equal(
        await readFile(path.join(harness.systemctlState, 'timer-enabled'), 'utf8'),
        'enabled\n',
      );
      assert.equal(await readFile(harness.vhost, 'utf8'), VHOST_FIXTURE);
      await assert.rejects(lstat(harness.snippet), /ENOENT/);
      await assert.rejects(lstat(preparingJournal), /ENOENT/);
      await assert.rejects(lstat(interruptedSnapshot), /ENOENT/);

      await buildPayload({
        envFile: harness.stagedEnv,
        payload: harness.stage,
        repoRoot: path.resolve(SYNC_DIR, '..', '..'),
      });
      const redeployed = runBash(installer, args, {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      });
      assert.equal(redeployed.status, 0, redeployed.stderr);
      assert.equal(
        await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
        `aifeeds-cc-sync-releases/${harness.manifestDigest}/cc-site/sync`,
      );
    });
  }
});

remoteHarnessTest('preparing recovery quiesces candidate units before any live rollback', async () => {
  const harness = await remoteDeployHarness({
    priorDeployment: true,
    serviceState: 'active',
    timerEnabledState: 'enabled',
    timerState: 'active',
  });
  const installer = path.join(SYNC_DIR, 'install-remote.sh');
  const args = [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest];
  const killed = runBash(installer, args, {
    ...harness.env,
    AIFEEDS_FAST_PAYLOAD_TESTS: '1',
    AIFEEDS_KILL_BEFORE_GLOBAL_COMMIT: '1',
  });
  assert.equal(killed.signal === 'SIGKILL' || killed.status === 137, true, killed.stderr);

  await rm(harness.stage, { force: true, recursive: true });
  await buildPayload({
    envFile: harness.stagedEnv,
    payload: harness.stage,
    repoRoot: path.resolve(SYNC_DIR, '..', '..'),
  });
  const recovered = runBash(installer, args, {
    ...harness.env,
    AIFEEDS_ASSERT_CANDIDATE_STOPPED_BEFORE_ROLLBACK: '1',
    AIFEEDS_EXIT_AFTER_PREPARING_RECOVERY: '66',
    AIFEEDS_FAST_PAYLOAD_TESTS: '1',
  });
  assert.equal(recovered.status, 66, recovered.stderr);
  await assert.rejects(
    stat(path.join(harness.root, 'rollback-while-candidate-active')),
    /ENOENT/,
  );

  const commandLog = await readFile(harness.log, 'utf8');
  const position = (needle) => {
    const index = commandLog.lastIndexOf(needle);
    assert.notEqual(index, -1, `missing command ${needle}\n${commandLog}`);
    return index;
  };
  const quiescedAt = Math.max(
    position('systemctl <stop> <aifeeds-cc-sync.timer>'),
    position('systemctl <disable> <aifeeds-cc-sync.timer>'),
    position('systemctl <stop> <aifeeds-cc-sync.service>'),
  );
  const firstRollbackAt = Math.min(
    position('nginx-config-transaction.mjs> <rollback>'),
    position('deployment-file-transaction.mjs> <rollback-preparing>'),
  );
  assert.ok(quiescedAt < firstRollbackAt, commandLog);
});

remoteHarnessTest('ambiguous recovery systemd effects are durably fail-closed', async (t) => {
  const scenarios = [
    {
      command: 'stop aifeeds-cc-sync.timer',
      step: 'candidate_timer_stop',
    },
    {
      command: 'disable aifeeds-cc-sync.timer',
      step: 'candidate_timer_disable',
    },
    {
      command: 'start aifeeds-cc-sync.service',
      step: 'restore_service',
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.step, async () => {
      const harness = await remoteDeployHarness({
        priorDeployment: true,
        serviceState: 'active',
        timerEnabledState: 'enabled',
        timerState: 'active',
      });
      const installer = path.join(SYNC_DIR, 'install-remote.sh');
      const args = [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest];
      const preparingJournal = path.join(
        harness.root,
        'opt',
        'aifeeds-cc-sync-releases',
        '.deployment-preparing.json',
      );
      const first = runBash(installer, args, {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        AIFEEDS_KILL_BEFORE_GLOBAL_COMMIT: '1',
      });
      assert.equal(first.signal === 'SIGKILL' || first.status === 137, true, first.stderr);

      await rm(harness.stage, { force: true, recursive: true });
      await buildPayload({
        envFile: harness.stagedEnv,
        payload: harness.stage,
        repoRoot: path.resolve(SYNC_DIR, '..', '..'),
      });
      const second = runBash(installer, args, {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        AIFEEDS_KILL_AFTER_SYSTEMCTL: scenario.command,
      });
      assert.equal(second.signal === 'SIGKILL' || second.status === 137, true, second.stderr);
      const marker = JSON.parse(await readFile(preparingJournal, 'utf8'));
      assert.equal(marker.recovery?.[scenario.step], 'attempted');

      const logBeforeRetry = await readFile(harness.log, 'utf8');
      const third = runBash(installer, args, {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      });
      assert.notEqual(third.status, 0);
      assert.match(third.stderr, new RegExp(`ambiguous.*${scenario.step}`, 'i'));
      const retryLog = (await readFile(harness.log, 'utf8')).slice(logBeforeRetry.length);
      assert.doesNotMatch(
        retryLog,
        /systemctl <(stop|start|disable|enable)(?:> <--now)?>(?: <[^>]+>)?/,
      );
      assert.equal((await stat(preparingJournal)).isFile(), true);
    });
  }
});

remoteHarnessTest('orphan receipts without a global journal are not finalized', async () => {
  const harness = await remoteDeployHarness({
    priorDeployment: true,
    serviceState: 'active',
    timerEnabledState: 'enabled',
    timerState: 'active',
  });
  const installer = path.join(SYNC_DIR, 'install-remote.sh');
  const args = [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest];
  const preparingJournal = path.join(
    harness.root,
    'opt',
    'aifeeds-cc-sync-releases',
    '.deployment-preparing.json',
  );
  const first = runBash(installer, args, {
    ...harness.env,
    AIFEEDS_FAST_PAYLOAD_TESTS: '1',
    AIFEEDS_KILL_AFTER_PATH_PUBLISH: '1',
  });
  assert.equal(first.signal === 'SIGKILL' || first.status === 137, true);
  await unlink(preparingJournal).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  await rm(harness.stage, { force: true, recursive: true });
  await buildPayload({
    envFile: harness.stagedEnv,
    payload: harness.stage,
    repoRoot: path.resolve(SYNC_DIR, '..', '..'),
  });

  const second = runBash(installer, args, {
    ...harness.env,
    AIFEEDS_FAST_PAYLOAD_TESTS: '1',
  });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /orphan.*journal/i);
  assert.equal(
    (await lstat(path.join(
      harness.root,
      'opt',
      `.aifeeds-deploy.${harness.manifestDigest}.opt`,
      'receipt.jsonl',
    ))).isFile(),
    true,
  );
});

remoteHarnessTest('a damaged live release fails closed without replacement', async () => {
  const harness = await remoteDeployHarness();
  const release = path.join(
    harness.root,
    'opt',
    'aifeeds-cc-sync-releases',
    harness.manifestDigest,
  );
  await mkdir(path.join(release, 'cc-site', 'sync'), { recursive: true });
  const proof = path.join(release, 'cc-site', 'sync', 'damaged-live.txt');
  await writeFile(proof, 'operator proof\n');
  await symlink(
    `aifeeds-cc-sync-releases/${harness.manifestDigest}/cc-site/sync`,
    path.join(harness.root, 'opt', 'aifeeds-cc-sync'),
  );

  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    { ...harness.env, AIFEEDS_FAST_PAYLOAD_TESTS: '1' },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /live release.*damaged|damaged live release/i);
  assert.equal(await readFile(proof, 'utf8'), 'operator proof\n');
  assert.equal(
    await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
    `aifeeds-cc-sync-releases/${harness.manifestDigest}/cc-site/sync`,
  );
});

remoteHarnessTest('remote installer propagates service failure before changing Nginx', async () => {
  const harness = await remoteDeployHarness({
    priorDeployment: true,
    timerActive: true,
    timerEnabled: true,
  });
  const before = await readFile(harness.vhost, 'utf8');
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      AIFEEDS_SERVICE_START_EXIT: '17',
    },
  );

  assert.equal(result.status, 17);
  assert.equal(await readFile(harness.vhost, 'utf8'), before);
  await assert.rejects(readFile(harness.snippet, 'utf8'), /ENOENT/);
  assert.doesNotMatch(await readFile(harness.log, 'utf8'), /nginx <-s> <reload>/);
  assert.equal(
    await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
    `aifeeds-cc-sync-releases/${harness.oldReleaseId}/cc-site/sync`,
  );
  assert.equal(
    await readFile(path.join(harness.root, 'etc', 'aifeeds', 'cc-sync.env'), 'utf8'),
    'OLD_ENV=1\n',
  );
  assert.equal(
    await readFile(path.join(harness.root, 'etc', 'systemd', 'system', 'aifeeds-cc-sync.service'), 'utf8'),
    'OLD_SERVICE\n',
  );
  assert.equal(
    await readFile(path.join(harness.root, 'etc', 'systemd', 'system', 'aifeeds-cc-sync.timer'), 'utf8'),
    'OLD_TIMER\n',
  );
  assert.equal((await stat(path.join(harness.systemctlState, 'timer-enabled'))).isFile(), true);
  assert.equal((await stat(path.join(harness.systemctlState, 'timer-active'))).isFile(), true);
  await assert.rejects(
    stat(path.join(harness.systemctlState, 'service-active')),
    /ENOENT/,
  );
  await assert.rejects(
    stat(path.join(harness.root, 'opt', 'aifeeds-cc-sync-releases', harness.manifestDigest)),
    /ENOENT/,
  );
});

remoteHarnessTest('a running old service that clearly remains active preserves the original stop error', async () => {
  const harness = await remoteDeployHarness({
    priorDeployment: true,
    serviceState: 'active',
    timerEnabledState: 'enabled',
    timerState: 'active',
  });
  const oldEnv = await readFile(
    path.join(harness.root, 'etc', 'aifeeds', 'cc-sync.env'),
    'utf8',
  );
  const oldService = await readFile(
    path.join(harness.root, 'etc', 'systemd', 'system', 'aifeeds-cc-sync.service'),
    'utf8',
  );
  const oldTimer = await readFile(
    path.join(harness.root, 'etc', 'systemd', 'system', 'aifeeds-cc-sync.timer'),
    'utf8',
  );
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      AIFEEDS_SERVICE_STOP_EXIT: '31',
    },
  );

  assert.equal(result.status, 31, result.stderr);
  assert.equal(
    await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
    `aifeeds-cc-sync-releases/${harness.oldReleaseId}/cc-site/sync`,
  );
  assert.equal(
    await readFile(path.join(harness.root, 'etc', 'aifeeds', 'cc-sync.env'), 'utf8'),
    oldEnv,
  );
  assert.equal(
    await readFile(
      path.join(harness.root, 'etc', 'systemd', 'system', 'aifeeds-cc-sync.service'),
      'utf8',
    ),
    oldService,
  );
  assert.equal(
    await readFile(
      path.join(harness.root, 'etc', 'systemd', 'system', 'aifeeds-cc-sync.timer'),
      'utf8',
    ),
    oldTimer,
  );
  assert.equal(
    await readFile(path.join(harness.systemctlState, 'service-active'), 'utf8'),
    'active\n',
  );
  await assert.rejects(
    stat(path.join(
      harness.root,
      'opt',
      'aifeeds-cc-sync-releases',
      harness.manifestDigest,
    )),
    /ENOENT/,
  );
  assert.doesNotMatch(
    await readFile(harness.log, 'utf8'),
    /switch-symlink|deployment-file-transaction\.mjs> <install>/,
  );
  await assert.rejects(stat(path.join(
    harness.root,
    'opt',
    'aifeeds-cc-sync-releases',
    '.deployment-preparing.json',
  )), /ENOENT/);
  assert.equal(
    (await readdir(path.join(
      harness.root,
      'var',
      'lib',
      'aifeeds-cc-deploy-snapshots',
    ))).some((name) => (
      name.startsWith('aifeeds-cc-root-snapshot.')
    )),
    false,
  );
});

remoteHarnessTest('systemctl partial failures restore the exact original unit state', async (t) => {
  await t.test('service stop mutates state before returning nonzero', async () => {
    const harness = await remoteDeployHarness({
      priorDeployment: true,
      serviceState: 'active',
      timerEnabledState: 'enabled',
      timerState: 'active',
    });
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        AIFEEDS_SERVICE_STOP_MUTATE_THEN_EXIT: '31',
      },
    );

    assert.equal(result.status, 31, result.stderr);
    assert.equal(
      await readFile(path.join(harness.systemctlState, 'service-active'), 'utf8'),
      'active\n',
    );
    assert.equal(
      await readFile(path.join(harness.systemctlState, 'timer-active'), 'utf8'),
      'active\n',
    );
    assert.equal(
      await readFile(path.join(harness.systemctlState, 'timer-enabled'), 'utf8'),
      'enabled\n',
    );
  });

  await t.test('timer stop mutates state before returning nonzero', async () => {
    const harness = await remoteDeployHarness({
      priorDeployment: true,
      serviceState: 'inactive',
      timerEnabledState: 'enabled',
      timerState: 'active',
    });
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        AIFEEDS_TIMER_STOP_MUTATE_THEN_EXIT: '32',
      },
    );

    assert.equal(result.status, 32, result.stderr);
    assert.equal(
      await readFile(path.join(harness.systemctlState, 'timer-active'), 'utf8'),
      'active\n',
    );
    assert.equal(
      await readFile(path.join(harness.systemctlState, 'timer-enabled'), 'utf8'),
      'enabled\n',
    );
    await assert.rejects(
      stat(path.join(harness.systemctlState, 'service-active')),
      /ENOENT/,
    );
  });

  await t.test('timer disable mutates state before returning nonzero', async () => {
    const harness = await remoteDeployHarness({
      priorDeployment: true,
      serviceState: 'inactive',
      timerEnabledState: 'enabled',
      timerState: 'inactive',
    });
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        AIFEEDS_TIMER_DISABLE_MUTATE_THEN_EXIT: '33',
      },
    );

    assert.equal(result.status, 33, result.stderr);
    assert.equal(
      await readFile(path.join(harness.systemctlState, 'timer-enabled'), 'utf8'),
      'enabled\n',
    );
    await assert.rejects(
      stat(path.join(harness.systemctlState, 'timer-active')),
      /ENOENT/,
    );
    await assert.rejects(
      stat(path.join(harness.systemctlState, 'service-active')),
      /ENOENT/,
    );
  });
});

remoteHarnessTest('existing OPT must name one safe and complete managed release', async (t) => {
  const scenarios = [
    {
      name: 'absolute target',
      async mutate(harness, live) {
        await unlink(live);
        await symlink(
          path.join(
            harness.root,
            'opt',
            'aifeeds-cc-sync-releases',
            harness.oldReleaseId,
            'cc-site',
            'sync',
          ),
          live,
        );
      },
    },
    {
      name: 'dot-dot target',
      async mutate(harness, live) {
        await unlink(live);
        await symlink(
          `aifeeds-cc-sync-releases/${harness.oldReleaseId}/cc-site/../cc-site/sync`,
          live,
        );
      },
    },
    {
      name: 'unmanaged relative target',
      async mutate(_harness, live) {
        await unlink(live);
        await symlink('operator-managed/cc-site/sync', live);
      },
    },
    {
      name: 'damaged managed release',
      async mutate(harness) {
        await unlink(path.join(
          harness.root,
          'opt',
          'aifeeds-cc-sync-releases',
          harness.oldReleaseId,
          'cc-site',
          'sync',
          'sync.mjs',
        ));
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const harness = await remoteDeployHarness({
        priorDeployment: true,
        serviceState: 'active',
        timerEnabledState: 'enabled',
        timerState: 'active',
      });
      const live = path.join(harness.root, 'opt', 'aifeeds-cc-sync');
      const beforeTarget = await readlink(live);
      const oldEnv = await readFile(
        path.join(harness.root, 'etc', 'aifeeds', 'cc-sync.env'),
        'utf8',
      );
      await scenario.mutate(harness, live);
      const invalidTarget = await readlink(live);

      const result = runBash(
        path.join(SYNC_DIR, 'install-remote.sh'),
        [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
        { ...harness.env, AIFEEDS_FAST_PAYLOAD_TESTS: '1' },
      );

      assert.notEqual(result.status, 0, scenario.name);
      assert.match(result.stderr, /live release|live code.*managed|unsafe/i);
      assert.equal(await readlink(live), invalidTarget);
      assert.equal(
        await readFile(path.join(harness.root, 'etc', 'aifeeds', 'cc-sync.env'), 'utf8'),
        oldEnv,
      );
      assert.equal(
        await readFile(path.join(harness.systemctlState, 'service-active'), 'utf8'),
        'active\n',
      );
      assert.equal(
        await readFile(path.join(harness.systemctlState, 'timer-active'), 'utf8'),
        'active\n',
      );
      assert.equal(
        await readFile(path.join(harness.systemctlState, 'timer-enabled'), 'utf8'),
        'enabled\n',
      );
      await assert.rejects(stat(harness.payloadTestProof), /ENOENT/);
      const commandLog = await readFile(harness.log, 'utf8');
      assert.doesNotMatch(commandLog, /systemctl <stop>|systemctl <disable>|useradd/);
      assert.notEqual(beforeTarget, '', scenario.name);
    });
  }
});

remoteHarnessTest('unsupported systemd states fail closed before tests or live writes', async () => {
  const scenarios = [
    {
      name: 'masked service load',
      harness: { priorDeployment: true },
      env: { AIFEEDS_SERVICE_LOAD_STATE: 'masked' },
    },
    {
      name: 'masked timer load',
      harness: { priorDeployment: true },
      env: { AIFEEDS_TIMER_LOAD_STATE: 'masked' },
    },
    {
      name: 'runtime-enabled timer',
      harness: { priorDeployment: true, timerEnabledState: 'enabled-runtime' },
      env: {},
    },
    {
      name: 'static timer',
      harness: { priorDeployment: true, timerEnabledState: 'static' },
      env: {},
    },
    {
      name: 'failed service',
      harness: { priorDeployment: true, serviceState: 'failed' },
      env: {},
    },
    {
      name: 'deactivating service',
      harness: { priorDeployment: true, serviceState: 'deactivating' },
      env: {},
    },
    {
      name: 'failed timer',
      harness: { priorDeployment: true, timerState: 'failed' },
      env: {},
    },
  ];
  for (const scenario of scenarios) {
    const harness = await remoteDeployHarness(scenario.harness);
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      {
        ...harness.env,
        ...scenario.env,
        AIFEEDS_NODE_TEST_EXIT: '45',
      },
    );
    assert.notEqual(result.status, 0, scenario.name);
    assert.match(result.stderr, /unsupported systemd state|unable to query systemd/i);
    const commandLog = await readFile(harness.log, 'utf8');
    assert.doesNotMatch(commandLog, /node <--test>/, scenario.name);
    assert.doesNotMatch(
      commandLog,
      /switch-symlink|deployment-file-transaction\.mjs> <install>/,
      scenario.name,
    );
    assert.equal(
      await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
      `aifeeds-cc-sync-releases/${harness.oldReleaseId}/cc-site/sync`,
      scenario.name,
    );
  }
});

remoteHarnessTest('a failed first install leaves no live code, unit, env, or timer state', async () => {
  const harness = await remoteDeployHarness();
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      AIFEEDS_ABSENT_IS_ACTIVE_EXIT: '4',
      AIFEEDS_SERVICE_START_EXIT: '19',
    },
  );
  assert.equal(result.status, 19, result.stderr);
  assert.match(
    result.stderr,
    /installer command failed at line [0-9]+ \(status 19\)/,
  );
  for (const absent of [
    path.join(harness.root, 'opt', 'aifeeds-cc-sync'),
    path.join(harness.root, 'opt', 'aifeeds-cc-sync-releases', harness.manifestDigest),
    path.join(harness.root, 'etc', 'aifeeds', 'cc-sync.env'),
    path.join(harness.root, 'etc', 'systemd', 'system', 'aifeeds-cc-sync.service'),
    path.join(harness.root, 'etc', 'systemd', 'system', 'aifeeds-cc-sync.timer'),
    path.join(harness.systemctlState, 'timer-enabled'),
    path.join(harness.systemctlState, 'timer-active'),
    path.join(harness.root, 'user-created'),
    path.join(harness.root, 'var', 'lib', 'aifeeds-cc-sync'),
    path.join(harness.siteRoot, 'i'),
  ]) {
    await assert.rejects(stat(absent), /ENOENT/, absent);
  }
});

remoteHarnessTest('root-only path chains are rejected before account bootstrap', async (t) => {
  for (const scenario of [
    {
      name: 'release root symlink',
      async mutate(harness) {
        const outside = path.join(harness.root, 'outside-release-parent');
        await mkdir(outside);
        await mkdir(path.join(harness.root, 'opt'), { recursive: true });
        await symlink(
          outside,
          path.join(harness.root, 'opt', 'aifeeds-cc-sync-releases'),
        );
      },
    },
    {
      name: 'intermediate systemd symlink',
      async mutate(harness) {
        const outside = path.join(harness.root, 'outside-systemd-parent');
        await mkdir(outside);
        await mkdir(path.join(harness.root, 'etc'), { recursive: true });
        await symlink(outside, path.join(harness.root, 'etc', 'systemd'));
      },
    },
  ]) {
    await t.test(scenario.name, async () => {
      const harness = await remoteDeployHarness();
      await scenario.mutate(harness);
      const result = runBash(
        path.join(SYNC_DIR, 'install-remote.sh'),
        [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
        { ...harness.env, AIFEEDS_FAST_PAYLOAD_TESTS: '1' },
      );
      assert.notEqual(result.status, 0);
      await assert.rejects(stat(path.join(harness.root, 'user-created')), /ENOENT/);
      await assert.rejects(
        stat(path.join(harness.root, 'var', 'lib', 'aifeeds-cc-sync')),
        /ENOENT/,
      );
      await assert.rejects(stat(path.join(harness.siteRoot, 'i')), /ENOENT/);
      const log = await readFile(harness.log, 'utf8');
      assert.doesNotMatch(log, /useradd|userdel/);
    });
  }
});

remoteHarnessTest('existing managed roots with wrong mode or owner are rejected unchanged', async (t) => {
  await t.test('wrong item-root mode', async () => {
    const harness = await remoteDeployHarness();
    const itemRoot = path.join(harness.siteRoot, 'i');
    await mkdir(itemRoot, { mode: 0o750 });
    await chmod(itemRoot, 0o770);
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      { ...harness.env, AIFEEDS_FAST_PAYLOAD_TESTS: '1' },
    );
    assert.notEqual(result.status, 0);
    assert.equal((await stat(itemRoot)).mode & 0o777, 0o770);
    const log = await readFile(harness.log, 'utf8');
    assert.doesNotMatch(log, /chown <-R>.*\/i>|chmod.*\/i/);
  });

  await t.test('wrong state-root owner', async () => {
    const harness = await remoteDeployHarness();
    const stateRoot = path.join(harness.root, 'var', 'lib', 'aifeeds-cc-sync');
    await mkdir(stateRoot, { recursive: true, mode: 0o750 });
    const before = await stat(stateRoot);
    const wrongUid = process.getuid() === 997 ? 996 : 997;
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        AIFEEDS_SYNC_PASSWD:
          `aifeeds-sync:x:${wrongUid}:${process.getgid()}::/nonexistent:/sbin/nologin`,
      },
    );
    assert.notEqual(result.status, 0);
    const after = await stat(stateRoot);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.equal(after.mode & 0o777, before.mode & 0o777);
  });
});

remoteHarnessTest('rollback restores independent timer and service states exactly', async () => {
  const harness = await remoteDeployHarness({
    priorDeployment: true,
    serviceActive: true,
    timerActive: false,
    timerEnabled: true,
  });
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      AIFEEDS_TIMER_ENABLE_EXIT: '23',
    },
  );
  assert.equal(result.status, 23, result.stderr);
  assert.equal(
    await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
    `aifeeds-cc-sync-releases/${harness.oldReleaseId}/cc-site/sync`,
  );
  assert.equal((await stat(path.join(harness.systemctlState, 'timer-enabled'))).isFile(), true);
  await assert.rejects(stat(path.join(harness.systemctlState, 'timer-active')), /ENOENT/);
  assert.equal((await stat(path.join(harness.systemctlState, 'service-active'))).isFile(), true);
});

remoteHarnessTest('rollback restarts an old oneshot that was still activating', async () => {
  const harness = await remoteDeployHarness({
    priorDeployment: true,
    serviceState: 'activating',
    timerEnabledState: 'enabled',
  });
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      AIFEEDS_TIMER_ENABLE_EXIT: '23',
    },
  );
  assert.equal(result.status, 23, result.stderr);
  assert.equal(
    await readFile(path.join(harness.systemctlState, 'service-active'), 'utf8'),
    'active\n',
  );
  assert.equal(
    (await readFile(harness.log, 'utf8').then(
      (value) => value.match(/systemctl <start> <aifeeds-cc-sync\.service>/g) ?? [],
    )).length,
    2,
  );
});

remoteHarnessTest('rollback preserves concurrent operator changes to candidate live files', async (t) => {
  const scenarios = [
    {
      name: 'environment',
      relative: 'etc/aifeeds/cc-sync.env',
    },
    {
      name: 'service unit',
      relative: 'etc/systemd/system/aifeeds-cc-sync.service',
    },
    {
      name: 'timer unit',
      relative: 'etc/systemd/system/aifeeds-cc-sync.timer',
    },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const harness = await remoteDeployHarness({
        priorDeployment: true,
        serviceState: 'active',
      });
      const result = runBash(
        path.join(SYNC_DIR, 'install-remote.sh'),
        [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
        {
          ...harness.env,
          AIFEEDS_FAST_PAYLOAD_TESTS: '1',
          AIFEEDS_OPERATOR_MUTATE_RELATIVE_PATH: scenario.relative,
          AIFEEDS_SERVICE_START_EXIT: '17',
        },
      );
      assert.equal(result.status, 70, result.stderr);
      assert.equal(
        await readFile(path.join(harness.root, scenario.relative), 'utf8'),
        'operator mutation\n',
      );
      assert.match(result.stderr, /rollback conflict/i);
    });
  }
});

remoteHarnessTest('rollback preserves a concurrent operator change to the live code link', async () => {
  const harness = await remoteDeployHarness({
    priorDeployment: true,
    serviceState: 'active',
  });
  const operatorTarget = 'operator-managed-release/cc-site/sync';
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      AIFEEDS_OPERATOR_MUTATE_OPT_TARGET: operatorTarget,
      AIFEEDS_SERVICE_START_EXIT: '17',
    },
  );
  assert.equal(result.status, 70, result.stderr);
  assert.equal(
    await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
    operatorTarget,
  );
  assert.match(result.stderr, /rollback conflict/i);
});

remoteHarnessTest('managed path symlinks and item hardlinks cannot modify outside inodes', async (t) => {
  await t.test('release parent symlink', async () => {
    const harness = await remoteDeployHarness();
    const outside = path.join(harness.root, 'outside-release-parent');
    await mkdir(outside);
    await mkdir(path.join(harness.root, 'opt'), { recursive: true });
    await symlink(outside, path.join(harness.root, 'opt', 'aifeeds-cc-sync-releases'));
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      { ...harness.env, AIFEEDS_FAST_PAYLOAD_TESTS: '1' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /managed path|directory chain/);
    assert.deepEqual(await readdir(outside), []);
  });

  await t.test('item hardlink', async () => {
    const harness = await remoteDeployHarness();
    const itemRoot = path.join(harness.siteRoot, 'i');
    const outside = path.join(harness.root, 'outside-item.html');
    await mkdir(itemRoot, { mode: 0o750 });
    await writeFile(outside, 'outside\n', { mode: 0o600 });
    await link(outside, path.join(itemRoot, 'hardlink.html'));
    const beforeMode = (await stat(outside)).mode & 0o777;
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      { ...harness.env, AIFEEDS_FAST_PAYLOAD_TESTS: '1' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /single-link regular file/);
    assert.equal(await readFile(outside, 'utf8'), 'outside\n');
    assert.equal((await stat(outside)).mode & 0o777, beforeMode);
    assert.doesNotMatch(
      await readFile(harness.log, 'utf8'),
      /chown <-R> <aifeeds-sync:www> <[^>]+\/i>/,
    );
  });
});

remoteHarnessTest('existing sync account must match the locked system identity', async () => {
  for (const passwd of [
    'aifeeds-sync:x:1001:1000::/nonexistent:/sbin/nologin',
    'aifeeds-sync:x:998:1001::/nonexistent:/sbin/nologin',
    'aifeeds-sync:x:998:1000::/home/aifeeds:/sbin/nologin',
    'aifeeds-sync:x:998:1000::/nonexistent:/bin/bash',
  ]) {
    const harness = await remoteDeployHarness();
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      {
        ...harness.env,
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        AIFEEDS_SYNC_PASSWD: passwd,
      },
    );
    assert.notEqual(result.status, 0, passwd);
    assert.match(result.stderr, /aifeeds-sync account does not match/, passwd);
  }
});

remoteHarnessTest('remote installer rolls back the managed include and snippet when Nginx fails', async () => {
  const oldSnippet = '# previous content mirror snippet\n';
  const harness = await remoteDeployHarness({ existingSnippet: oldSnippet });
  const before = await readFile(harness.vhost, 'utf8');
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_FAIL_NGINX_TEST_AT: '1',
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
    },
  );

  assert.notEqual(result.status, 0);
  assert.equal(await readFile(harness.vhost, 'utf8'), before);
  assert.equal(await readFile(harness.snippet, 'utf8'), oldSnippet);
  const commandLog = await readFile(harness.log, 'utf8');
  assert.ok((commandLog.match(/nginx <-t>/g) ?? []).length >= 2, commandLog);
  assert.match(commandLog, /systemctl <stop> <aifeeds-cc-sync.service>/);
  assert.doesNotMatch(commandLog, /systemctl <disable> <aifeeds-cc-sync.timer>/);
});

remoteHarnessTest('Nginx reload failure restores the prior config', async () => {
  const oldSnippet = '# prior snippet before reload failure\n';
  const harness = await remoteDeployHarness({ existingSnippet: oldSnippet });
  const before = await readFile(harness.vhost, 'utf8');
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_FAIL_NGINX_RELOAD_AT: '1',
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
    },
  );
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(harness.vhost, 'utf8'), before);
  assert.equal(await readFile(harness.snippet, 'utf8'), oldSnippet);
});

remoteHarnessTest('local HTTPS smoke probes require exact 200 responses and deployed bytes', async (t) => {
  await t.test('reload overlap retries one stale response', async () => {
    const harness = await remoteDeployHarness();
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      {
        ...harness.env,
        AIFEEDS_CURL_STALE_ONCE_URL: 'https://ai-feeds.cc/sitemap.xml',
        AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const commandLog = await readFile(harness.log, 'utf8');
    assert.equal(
      commandLog.split('\n').filter((line) => (
        line.startsWith('curl')
        && line.includes('<https://ai-feeds.cc/sitemap.xml>')
      )).length,
      2,
    );
  });

  const failures = [
    {
      name: 'non-200 root sitemap',
      env: { AIFEEDS_CURL_STATUS: '503' },
    },
    {
      name: 'wrong root sitemap bytes',
      env: { AIFEEDS_CURL_CORRUPT_URL: 'https://ai-feeds.cc/sitemap.xml' },
    },
    {
      name: 'wrong generation shard bytes',
      env: {
        AIFEEDS_CURL_CORRUPT_URL:
          'https://ai-feeds.cc/sitemaps/123e4567-e89b-42d3-a456-426614174000/archive.xml',
      },
    },
    {
      name: 'wrong domestic sitemap index bytes',
      env: { AIFEEDS_CURL_CORRUPT_URL: 'https://ai-feeds.cc/sitemap-cn.xml' },
    },
    {
      name: 'wrong domestic sitemap leaf bytes',
      env: { AIFEEDS_CURL_CORRUPT_URL: 'https://ai-feeds.cc/sitemap-cn-0001.xml' },
    },
    {
      name: 'wrong ai-news bytes',
      env: { AIFEEDS_CURL_CORRUPT_URL: 'https://ai-feeds.cc/ai-news/' },
    },
  ];

  for (const failure of failures) {
    await t.test(failure.name, async () => {
      const harness = await remoteDeployHarness({
        existingSnippet: '# prior smoke snippet\n',
        priorDeployment: true,
        timerActive: true,
        timerEnabled: true,
      });
      const before = await readFile(harness.vhost, 'utf8');
      const result = runBash(
        path.join(SYNC_DIR, 'install-remote.sh'),
        [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
        {
          ...harness.env,
          ...failure.env,
          AIFEEDS_FAST_PAYLOAD_TESTS: '1',
        },
      );
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, /smoke probe/);
      assert.equal(await readFile(harness.vhost, 'utf8'), before);
      assert.equal(await readFile(harness.snippet, 'utf8'), '# prior smoke snippet\n');
      assert.equal(
        await readlink(path.join(harness.root, 'opt', 'aifeeds-cc-sync')),
        `aifeeds-cc-sync-releases/${harness.oldReleaseId}/cc-site/sync`,
      );
    });
  }
});

remoteHarnessTest('rollback Nginx validation and reload failures are surfaced', async () => {
  for (const failure of [
    { AIFEEDS_FAIL_NGINX_RELOAD_AT: '1', AIFEEDS_FAIL_NGINX_TEST_AT: '2' },
    { AIFEEDS_FAIL_NGINX_RELOAD_AT: '1,2' },
  ]) {
    const harness = await remoteDeployHarness();
    const result = runBash(
      path.join(SYNC_DIR, 'install-remote.sh'),
      [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
      { ...harness.env, ...failure, AIFEEDS_FAST_PAYLOAD_TESTS: '1' },
    );
    assert.equal(result.status, 70, result.stderr);
    assert.match(result.stderr, /rollback was incomplete/);
  }
});

remoteHarnessTest('rollback never overwrites a concurrent panel edit', async () => {
  const harness = await remoteDeployHarness();
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    {
      ...harness.env,
      AIFEEDS_FAST_PAYLOAD_TESTS: '1',
      AIFEEDS_PANEL_MUTATE_AT_NGINX_TEST: '1',
    },
  );
  assert.equal(result.status, 70, result.stderr);
  assert.equal(await readFile(harness.vhost, 'utf8'), 'panel concurrent edit\n');
  assert.match(result.stderr, /rollback conflict: vhost/);
});

remoteHarnessTest('remote installer refuses Node older than 18 before tests or service start', async () => {
  const harness = await remoteDeployHarness();
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com', harness.manifestDigest],
    { ...harness.env, AIFEEDS_NODE_MAJOR: '16' },
  );
  const commandLog = await readFile(harness.log, 'utf8');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node 18 or newer is required/);
  assert.doesNotMatch(commandLog, /node <--test>/);
  assert.doesNotMatch(commandLog, /systemctl <start> <aifeeds-cc-sync.service>/);
});
