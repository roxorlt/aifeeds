import assert from 'node:assert/strict';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SYNC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

async function read(relativePath) {
  return readFile(path.join(SYNC_DIR, relativePath), 'utf8');
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

test('nginx exposes only generated content roots without shadowing auth', async () => {
  const nginx = await read('nginx-content-mirror.conf');

  assert.match(nginx, /location \^~ \/i\/ \{/);
  assert.match(
    nginx,
    /location \^~ \/ai-news\/ \{[\s\S]*?alias \/var\/lib\/aifeeds-cc-sync\/public\/current\/ai-news\/;/,
  );
  assert.match(
    nginx,
    /location = \/sitemap\.xml \{[\s\S]*?alias \/var\/lib\/aifeeds-cc-sync\/public\/current\/sitemap\.xml;/,
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

test('vhost editor inserts one managed include into only the HTTPS site block', async () => {
  const { injectManagedInclude } = await import('../nginx-vhost-editor.mjs');
  const source = `server {\n  listen 80;\n  server_name ai-feeds.cc;\n  if ($server_port !~ 443) {\n    rewrite ^(?!/shenma-site-verification\\.txt$)(/.*)$ https://$host$1 permanent;\n  }\n}\n\nserver {\n  listen 443 ssl http2;\n  server_name ai-feeds.cc www.ai-feeds.cc;\n  #REWRITE-END\n  location ^~ /auth/wechat/ { proxy_pass http://127.0.0.1:3001; }\n  location ~ ".*\\.xml$" { return 418; }\n}\n`;

  const edited = injectManagedInclude(source);
  assert.equal(
    edited.match(/# AIFEEDS-CC-CONTENT-MIRROR-BEGIN/g)?.length,
    1,
  );
  assert.equal(
    edited.match(/include \/www\/server\/panel\/vhost\/nginx\/aifeeds-cc-content-mirror\.conf;/g)?.length,
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
  const https = `server {\n listen 443 ssl;\n server_name ai-feeds.cc;\n}\n`;

  assert.throws(
    () => injectManagedInclude(`${https}${https}`),
    /exactly one HTTPS ai-feeds\.cc server block/,
  );
  assert.throws(
    () => injectManagedInclude(
      https.replace(
        '\n}',
        '\n include /www/server/panel/vhost/nginx/aifeeds-cc-content-mirror.conf;\n}',
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
  const managed = injectManagedInclude(https);
  assert.throws(
    () => injectManagedInclude(
      `${INCLUDE_OUTSIDE_FIXTURE}\n${managed}`,
    ),
    /unmanaged content mirror include/,
  );
});

const INCLUDE_OUTSIDE_FIXTURE = (
  'include /www/server/panel/vhost/nginx/'
  + 'aifeeds-cc-content-mirror.conf;'
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
  const log = path.join(root, 'commands.log');
  await mkdir(path.join(home, '.ssh'), { recursive: true });
  await mkdir(secrets, { recursive: true });
  await mkdir(fakeBin);
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
case "$*" in
  *'mktemp -d /tmp/aifeeds-cc-sync.XXXXXX'*)
    printf '/tmp/aifeeds-cc-sync.ABC123\n'
    ;;
  *'install-remote.sh'*)
    exit "\${AIFEEDS_REMOTE_INSTALL_EXIT:-0}"
    ;;
esac
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
  assert.match(badTarget.stderr, /target must be prod or staging/);

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
  assert.match(commandLog, /install-remote\.sh/);
  assert.equal(combined.includes(secret), false);

  const failed = await localDeployHarness(`CC_SYNC_SECRET=${secret}\n`);
  const failure = runBash(deploy, ['prod'], {
    ...failed.env,
    AIFEEDS_REMOTE_INSTALL_EXIT: '23',
  });
  assert.equal(failure.status, 23);
});

test('local deploy discovers only the secret file for the selected target', async () => {
  const stagingSecret = 'd'.repeat(64);
  const stagingOnly = await localDeployHarness(
    `CC_SYNC_SECRET=${stagingSecret}\n`,
    { autoDiscover: true, secretTarget: 'staging' },
  );
  const stagingResult = runBash(
    stagingOnly.deploy,
    ['staging'],
    stagingOnly.env,
  );
  assert.equal(
    stagingResult.status,
    0,
    `${stagingResult.stdout}\n${stagingResult.stderr}`,
  );
  assert.equal(
    `${stagingResult.stdout}\n${stagingResult.stderr}`.includes(stagingSecret),
    false,
  );

  const prodOnly = await localDeployHarness(
    `CC_SYNC_SECRET=${'e'.repeat(64)}\n`,
    { autoDiscover: true },
  );
  const missingStaging = runBash(
    prodOnly.deploy,
    ['staging'],
    prodOnly.env,
  );
  assert.notEqual(missingStaging.status, 0);
  assert.match(
    missingStaging.stderr,
    /unable to find \.secrets\/aifeeds-staging\.env/,
  );
  await assert.rejects(readFile(prodOnly.log, 'utf8'), /ENOENT/);
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

async function remoteDeployHarness({ existingSnippet = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cc-deploy-remote-'));
  const fakeBin = path.join(root, 'fake-bin');
  const stage = path.join(root, 'tmp', 'aifeeds-cc-sync.ABC123');
  const siteRoot = path.join(root, 'www', 'wwwroot', 'ai-feeds.cc');
  const vhostDir = path.join(root, 'www', 'server', 'panel', 'vhost', 'nginx');
  const vhost = path.join(vhostDir, 'html_ai-feeds.cc.conf');
  const snippet = path.join(vhostDir, 'aifeeds-cc-content-mirror.conf');
  const log = path.join(root, 'commands.log');
  await mkdir(fakeBin, { recursive: true });
  await mkdir(path.join(stage, 'test'), { recursive: true });
  await mkdir(siteRoot, { recursive: true });
  await mkdir(vhostDir, { recursive: true });
  await writeFile(path.join(siteRoot, 'sitemap-static.xml'), '<urlset/>\n');
  await writeFile(vhost, VHOST_FIXTURE);
  if (existingSnippet !== null) await writeFile(snippet, existingSnippet);
  await writeFile(
    path.join(stage, 'cc-sync.env'),
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

  const payloadNames = (await readdir(SYNC_DIR)).filter((name) => (
    name.endsWith('.mjs')
    || name === 'static-urls.json'
    || name === 'package.json'
    || name === 'aifeeds-cc-sync.service'
    || name === 'aifeeds-cc-sync.timer'
    || name === 'nginx-content-mirror.conf'
    || name === 'install-remote.sh'
    || name === 'deploy-to-cc.sh'
  ));
  for (const name of payloadNames) {
    await copyFile(path.join(SYNC_DIR, name), path.join(stage, name));
  }
  for (const entry of await readdir(path.join(SYNC_DIR, 'test'))) {
    if (entry.endsWith('.test.mjs')) {
      await copyFile(
        path.join(SYNC_DIR, 'test', entry),
        path.join(stage, 'test', entry),
      );
    }
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
`);
  await executable(path.join(fakeBin, 'getent'), `#!/usr/bin/env bash
if [[ "$*" == 'passwd www' ]]; then
  printf 'www:x:1000:1000::/nonexistent:/sbin/nologin\n'
  exit 0
fi
if [[ "$*" == 'passwd aifeeds-sync' && -f "$AIFEEDS_DEPLOY_ROOT/user-created" ]]; then
  printf 'aifeeds-sync:x:1001:1000::/nonexistent:/sbin/nologin\n'
  exit 0
fi
if [[ "$*" == 'passwd aifeeds-sync' ]]; then exit 2; fi
exit 2
`);
  await executable(path.join(fakeBin, 'runuser'), `#!/usr/bin/env bash
set -euo pipefail
printf 'runuser' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
while (($#)) && [[ "$1" != '--' ]]; do shift; done
shift
"$@"
`);
  await executable(path.join(fakeBin, 'node'), `#!/usr/bin/env bash
set -euo pipefail
printf 'node' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
if [[ "\${1:-}" == '-p' ]]; then printf '%s\n' "\${AIFEEDS_NODE_MAJOR:-18}"; exit 0; fi
if [[ "\${1:-}" == '--test' ]]; then exit "\${AIFEEDS_NODE_TEST_EXIT:-0}"; fi
if [[ "\${1:-}" == *nginx-vhost-editor.mjs ]]; then
  exec "$AIFEEDS_REAL_NODE" "$@"
fi
exit 0
`);
  await executable(path.join(fakeBin, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
if [[ "$*" == 'start aifeeds-cc-sync.service' ]]; then
  [[ "\${AIFEEDS_SERVICE_START_EXIT:-0}" == 0 ]] || exit "$AIFEEDS_SERVICE_START_EXIT"
  generation='123e4567-e89b-42d3-a456-426614174000'
  state="$AIFEEDS_DEPLOY_ROOT/var/lib/aifeeds-cc-sync/public"
  mkdir -p "$state/generations/$generation/sitemaps" "$state/generations/$generation/ai-news"
  printf '<urlset/>\n' > "$state/generations/$generation/sitemaps/archive.xml"
  printf '<html></html>\n' > "$state/generations/$generation/ai-news/index.html"
  printf '<sitemapindex><sitemap><loc>https://ai-feeds.cc/sitemaps/%s/archive.xml</loc></sitemap></sitemapindex>\n' "$generation" > "$state/generations/$generation/sitemap.xml"
  ln -s "generations/$generation" "$state/current"
fi
if [[ "$*" == 'enable --now aifeeds-cc-sync.timer' ]]; then
  exit "\${AIFEEDS_TIMER_ENABLE_EXIT:-0}"
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
  [[ "\${AIFEEDS_FAIL_NGINX_TEST_AT:-0}" != "$count" ]] || exit 1
  exit 0
fi
if [[ "$*" == '-s reload' ]]; then
  count_file="$AIFEEDS_DEPLOY_ROOT/nginx-reload-count"
  count=0
  [[ ! -f "$count_file" ]] || read -r count < "$count_file"
  count=$((count + 1)); printf '%s\n' "$count" > "$count_file"
  [[ "\${AIFEEDS_FAIL_NGINX_RELOAD_AT:-0}" != "$count" ]] || exit 1
fi
`);
  await executable(path.join(fakeBin, 'curl'), `#!/usr/bin/env bash
printf 'curl' >> "$AIFEEDS_HARNESS_LOG"
printf ' <%s>' "$@" >> "$AIFEEDS_HARNESS_LOG"
printf '\n' >> "$AIFEEDS_HARNESS_LOG"
exit "\${AIFEEDS_CURL_EXIT:-0}"
`);

  return {
    env: {
      AIFEEDS_DEPLOY_TEST_MODE: '1',
      AIFEEDS_DEPLOY_ROOT: root,
      AIFEEDS_HARNESS_LOG: log,
      AIFEEDS_REAL_NODE: process.execPath,
      AIFEEDS_INSTALL: path.join(fakeBin, 'install'),
      AIFEEDS_CHOWN: path.join(fakeBin, 'chown'),
      AIFEEDS_USERADD: path.join(fakeBin, 'useradd'),
      AIFEEDS_GETENT: path.join(fakeBin, 'getent'),
      AIFEEDS_RUNUSER: path.join(fakeBin, 'runuser'),
      AIFEEDS_NODE_BIN: path.join(fakeBin, 'node'),
      AIFEEDS_SYSTEMCTL: path.join(fakeBin, 'systemctl'),
      AIFEEDS_NGINX: path.join(fakeBin, 'nginx'),
      AIFEEDS_CURL: path.join(fakeBin, 'curl'),
    },
    log,
    root,
    siteRoot,
    snippet,
    stage,
    vhost,
  };
}

test('remote installer gates activation on tests, service output readability and Nginx', async () => {
  const harness = await remoteDeployHarness();
  const installer = path.join(SYNC_DIR, 'install-remote.sh');
  const result = runBash(
    installer,
    [harness.stage, 'https://api.ai-feeds.com'],
    harness.env,
  );
  const commandLog = await readFile(harness.log, 'utf8');
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, `${output}\n${commandLog}`);

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
  assert.match(commandLog, /current\/sitemaps\/archive\.xml/);
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

test('remote installer propagates service failure before changing Nginx', async () => {
  const harness = await remoteDeployHarness();
  const before = await readFile(harness.vhost, 'utf8');
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com'],
    { ...harness.env, AIFEEDS_SERVICE_START_EXIT: '17' },
  );

  assert.equal(result.status, 17);
  assert.equal(await readFile(harness.vhost, 'utf8'), before);
  await assert.rejects(readFile(harness.snippet, 'utf8'), /ENOENT/);
  assert.doesNotMatch(await readFile(harness.log, 'utf8'), /nginx <-s> <reload>/);
});

test('remote installer rolls back the managed include and snippet when Nginx fails', async () => {
  const oldSnippet = '# previous content mirror snippet\n';
  const harness = await remoteDeployHarness({ existingSnippet: oldSnippet });
  const before = await readFile(harness.vhost, 'utf8');
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com'],
    { ...harness.env, AIFEEDS_FAIL_NGINX_TEST_AT: '1' },
  );

  assert.notEqual(result.status, 0);
  assert.equal(await readFile(harness.vhost, 'utf8'), before);
  assert.equal(await readFile(harness.snippet, 'utf8'), oldSnippet);
  const commandLog = await readFile(harness.log, 'utf8');
  assert.ok((commandLog.match(/nginx <-t>/g) ?? []).length >= 2, commandLog);
  assert.match(commandLog, /systemctl <disable> <--now> <aifeeds-cc-sync.timer>/);
});

test('remote installer refuses Node older than 18 before tests or service start', async () => {
  const harness = await remoteDeployHarness();
  const result = runBash(
    path.join(SYNC_DIR, 'install-remote.sh'),
    [harness.stage, 'https://api.ai-feeds.com'],
    { ...harness.env, AIFEEDS_NODE_MAJOR: '16' },
  );
  const commandLog = await readFile(harness.log, 'utf8');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Node 18 or newer is required/);
  assert.doesNotMatch(commandLog, /node <--test>/);
  assert.doesNotMatch(commandLog, /systemctl <start> <aifeeds-cc-sync.service>/);
});
