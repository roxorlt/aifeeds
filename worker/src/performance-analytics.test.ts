import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import {
  PERFORMANCE_EVENT_TYPES,
  handleTrack,
  prepareEventPayload,
} from './track';
import {
  DASHBOARD_HTML,
  PERFORMANCE_ENGAGEMENT_EVENTS,
  performanceCohortWhere,
  shapePerformanceAnalyticsOutput,
} from './admin-dashboard';

const adminDashboardSource = fs.readFileSync(fileURLToPath(new URL('./admin-dashboard.ts', import.meta.url)), 'utf8');

describe('performance event ingest', () => {
  it('keeps all performance event contracts in the geography-enrichment set', () => {
    expect(PERFORMANCE_EVENT_TYPES).toContain('perf_lcp');
    expect(PERFORMANCE_EVENT_TYPES).toContain('perf_api');
    expect(PERFORMANCE_EVENT_TYPES).toContain('feed_ready');
  });

  it('overwrites untrusted edge fields with coarse request.cf country and colo only', () => {
    const prepared = prepareEventPayload(
      'perf_lcp',
      { client_field: 'kept', edge_country: 'US', edge_colo: 'SJC' },
      { country: 'CN', colo: 'HKG', city: 'Hong Kong', latitude: '22.3' },
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
          payload: { endpoint: 'items', edge_country: 'US', edge_colo: 'SJC' },
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
});

describe('load-performance cohorts', () => {
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
    const allClean = { overall: [{ metric: 'lcp', p75: 1000 }], slices: [{ client: 'other' }] };
    const engaged = { overall: [{ metric: 'lcp', p75: 900 }], slices: [] };
    const synthetic = { overall: [{ metric: 'lcp', p75: 300 }], slices: [] };
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

  it('keeps the rendered embedded dashboard script syntactically valid', () => {
    const scripts = [...DASHBOARD_HTML.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    const dashboardScript = scripts.map((match) => match[1]).find((source) => source.includes('function loadLoadPerf'));
    expect(dashboardScript).toBeTruthy();
    expect(() => new Function(dashboardScript!)).not.toThrow();
  });
});
