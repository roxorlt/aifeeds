import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) { this.env = env; }
  },
}));
vi.mock('../auth/resend', () => ({ sendEmail: vi.fn() }));
vi.mock('./news-source-policy', () => ({ authorizeFormalNewsSet: vi.fn() }));

import type { Env } from '../index';
import { sendEmail } from '../auth/resend';
import { DigestDeliverWorkflow } from './deliver';
import { authorizeFormalNewsSet } from './news-source-policy';

function makeEnv(): Env {
  const item = {
    id: 'blog:openai:release', title: 'Release', content: 'Release content', content_translated: '发布内容',
    author: 'OpenAI', handle: null, url: 'https://openai.com/news/release', media: null,
    extra: JSON.stringify({ feed_id: 'blog:openai', feed_key: 'openai', title_zh: '正式发布' }),
  };
  const DB = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) { binds = values; return stmt; },
        async first<T>() {
          if (/FROM digest_send_log/i.test(sql)) return null as T | null;
          if (/FROM subscriptions/i.test(sql)) return {
            id: 7, email: 'reader@example.test', sources: '[]', send_slot: 8, density: 'normal',
            status: 'active', unsubscribe_token: 'unsubscribe-token',
          } as T;
          if (/source = '_subject'/i.test(sql)) return { items_meta: JSON.stringify({ subject: 'AI 日报' }) } as T;
          if (/FROM digest_pool/i.test(sql) && String(binds[1]) === 'news') {
            return { item_ids: JSON.stringify([item.id]), items_meta: null } as T;
          }
          return null as T | null;
        },
        async all<T>() {
          if (/FROM items/i.test(sql)) return { results: [item] as T[] };
          return { results: [] as T[] };
        },
        async run() { return { success: true }; },
      };
      return stmt;
    },
  };
  return {
    DB,
    API_BASE: 'https://api.test', SITE_BASE: 'https://site.test', AUTH_SECRET: 'test-secret',
  } as unknown as Env;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendEmail).mockResolvedValue({ ok: true, id: 'message-1' });
});

test('email final attempt reauthorizes and rebuilds after a valid collect becomes denied', async () => {
  let calls = 0;
  vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => {
    calls += 1;
    return {
      allowed_ids: calls === 1 ? [...ids] : [],
      decisions: ids.map((id) => ({
        item_id: id, allowed: calls === 1,
        code: calls === 1 ? 'ALLOW_SCHEDULED_FORMAL' as const : 'DENY_SOURCE_DISABLED' as const,
      })),
    };
  });
  const env = makeEnv();
  const workflow = new DigestDeliverWorkflow({} as never, env);
  const step = { do: async (_name: string, _options: unknown, fn: () => unknown) => fn() };

  const result = await workflow.run(
    { payload: { subId: 7, slotKey: '2026-08-27-08' } } as never,
    step as never,
  );

  expect(result).toEqual({ subId: 7, status: 'no_items' });
  expect(authorizeFormalNewsSet).toHaveBeenCalledTimes(2);
  expect(sendEmail).not.toHaveBeenCalled();
});

test('email refuses a mutation after the collect identity read and before the send boundary', async () => {
  let calls = 0;
  vi.mocked(authorizeFormalNewsSet).mockImplementation(async (_env, _date, ids) => {
    calls += 1;
    const allowed = calls <= 2;
    return {
      allowed_ids: allowed ? [...ids] : [],
      decisions: ids.map((id) => ({
        item_id: id,
        allowed,
        code: allowed ? 'ALLOW_SCHEDULED_FORMAL' as const : 'DENY_EXPLICIT_ITEM_RADAR' as const,
      })),
    };
  });
  const env = makeEnv();
  const workflow = new DigestDeliverWorkflow({} as never, env);
  const step = { do: async (_name: string, _options: unknown, fn: () => unknown) => fn() };

  const result = await workflow.run(
    { payload: { subId: 7, slotKey: '2026-08-27-08' } } as never,
    step as never,
  );

  expect(result).toEqual({ subId: 7, status: 'no_items' });
  expect(authorizeFormalNewsSet).toHaveBeenCalledTimes(3);
  expect(sendEmail).not.toHaveBeenCalled();
});
