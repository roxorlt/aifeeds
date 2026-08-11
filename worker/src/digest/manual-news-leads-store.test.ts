import { describe, expect, test } from 'vitest';

import { retryManualNewsLead, submitManualNewsLead } from './manual-news-leads-store';

type LeadRow = Record<string, unknown>;

function fakeEnv() {
  const leads = new Map<string, LeadRow>();
  const statements: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) { binds = values; return stmt; },
        async first<T>() {
          if (sql.includes('manual_lead:by_submit_key')) {
            return [...leads.values()].find((row) => row.review_date === binds[0] && row.submit_idempotency_key === binds[1]) as T | undefined;
          }
          if (sql.includes('manual_lead:by_id')) return leads.get(String(binds[0])) as T | undefined;
          if (sql.includes('manual_evidence:list')) return null as T | null;
          if (sql.includes('manual_assessment:latest')) return null as T | null;
          return null as T | null;
        },
        async all<T>() {
          if (sql.includes('manual_evidence:list')) return { results: [] as T[] };
          return { results: [] as T[] };
        },
        async run() {
          statements.push({ sql, binds });
          if (sql.includes('manual_lead:insert')) {
            const [id, reviewDate, inputType, inputText, inputUrl, note, submitKey, now] = binds;
            leads.set(String(id), {
              id, review_date: reviewDate, input_type: inputType, input_text: inputText, input_url: inputUrl,
              note, status: 'submitted', version: 1, error_code: null, error_message: null,
              submit_idempotency_key: submitKey, last_mutation_kind: null, last_mutation_idempotency_key: null,
              confirmed_batch_id: null, confirmed_at: null, created_at: now, updated_at: now,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.includes('manual_lead:retry')) {
            const [key, now, id, expectedVersion] = binds;
            const row = leads.get(String(id));
            if (!row || row.version !== expectedVersion || !['failed', 'needs_review', 'rejected'].includes(String(row.status))) {
              return { success: true, meta: { changes: 0 } };
            }
            Object.assign(row, {
              status: 'validating', version: Number(row.version) + 1, error_code: null, error_message: null,
              last_mutation_kind: 'retry', last_mutation_idempotency_key: key, updated_at: now,
            });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { env: { DB: db } as never, leads, statements };
}

describe('manual lead D1 store', () => {
  test('submit is idempotent for a date and request key', async () => {
    const memory = fakeEnv();
    const first = await submitManualNewsLead(memory.env, {
      date: '2026-08-11', text: 'Anthropic 输出水印', note: '核验范围',
    }, 'submit-key-1', 100);
    const repeated = await submitManualNewsLead(memory.env, {
      date: '2026-08-11', text: 'different retry body',
    }, 'submit-key-1', 200);

    expect(first.created).toBe(true);
    expect(first.lead.id).toMatch(/^ml-20260811-[a-f0-9]{12}$/);
    expect(repeated).toMatchObject({ created: false, lead: { id: first.lead.id, input_text: 'Anthropic 输出水印' } });
    expect(memory.statements.filter((entry) => entry.sql.includes('manual_lead:insert'))).toHaveLength(1);
  });

  test('retry is idempotent and fails optimistic version conflicts without mutation', async () => {
    const memory = fakeEnv();
    const submitted = await submitManualNewsLead(memory.env, { date: '2026-08-11', text: '线索' }, 'submit-key-2', 100);
    Object.assign(memory.leads.get(submitted.lead.id)!, { status: 'failed', error_code: 'network', error_message: 'timeout' });

    const retried = await retryManualNewsLead(memory.env, submitted.lead.id, 1, 'retry-key-1', 200);
    expect(retried).toMatchObject({ ok: true, changed: true, lead: { status: 'validating', version: 2 } });
    const repeated = await retryManualNewsLead(memory.env, submitted.lead.id, 1, 'retry-key-1', 300);
    expect(repeated).toMatchObject({ ok: true, changed: false, lead: { version: 2 } });
    const conflict = await retryManualNewsLead(memory.env, submitted.lead.id, 1, 'retry-key-2', 400);
    expect(conflict).toMatchObject({ ok: false, status: 409, error: 'lead_version_conflict', lead: { version: 2 } });
  });

  test('does not retry a lead after it has been confirmed for a candidate pool', async () => {
    const memory = fakeEnv();
    const submitted = await submitManualNewsLead(memory.env, { date: '2026-08-11', text: '线索' }, 'submit-key-3', 100);
    Object.assign(memory.leads.get(submitted.lead.id)!, {
      status: 'needs_review', confirmed_at: 150, version: 4,
    });

    const result = await retryManualNewsLead(memory.env, submitted.lead.id, 4, 'retry-confirmed', 200);

    expect(result).toMatchObject({ ok: false, status: 409, error: 'lead_already_confirmed' });
    expect(memory.leads.get(submitted.lead.id)).toMatchObject({ status: 'needs_review', version: 4 });
  });
});
