import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { fileURLToPath, URL as NodeURL } from 'node:url';

import {
  PERFORMANCE_EVENT_TYPES,
  handleTrack,
  prepareEventPayload,
  sanitizeTelemetryPagePath,
  sanitizeTelemetryReferrer,
} from './track';
import {
  DASHBOARD_HTML,
  PERFORMANCE_ENGAGEMENT_EVENTS,
  metricLoadPerf,
  performanceCohortWhere,
  shapePerformanceAnalyticsOutput,
} from './admin-dashboard';

const adminDashboardSource = fs.readFileSync(
  fileURLToPath(new NodeURL('./admin-dashboard.ts', import.meta.url)),
  'utf8',
);

describe('performance event ingest', () => {
  it('keeps all performance event contracts in the geography-enrichment set', () => {
    expect(PERFORMANCE_EVENT_TYPES).toContain('perf_lcp');
    expect(PERFORMANCE_EVENT_TYPES).toContain('perf_api');
    expect(PERFORMANCE_EVENT_TYPES).toContain('feed_ready');
  });

  it('overwrites untrusted edge fields with coarse request.cf country and colo only', () => {
    const edgeProperties = { country: 'CN', colo: 'HKG', city: 'Hong Kong', latitude: '22.3' };
    const prepared = prepareEventPayload(
      'perf_lcp',
      { client_field: 'kept', edge_country: 'US', edge_colo: 'SJC' },
      edgeProperties,
    );
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || !prepared.value) throw new Error('missing payload');
    const payload = JSON.parse(prepared.value);
    expect(payload).toEqual({ client_field: 'kept', edge_country: 'CN', edge_colo: 'HKG' });
    expect(payload.city).toBeUndefined();
    expect(payload.latitude).toBeUndefined();
  });

  it('removes spoofed geography when request.cf has no trusted values', () => {
    const prepared = prepareEventPayload('perf_api', { edge_country: 'US', edge_colo: 'SJC' }, undefined);
    expect(prepared).toEqual({ ok: true, value: '{}' });
  });

  it('does not alter non-performance payloads and enforces size after enrichment', () => {
    expect(prepareEventPayload('item_click', { edge_country: 'client-value' }, { country: 'CN', colo: 'HKG' }))
      .toEqual({ ok: true, value: '{"edge_country":"client-value"}' });
    expect(prepareEventPayload('perf_nav', { content: 'x'.repeat(80) }, { country: 'CN', colo: 'HKG' }, 64))
      .toEqual({ ok: false, error: 'payload too large' });
  });

  it('normalizes untrusted performance nettype while preserving Network Information API enums', () => {
    const attack = '<img src=x onerror="globalThis.__adminXss=1">';
    const malicious = prepareEventPayload('perf_nav', { nettype: attack, load: 120 }, undefined);
    expect(malicious.ok).toBe(true);
    if (!malicious.ok || !malicious.value) throw new Error('missing malicious payload result');
    const payload = JSON.parse(malicious.value);
    expect(payload.nettype).not.toBe(attack);
    expect(payload.nettype === undefined || payload.nettype === 'unknown').toBe(true);

    for (const nettype of ['slow-2g', '2g', '3g', '4g']) {
      const prepared = prepareEventPayload('perf_nav', { nettype }, undefined);
      expect(prepared).toEqual({ ok: true, value: JSON.stringify({ nettype }) });
    }
    for (const nettype of ['4G', '', 4, { value: '4g' }]) {
      const prepared = prepareEventPayload('perf_nav', { nettype }, undefined);
      expect(prepared).toEqual({ ok: true, value: '{}' });
    }
  });

  it('handleTrack stores trusted coarse geography produced after validation', async () => {
    const bound: unknown[][] = [];
    const env = {
      ORIGIN_SECRET: '',
      DB: {
        prepare: () => ({
          bind: (...values: unknown[]) => {
            bound.push(values);
            return { values };
          },
        }),
        batch: async () => [],
      },
    };
    const request = new Request('https://api.ai-feeds.com/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': 'device-12345678' },
      body: JSON.stringify({
        events: [{
          type: 'perf_api',
          occurred_at: 1,
          payload: {
            endpoint: 'items',
            nettype: '<img src=x onerror="globalThis.__adminXss=1">',
            edge_country: 'US',
            edge_colo: 'SJC',
          },
        }],
      }),
    });
    Object.defineProperty(request, 'cf', { value: { country: 'CN', colo: 'HKG', city: 'private' } });

    const response = await handleTrack(request, env as never);
    expect(response.status).toBe(200);
    expect(JSON.parse(String(bound[0][3]))).toEqual({
      endpoint: 'items',
      edge_country: 'CN',
      edge_colo: 'HKG',
    });
  });

  it('strips query, hash, dynamic ids and raw referrers at the public ingest boundary', async () => {
    expect(sanitizeTelemetryPagePath('/search?q=alice%40example.com&token=secret#private')).toBe('/search');
    expect(sanitizeTelemetryPagePath('/t/private-item?from=user')).toBe('/t/:id');
    expect(sanitizeTelemetryPagePath('/reset/alice@example.com')).toBe('/:other');
    expect(sanitizeTelemetryReferrer('https://www.google.com/search?q=private')).toBe('search');
    expect(sanitizeTelemetryReferrer('https://notgoogle.com/private')).toBe('external');
    expect(sanitizeTelemetryReferrer('https://unknown.example/alice@example.com')).toBe('external');

    const bound: unknown[][] = [];
    const env = {
      ORIGIN_SECRET: '',
      DB: {
        prepare: () => ({
          bind: (...values: unknown[]) => {
            bound.push(values);
            return { values };
          },
        }),
        batch: async () => [],
      },
    };
    const request = new Request('https://api.ai-feeds.com/api/track', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': 'device-12345678',
        Referer: 'https://unknown.example/path?email=alice@example.com',
      },
      body: JSON.stringify({
        events: [{
          type: 'page_view',
          occurred_at: 1,
          page_path: '/search?q=alice%40example.com&token=secret',
          payload: { path: '/search?q=alice%40example.com&token=secret' },
        }],
      }),
    });

    const response = await handleTrack(request, env as never);
    expect(response.status).toBe(200);
    expect(JSON.parse(String(bound[0][3]))).toEqual({ path: '/search' });
    expect(bound[0][6]).toBe('external');
    expect(bound[0][7]).toBe('/search');
    expect(JSON.stringify(bound[0])).not.toMatch(/alice|secret|unknown\.example/);
  });

  it('sanitizes known sensitive payload fields even for untrusted telemetry clients', () => {
    const appOpen = prepareEventPayload('app_open', {
      utm_source: 'alice@example.com',
      utm_campaign: 'private-token',
      referrer: 'https://www.google.com/search?q=alice@example.com',
    }, undefined);
    expect(appOpen).toEqual({
      ok: true,
      value: JSON.stringify({ utm_source: 'other', utm_campaign: 'present', referrer: 'search' }),
    });

    const apiError = prepareEventPayload('api_error', {
      endpoint: '/api/items/private-id?token=private-token',
      error_msg: 'request failed for https://unknown.example/?email=alice@example.com',
      status: 0,
    }, undefined);
    expect(apiError).toEqual({
      ok: true,
      value: JSON.stringify({ endpoint: 'item_detail', error_msg: 'request_error', status: 0 }),
    });

    const search = prepareEventPayload('search_submit', {
      q: 'alice@example.com',
      q_len: 9_999,
      mode: 'grouped',
    }, undefined);
    expect(search).toEqual({
      ok: true,
      value: JSON.stringify({ q_len: 'alice@example.com'.length, mode: 'grouped' }),
    });
    expect(JSON.stringify([appOpen, apiError, search])).not.toMatch(/alice|private-token|unknown\.example/);
  });
});

