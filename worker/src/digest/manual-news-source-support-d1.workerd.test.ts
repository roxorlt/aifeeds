import { Log, LogLevel, Miniflare } from 'miniflare';
import { expect, test } from 'vitest';

test('D1 batch rolls back source-support writes when the final constraint gate fails', async () => {
  const miniflare = new Miniflare({
    modules: true,
    script: `
      export default { async fetch(_request, env) {
        await env.DB.exec(\`
          CREATE TABLE candidate_state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE final_audit (id INTEGER PRIMARY KEY, mutation_nonce TEXT NOT NULL);
        \`);
        let failed = false;
        try {
          await env.DB.batch([
            env.DB.prepare("INSERT INTO candidate_state (id, value) VALUES ('lead-1', 'written')"),
            env.DB.prepare('INSERT INTO final_audit (id, mutation_nonce) VALUES (1, NULL)'),
          ]);
        } catch { failed = true; }
        const candidate = await env.DB.prepare('SELECT COUNT(*) AS count FROM candidate_state').first();
        const audit = await env.DB.prepare('SELECT COUNT(*) AS count FROM final_audit').first();
        return Response.json({ failed, candidate_count: candidate.count, audit_count: audit.count });
      } };
    `,
    compatibilityDate: '2024-12-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'manual-news-source-support-atomicity' },
    log: new Log(LogLevel.NONE),
  });
  try {
    await miniflare.ready;
    const response = await miniflare.dispatchFetch('http://local.test/');
    expect(await response.json()).toEqual({
      failed: true,
      candidate_count: 0,
      audit_count: 0,
    });
  } finally {
    await miniflare.dispose();
  }
}, 15_000);
