import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bootstrapPath = resolve(here, 'aifeeds-perf-staging-bootstrap.conf');
const tlsPath = resolve(here, 'aifeeds-perf-staging-server.conf');

function readRequiredTemplate(path, label) {
  assert.ok(existsSync(path), `${label} template must exist`);
  return readFileSync(path, 'utf8');
}

function occurrences(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

function seoLocation(config) {
  const match = config.match(/^\s*location\s+~\s+(.+)\s+\{\s*$([\s\S]*?)^\s{4}\}/m);
  assert.ok(match, 'topology-faithful SEO regex location must exist');
  return {
    pattern: new RegExp(match[1]),
    patternSource: match[1],
    block: match[2],
  };
}

test('aifeeds perf-staging bootstrap exposes only the isolated ACME challenge', () => {
  const config = readRequiredTemplate(bootstrapPath, 'HTTP-01 bootstrap');

  assert.match(config, /listen\s+80;/);
  assert.match(config, /listen\s+\[::\]:80;/);
  assert.match(config, /server_name\s+perf-staging\.ai-feeds\.com;/);
  assert.match(config, /location\s+\^~\s+\/\.well-known\/acme-challenge\/\s*\{/);
  assert.match(config, /root\s+\/var\/www\/aifeeds-certbot;/);
  assert.match(config, /try_files\s+\$uri\s+=404;/);
  assert.match(config, /location\s+\/\s*\{\s*return\s+503;\s*\}/s);

  assert.doesNotMatch(config, /proxy_pass|ssl_certificate|proxy_cache/i);
  assert.doesNotMatch(config, /X-Origin-Secret|__ORIGIN_SECRET__|api[_-]?token/i);
});

test('aifeeds perf-staging server pins the isolated public and upstream staging hosts', () => {
  const config = readRequiredTemplate(tlsPath, 'aifeeds perf-staging server');

  for (const required of [
    'server_name perf-staging.ai-feeds.com;',
    'ssl_certificate /etc/letsencrypt/live/perf-staging.ai-feeds.com/fullchain.pem;',
    'ssl_certificate_key /etc/letsencrypt/live/perf-staging.ai-feeds.com/privkey.pem;',
    'include /etc/letsencrypt/options-ssl-nginx.conf;',
    'ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;',
    'set $aifeeds_pages_host xlist-dashboard-perf.pages.dev;',
    'set $aifeeds_worker_host staging-api.ai-feeds.com;',
  ]) {
    assert.ok(config.includes(required), `TLS template missing: ${required}`);
  }

  assert.match(config, /listen\s+443\s+ssl\s+http2;/);
  assert.match(config, /resolver\s+1\.1\.1\.1\s+1\.0\.0\.1\s+valid=30s\s+ipv6=off;/);
  assert.match(config, /resolver_timeout\s+5s;/);
  assert.doesNotMatch(config, /__[A-Z0-9_]+__/);
  assert.doesNotMatch(config, /server_name\s+[^;]*\*/);
});

test('aifeeds perf-staging server resolves both upstreams and preserves path plus query', () => {
  const config = readRequiredTemplate(tlsPath, 'aifeeds perf-staging server');

  assert.equal(
    occurrences(config, /proxy_pass\s+https:\/\/\$aifeeds_(?:worker|pages)_host\$request_uri;/g),
    3,
  );
  assert.doesNotMatch(
    config,
    /proxy_pass\s+https:\/\/(?:xlist-dashboard-perf\.pages\.dev|staging-api\.ai-feeds\.com)/,
  );
  assert.doesNotMatch(config, /proxy_pass\s+https:\/\/\$aifeeds_(?:worker|pages)_host\/?;/);
  assert.doesNotMatch(
    config,
    /xlist-api-staging\.ltsms86\.workers\.dev/,
    'the workers.dev deployment identity is not the routed staging API origin',
  );

  for (const upstream of ['worker', 'pages']) {
    assert.match(
      config,
      new RegExp(`proxy_set_header\\s+Host\\s+\\$aifeeds_${upstream}_host;`),
    );
    assert.match(
      config,
      new RegExp(`proxy_ssl_name\\s+\\$aifeeds_${upstream}_host;`),
    );
  }
  assert.equal(occurrences(config, /proxy_ssl_server_name\s+on;/g), 3);
});

test('aifeeds perf-staging API and SEO routes precede SPA without a secret', () => {
  const config = readRequiredTemplate(tlsPath, 'aifeeds perf-staging server');
  const tlsServerStart = config.indexOf('listen 443 ssl http2;');
  const apiLocation = config.indexOf('location ^~ /api/', tlsServerStart);
  const seoRoute = config.indexOf('location ~ ^/(daily', apiLocation);
  const spaLocation = config.indexOf('location /', seoRoute);

  assert.ok(tlsServerStart >= 0, 'TLS server must exist');
  assert.ok(apiLocation > tlsServerStart, 'API location must be inside the TLS server');
  assert.ok(seoRoute > apiLocation, 'SEO location must appear after API and before SPA');
  assert.ok(spaLocation > seoRoute, 'API and SEO locations must appear before SPA');

  for (const required of [
    'root /var/www/aifeeds-certbot;',
    'proxy_set_header X-Forwarded-Host staging-api.ai-feeds.com;',
    'proxy_set_header X-Forwarded-Proto $scheme;',
    'proxy_set_header X-Forwarded-For $remote_addr;',
    'proxy_set_header X-Request-Id $request_id;',
    'proxy_set_header Cookie $http_cookie;',
    'proxy_set_header Authorization $http_authorization;',
    'proxy_pass_request_headers on;',
    'proxy_pass_header Set-Cookie;',
    'proxy_pass_header Server-Timing;',
    'proxy_pass_header X-Request-Id;',
  ]) {
    assert.ok(config.includes(required), `API contract missing: ${required}`);
  }

  const workerRoutes = config.slice(apiLocation, spaLocation);
  assert.doesNotMatch(workerRoutes, /X-Origin-Secret|api[_-]?token/i);
  assert.doesNotMatch(config, /__ORIGIN_SECRET__/);
});

test('SEO regex routes only authoritative public paths to the staging Worker', () => {
  const config = readRequiredTemplate(tlsPath, 'aifeeds perf-staging server');
  const seo = seoLocation(config);

  assert.equal(
    seo.patternSource,
    '^/(daily(/.*)?|i/.*|robots\\.txt|sitemap\\.xml|sitemap-[a-z0-9-]+\\.xml|llms\\.txt)$',
  );

  for (const pathname of [
    '/daily',
    '/daily/',
    '/daily/2026-07-12',
    '/i/x/123',
    '/i/gh/owner/repo',
    '/robots.txt',
    '/sitemap.xml',
    '/sitemap-daily.xml',
    '/sitemap-hf-paper-2.xml',
    '/llms.txt',
  ]) {
    assert.equal(seo.pattern.test(pathname), true, `SEO route must match ${pathname}`);
  }

  for (const pathname of [
    '/i',
    '/api/items',
    '/dailyish',
    '/sitemap-.xml',
    '/sitemap-NEWS.xml',
    '/indexnow-key.txt',
    '/assets/index.js',
  ]) {
    assert.equal(seo.pattern.test(pathname), false, `SEO route must leave ${pathname} to SPA/API`);
  }
  assert.doesNotMatch(seo.patternSource, /INDEXNOW|<[^>]+>/i);
  assert.doesNotMatch(config, /location\s+(?:(?:=|\^~)\s+)?\/i(?:\s|\{)/);

  for (const required of [
    'set $aifeeds_worker_host staging-api.ai-feeds.com;',
    'proxy_pass https://$aifeeds_worker_host$request_uri;',
    'proxy_set_header Host $aifeeds_worker_host;',
    'proxy_ssl_server_name on;',
    'proxy_ssl_name $aifeeds_worker_host;',
    'proxy_set_header X-Forwarded-Host staging-api.ai-feeds.com;',
    'proxy_set_header X-Forwarded-Proto $scheme;',
    'proxy_set_header X-Forwarded-For $remote_addr;',
    'proxy_set_header X-Request-Id $request_id;',
    'proxy_set_header Cookie $http_cookie;',
    'proxy_set_header Authorization $http_authorization;',
    'proxy_pass_request_headers on;',
    'proxy_pass_header Set-Cookie;',
    'proxy_pass_header Server-Timing;',
    'proxy_pass_header X-Request-Id;',
    'proxy_cache off;',
    'proxy_no_cache 1;',
    'proxy_cache_bypass 1;',
    'proxy_redirect off;',
  ]) {
    assert.ok(seo.block.includes(required), `SEO Worker contract missing: ${required}`);
  }
});

test('aifeeds perf-staging server cannot inherit an nginx response cache', () => {
  const config = readRequiredTemplate(tlsPath, 'aifeeds perf-staging server');

  assert.equal(occurrences(config, /proxy_cache\s+off;/g), 3);
  assert.equal(occurrences(config, /proxy_no_cache\s+1;/g), 3);
  assert.equal(occurrences(config, /proxy_cache_bypass\s+1;/g), 3);
  assert.doesNotMatch(config, /proxy_cache_path|proxy_cache_valid|fastcgi_cache/i);
});

test('aifeeds perf-staging verifies both TLS upstreams and protects request credentials', () => {
  const config = readRequiredTemplate(tlsPath, 'aifeeds perf-staging server');

  assert.equal(occurrences(config, /proxy_ssl_verify\s+on;/g), 1);
  assert.equal(
    occurrences(config, /proxy_ssl_trusted_certificate\s+\/etc\/ssl\/certs\/ca-certificates\.crt;/g),
    1,
  );
  assert.equal(occurrences(config, /proxy_ssl_verify_depth\s+2;/g), 1);

  const spaStart = config.lastIndexOf('    location / {');
  const spaEnd = config.indexOf('\n    }', spaStart);
  assert.ok(spaStart >= 0 && spaEnd > spaStart, 'SPA location must be extractable');
  const spa = config.slice(spaStart, spaEnd);
  assert.match(spa, /proxy_set_header\s+Cookie\s+"";/);
  assert.match(spa, /proxy_set_header\s+Authorization\s+"";/);
  assert.match(spa, /proxy_set_header\s+X-Origin-Secret\s+"";/);
  assert.match(spa, /proxy_set_header\s+X-Dev-Token\s+"";/);
  assert.match(spa, /proxy_set_header\s+CF-Access-Client-Id\s+"";/);
  assert.match(spa, /proxy_set_header\s+CF-Access-Client-Secret\s+"";/);
  assert.doesNotMatch(spa, /\$http_cookie|\$http_authorization/);
});

test('aifeeds perf-staging accepts the documented five MiB feedback upload', () => {
  const config = readRequiredTemplate(tlsPath, 'aifeeds perf-staging server');
  const apiStart = config.indexOf('location ^~ /api/');
  const apiEnd = config.indexOf('\n    }', apiStart);
  assert.ok(apiStart >= 0 && apiEnd > apiStart, 'API location must be extractable');
  const api = config.slice(apiStart, apiEnd);

  assert.match(api, /client_max_body_size\s+6m;/);
});