describe('load-performance cohorts', () => {
  it('loads all cohorts with at most six real SQLite queries and preserves output contracts', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE events (
        device_id TEXT NOT NULL,
        user_id TEXT,
        session_token_hash TEXT,
        event_type TEXT NOT NULL,
        event_payload TEXT,
        page_path TEXT,
        occurred_at INTEGER NOT NULL
      );
      CREATE TABLE identities (user_id TEXT, identity_value TEXT, unbound_at INTEGER);
    `);
    const insert = db.prepare(`
      INSERT INTO events
        (device_id, user_id, session_token_hash, event_type, event_payload, page_path, occurred_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    const legacyAttackNettype = '<img src=x onerror="globalThis.__adminXss=1">';
    const addCohortDevice = (
      cohort: 'ordinary' | 'engaged' | 'synthetic',
      index: number,
      base: number,
    ) => {
      const device = `${cohort}-${index}`;
      const session = `session-${device}`;
      const synthetic = cohort === 'synthetic' ? { traffic_kind: 'synthetic' } : {};
      insert.run(device, session, 'perf_nav', JSON.stringify({
        ...synthetic,
        ttfb: base,
        response: base + 1,
        dom_interactive: base + 2,
        dcl: base + 3,
        load: base + 4,
        is_wechat: 1,
        nettype: cohort === 'ordinary' ? legacyAttackNettype : '4g',
      }), '/', now + index);
      insert.run(device, session, 'perf_fcp', JSON.stringify({ ...synthetic, value: base + 5 }), '/', now + index);
      insert.run(device, session, 'perf_lcp', JSON.stringify({ ...synthetic, value: base + 6 }), '/', now + index);
      if (cohort !== 'synthetic') {
        insert.run(device, session, 'perf_img', JSON.stringify({ ...synthetic, dur: base + 7 }), '/', now + index);
      }
      if (cohort === 'engaged') {
        insert.run(device, session, 'item_click', '{}', '/', now + index + 10);
      }
    };
    [100, 200, 300, 400].forEach((base, index) => addCohortDevice('engaged', index, base));
    [500, 600, 700, 800].forEach((base, index) => addCohortDevice('ordinary', index, base));
    [10, 20, 30, 40].forEach((base, index) => addCohortDevice('synthetic', index, base));

    let queryCount = 0;
    let activeQueries = 0;
    let maxActiveQueries = 0;
    const env = {
      DB: {
        prepare(sql: string) {
          const statement = db.prepare(sql);
          let bindings: SQLInputValue[] = [];
          const prepared = {
            bind(...values: SQLInputValue[]) {
              bindings = values;
              return prepared;
            },
            async all() {
              queryCount += 1;
              activeQueries += 1;
              maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
              await Promise.resolve();
              try {
                return { results: statement.all(...bindings) };
              } finally {
                activeQueries -= 1;
              }
            },
            async first() {
              queryCount += 1;
              activeQueries += 1;
              maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
              await Promise.resolve();
              try {
                return statement.get(...bindings);
              } finally {
                activeQueries -= 1;
              }
            },
          };
          return prepared;
        },
      },
    };

    const output = await metricLoadPerf(env as never);

    expect(queryCount).toBe(6);
    expect(maxActiveQueries).toBeLessThanOrEqual(2);
    expect(Object.keys(output)).toEqual(['all_clean', 'engaged', 'synthetic', 'overall', 'slices']);
    expect(output.overall).toBe(output.all_clean.overall);
    expect(output.slices).toBe(output.all_clean.slices);
    expect(output.all_clean.overall).toHaveLength(8);
    expect(output.engaged.overall).toHaveLength(8);
    expect(output.synthetic.overall).toHaveLength(8);
    expect(output.engaged.overall.find((row) => row.metric === 'ttfb')).toEqual({
      metric: 'ttfb', p50: 300, p75: 400, p95: 400, samples: 4,
    });
    expect(output.synthetic.overall.find((row) => row.metric === 'ttfb')).toEqual({
      metric: 'ttfb', p50: 30, p75: 40, p95: 40, samples: 4,
    });
    expect(output.synthetic.overall.find((row) => row.metric === 'img')).toEqual({
      metric: 'img', p50: null, p75: null, p95: null, samples: null,
    });
    expect(output.all_clean.slices).toEqual([
      { client: 'wechat', net: 'unknown', samples: 4, avg_load: 654, avg_ttfb: 650 },
      { client: 'wechat', net: '4g', samples: 4, avg_load: 254, avg_ttfb: 250 },
    ]);
    expect(JSON.stringify(output.all_clean.slices)).not.toContain(legacyAttackNettype);
    expect(output.engaged.slices).toEqual([{
      client: 'wechat', net: '4g', samples: 4, avg_load: 254, avg_ttfb: 250,
    }]);
    expect(output.synthetic.slices).toEqual([{
      client: 'wechat', net: '4g', samples: 4, avg_load: 29, avg_ttfb: 25,
    }]);
    db.close();
  });

  it('executes cohort SQL with two-valued marker logic on real SQLite rows', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE events (
        device_id TEXT NOT NULL,
        user_id TEXT,
        session_token_hash TEXT,
        event_type TEXT NOT NULL,
        event_payload TEXT,
        page_path TEXT,
        occurred_at INTEGER NOT NULL
      );
      CREATE TABLE identities (user_id TEXT, identity_value TEXT, unbound_at INTEGER);
    `);
    const insert = db.prepare(`
      INSERT INTO events
        (device_id, user_id, session_token_hash, event_type, event_payload, page_path, occurred_at)
      VALUES (?, NULL, ?, ?, ?, ?, ?)
    `);
    const perf = (device: string, payload: string, path: string, at: number) =>
      insert.run(device, `session-${device}`, 'perf_lcp', payload, path, at);
    const action = (device: string, type: string, at: number) =>
      insert.run(device, `session-${device}`, type, '{}', '/', at);

    perf('ordinary', '{}', '/', 1_000);
    perf('engaged', '{}', '/', 2_000);
    action('engaged', 'item_click', 2_100);
    perf('impression_only', '{}', '/', 3_000);
    action('impression_only', 'item_impression', 3_100);
    perf('probe_payload', '{"traffic_kind":"synthetic"}', '/', 4_000);
    perf('probe_path', '{}', '/?codex_perf_probe=1', 5_000);
    perf('XVsq80drDCUOo3CSXJbrm', '{}', '/', 6_000);
    action('XVsq80drDCUOo3CSXJbrm', 'item_click', 6_100);

    const devicesFor = (cohort: 'all_clean' | 'engaged' | 'synthetic') =>
      db.prepare(`
        SELECT e.device_id FROM events e
        WHERE e.event_type='perf_lcp' AND ${performanceCohortWhere(cohort, 'e')}
        ORDER BY e.device_id
      `).all().map((row) => String(row.device_id));

    expect(devicesFor('all_clean')).toEqual(['engaged', 'impression_only', 'ordinary']);
    expect(devicesFor('engaged')).toEqual(['engaged']);
    expect(devicesFor('synthetic')).toEqual(['probe_path', 'probe_payload']);
    db.close();
  });

  it('uses explicit synthetic markers and excludes owner traffic from all_clean', () => {
    const sql = performanceCohortWhere('all_clean', 'p');
    expect(sql).toContain('p.device_id NOT IN');
    expect(sql).toContain("$.traffic_kind");
    expect(sql).toContain('codex_perf_probe');
    expect(sql).toContain('NOT');
    expect(sql).not.toContain('MAX(occurred_at) - MIN(occurred_at)');
  });

  it('defines engaged by explicit actions in the same device/session window', () => {
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).toContain('item_click');
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).toContain('item_open_drawer');
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).toContain('source_filter_change');
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).toContain('sort_change');
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).toContain('search_submit');
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).toContain('search_result_click');
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).toContain('share_click');
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).toContain('login_success');
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).not.toContain('item_impression');
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).not.toContain('video_play_start');
    expect(PERFORMANCE_ENGAGEMENT_EVENTS).not.toContain('video_effective_play');

    const sql = performanceCohortWhere('engaged', 'p');
    expect(sql).toContain('action.device_id = p.device_id');
    expect(sql).toContain('action.session_token_hash = p.session_token_hash');
    expect(sql).toContain('ABS(action.occurred_at - p.occurred_at)');
    expect(sql).not.toContain('item_impression');
  });

  it('synthetic cohort includes explicit probes only', () => {
    const sql = performanceCohortWhere('synthetic', 'p');
    expect(sql).toContain("json_extract(p.event_payload,'$.traffic_kind') = 'synthetic'");
    expect(sql).toContain("instr(COALESCE(p.page_path,''), 'codex_perf_probe') > 0");
    expect(sql).not.toContain('action.event_type');
    expect(sql).not.toContain('session_seconds');
  });

  it('returns named cohorts while retaining overall/slices compatibility aliases', () => {
    const row = (p75: number) => ({ metric: 'lcp', p50: p75, p75, p95: p75, samples: 1 });
    const allClean = { overall: [row(1000)], slices: [{ client: 'other' }] };
    const engaged = { overall: [row(900)], slices: [] };
    const synthetic = { overall: [row(300)], slices: [] };
    const output = shapePerformanceAnalyticsOutput(allClean, engaged, synthetic);
    expect(output).toEqual({
      all_clean: allClean,
      engaged,
      synthetic,
      overall: allClean.overall,
      slices: allClean.slices,
    });
  });

  it('exposes all cohorts in the embedded panel with a safe legacy-payload fallback', () => {
    for (const cohort of ['all_clean', 'engaged', 'synthetic']) {
      expect(adminDashboardSource).toContain(`data-perf-cohort="${cohort}"`);
    }
    expect(adminDashboardSource).toContain('function renderLoadPerfCohort');
    expect(adminDashboardSource).toContain('d.all_clean || legacyCohort');
    expect(adminDashboardSource).toContain('button.disabled = !cohorts[key]');
    expect(adminDashboardSource).toContain("renderLoadPerfCohort('all_clean')");
  });

  it('escapes the untrusted network slice label before assigning table innerHTML', () => {
    const attack = '<img src=x onerror="globalThis.__adminXss=1">';
    expect(adminDashboardSource).toContain("esc(r.net || 'unknown')");
    expect(adminDashboardSource).not.toContain("+ (r.net || 'unknown') +");

    const escSource = DASHBOARD_HTML.match(/function esc\(s\) \{[^\n]+\}/)?.[0];
    expect(escSource).toBeTruthy();
    const escapeHtml = new Function(`${escSource}; return esc;`)() as (value: string) => string;
    const rendered = escapeHtml(attack);
    expect(rendered).not.toContain('<img');
    expect(rendered).toContain('&lt;img');
    expect((globalThis as Record<string, unknown>).__adminXss).toBeUndefined();
  });

  it('keeps the rendered embedded dashboard script syntactically valid', () => {
    const scripts = [...DASHBOARD_HTML.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    const dashboardScript = scripts.map((match) => match[1]).find((source) => source.includes('function loadLoadPerf'));
    expect(dashboardScript).toBeTruthy();
    expect(() => new Function(dashboardScript!)).not.toThrow();
  });
});
