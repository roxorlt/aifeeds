import { describe, expect, test, vi } from 'vitest';

import type { Env } from '../index';
import {
  MANUAL_LEAD_COVER_HTML_MAX_BYTES,
  backfillManualLeadCover,
  ensureManualLeadCover,
  manualLeadCoverCandidates,
  normalizeManualLeadCoverCandidate,
  resolveManualLeadCover,
} from './manual-lead-cover';

const TWEET_URL = 'https://x.com/openai/status/1234567890123456789';

function htmlResponse(html: string, init: { type?: string; status?: number } = {}): Response {
  return new Response(html, {
    status: init.status ?? 200,
    headers: { 'content-type': init.type ?? 'text/html; charset=utf-8' },
  }) as unknown as Response;
}

/** 只回一页 HTML 的假 fetcher。 */
function pageFetcher(html: string, init: { type?: string; status?: number } = {}) {
  return vi.fn(async () => htmlResponse(html, init));
}

/** 迁 R2 的假实现：按传进来的 URL 决定成功或失败，并记下每次调用。 */
function fakeMigrate(map: (url: string) => string | null) {
  const calls: string[] = [];
  const migrate = vi.fn(async (_env: Env, url: string) => {
    calls.push(url);
    return map(url);
  });
  return { migrate, calls };
}

const ENV = {} as unknown as Env;

describe('normalizeManualLeadCoverCandidate', () => {
  test('相对路径按最终页面地址解析成绝对地址', () => {
    expect(normalizeManualLeadCoverCandidate('/img/hero.jpg', 'https://example.com/post/a'))
      .toBe('https://example.com/img/hero.jpg');
  });

  test('data: 与 .svg 一律不当封面', () => {
    expect(normalizeManualLeadCoverCandidate('data:image/png;base64,AAAA', 'https://example.com/a')).toBeNull();
    expect(normalizeManualLeadCoverCandidate('https://example.com/brand.svg', 'https://example.com/a')).toBeNull();
  });

  test('黑名单关键词（二维码 / logo / 头像）不当封面', () => {
    expect(normalizeManualLeadCoverCandidate('https://example.com/qrcode_x.jpg', 'https://example.com/a')).toBeNull();
    expect(normalizeManualLeadCoverCandidate('https://example.com/site-logo.png', 'https://example.com/a')).toBeNull();
    expect(normalizeManualLeadCoverCandidate('https://example.com/avatar.png', 'https://example.com/a')).toBeNull();
  });

  test('非 http(s) 与内网地址被挡在外面', () => {
    expect(normalizeManualLeadCoverCandidate('ftp://example.com/a.jpg', 'https://example.com/a')).toBeNull();
    expect(normalizeManualLeadCoverCandidate('http://127.0.0.1/a.jpg', 'https://example.com/a')).toBeNull();
  });

  test('查询串里的 &amp; 还原回 &，不拼出死链', () => {
    expect(normalizeManualLeadCoverCandidate(
      'https://example.com/a.jpg?w=1&amp;h=2', 'https://example.com/a',
    )).toBe('https://example.com/a.jpg?w=1&h=2');
  });
});

describe('manualLeadCoverCandidates', () => {
  test('og:image 排在 twitter:image 前面', () => {
    const html = `<meta name="twitter:image" content="https://example.com/tw.jpg">
      <meta property="og:image" content="https://example.com/og.jpg">`;
    expect(manualLeadCoverCandidates(html, 'https://example.com/post')).toEqual([
      { url: 'https://example.com/og.jpg', source: 'og' },
      { url: 'https://example.com/tw.jpg', source: 'twitter' },
    ]);
  });

  test('微信文章无 og 时取 msg_cdn_url，再退到正文第一张 data-src', () => {
    const html = `<script>var msg_cdn_url = "https://mmbiz.qpic.cn/mmbiz_jpg/cover/0?wx_fmt=jpeg";</script>
      <img data-src="https://mmbiz.qpic.cn/mmbiz_png/body/0?wx_fmt=png">`;
    expect(manualLeadCoverCandidates(html, 'https://mp.weixin.qq.com/s/AbCdEfGhIjKlMn')).toEqual([
      { url: 'https://mmbiz.qpic.cn/mmbiz_jpg/cover/0?wx_fmt=jpeg', source: 'wechat' },
      { url: 'https://mmbiz.qpic.cn/mmbiz_png/body/0?wx_fmt=png', source: 'wechat' },
    ]);
  });

  test('msg_cdn_url 只在微信域生效，别的站不认这个变量', () => {
    const html = '<script>var msg_cdn_url = "https://example.com/cover.jpg";</script>';
    expect(manualLeadCoverCandidates(html, 'https://example.com/post')).toEqual([]);
  });

  test('通用兜底只认自己声明 width/height 都 ≥300 的正文图', () => {
    const html = `<img src="https://example.com/small.jpg" width="120" height="120">
      <img src="https://example.com/hero.jpg" width="1200" height="630">`;
    expect(manualLeadCoverCandidates(html, 'https://example.com/post')).toEqual([
      { url: 'https://example.com/hero.jpg', source: 'body' },
    ]);
  });
});

describe('resolveManualLeadCover — 网页', () => {
  test('og:image 取到并迁进 R2', async () => {
    const { migrate, calls } = fakeMigrate(() => '/r/blog/abc.jpg');
    const result = await resolveManualLeadCover(ENV, { url: 'https://techcrunch.com/2026/09/16/a/' }, {
      fetcher: pageFetcher('<meta property="og:image" content="https://tc.com/hero.jpg">'),
      migrate,
    });
    expect(result).toEqual({ cover: '/r/blog/abc.jpg', source: 'og' });
    expect(calls).toEqual(['https://tc.com/hero.jpg']);
  });

  test('相对路径的 og:image 按页面地址解析后再迁', async () => {
    const { migrate, calls } = fakeMigrate(() => '/r/blog/rel.jpg');
    const result = await resolveManualLeadCover(ENV, { url: 'https://example.com/post/a' }, {
      fetcher: pageFetcher('<meta property="og:image" content="/img/hero.jpg">'),
      migrate,
    });
    expect(result.cover).toBe('/r/blog/rel.jpg');
    expect(calls).toEqual(['https://example.com/img/hero.jpg']);
  });

  test('黑名单 / svg 的候选直接跳过，取下一个合格的', async () => {
    const { migrate, calls } = fakeMigrate(() => '/r/blog/tw.jpg');
    const result = await resolveManualLeadCover(ENV, { url: 'https://example.com/post' }, {
      fetcher: pageFetcher(`<meta property="og:image" content="https://example.com/site-logo.svg">
        <meta name="twitter:image" content="https://example.com/hero.jpg">`),
      migrate,
    });
    expect(result).toEqual({ cover: '/r/blog/tw.jpg', source: 'twitter' });
    expect(calls).toEqual(['https://example.com/hero.jpg']);
  });

  test('最多试三个候选就收手', async () => {
    const { migrate, calls } = fakeMigrate(() => null);
    const html = `<meta property="og:image" content="https://example.com/a.jpg">
      <meta property="og:image:secure_url" content="https://example.com/b.jpg">
      <meta name="twitter:image" content="https://example.com/c.jpg">
      <img src="https://example.com/d.jpg" width="900" height="600">`;
    const result = await resolveManualLeadCover(ENV, { url: 'https://example.com/post' }, {
      fetcher: pageFetcher(html), migrate,
    });
    expect(result).toEqual({ cover: null, source: null, reason: 'all_candidates_rejected' });
    expect(calls).toHaveLength(3);
  });

  test('页面里一个候选都没有 → no_candidates', async () => {
    const result = await resolveManualLeadCover(ENV, { url: 'https://example.com/post' }, {
      fetcher: pageFetcher('<p>没有图</p>'), migrate: fakeMigrate(() => '/r/blog/x.jpg').migrate,
    });
    expect(result.reason).toBe('no_candidates');
  });

  test('返回的不是 HTML → not_html', async () => {
    const result = await resolveManualLeadCover(ENV, { url: 'https://example.com/a.pdf' }, {
      fetcher: pageFetcher('%PDF-1.7', { type: 'application/pdf' }),
    });
    expect(result).toEqual({ cover: null, source: null, reason: 'not_html' });
  });

  test('HTTP 错误码带进 reason', async () => {
    const result = await resolveManualLeadCover(ENV, { url: 'https://example.com/post' }, {
      fetcher: pageFetcher('', { status: 403 }),
    });
    expect(result.reason).toBe('fetch_failed:403');
  });

  test('fetch 抛异常也只回一个短码，不往外抛', async () => {
    const result = await resolveManualLeadCover(ENV, { url: 'https://example.com/post' }, {
      fetcher: vi.fn(async () => { throw new Error('boom'); }),
    });
    expect(result.reason).toBe('fetch_failed:error');
  });

  test('超大页面（微信实测 3.4MB）不按总大小拒，读前 512KB 就够取到 og', async () => {
    const head = '<meta property="og:image" content="https://mmbiz.qpic.cn/cover.jpg">';
    const huge = `${head}${'<p>正文</p>'.repeat(400_000)}`;
    expect(huge.length).toBeGreaterThan(MANUAL_LEAD_COVER_HTML_MAX_BYTES * 2);
    const { migrate } = fakeMigrate(() => '/r/blog/wx.jpg');
    const result = await resolveManualLeadCover(ENV, { url: 'https://mp.weixin.qq.com/s/AbCdEfGhIjKlMn' }, {
      fetcher: pageFetcher(huge), migrate,
    });
    expect(result).toEqual({ cover: '/r/blog/wx.jpg', source: 'og' });
  });

  test('空链接不外呼', async () => {
    const fetcher = pageFetcher('<meta property="og:image" content="https://example.com/a.jpg">');
    expect(await resolveManualLeadCover(ENV, { url: '  ' }, { fetcher }))
      .toEqual({ cover: null, source: null, reason: 'no_url' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('resolveManualLeadCover — 推文', () => {
  test('第一张迁失败就试第二张，pbs 链接补上大图参数', async () => {
    const { migrate, calls } = fakeMigrate((url) => (url.includes('BBB') ? '/r/blog/b.jpg' : null));
    const fetchTweet = vi.fn(async () => ({
      images: ['https://pbs.twimg.com/media/AAA.jpg', 'https://pbs.twimg.com/media/BBB.jpg'],
    }));
    const result = await resolveManualLeadCover(ENV, { url: TWEET_URL }, { fetchTweet, migrate });
    expect(result).toEqual({ cover: '/r/blog/b.jpg', source: 'tweet' });
    expect(calls).toEqual([
      'https://pbs.twimg.com/media/AAA.jpg?format=jpg&name=large',
      'https://pbs.twimg.com/media/BBB.jpg?format=jpg&name=large',
    ]);
  });

  test('已经带 format/name 的链接原样不动', async () => {
    const { migrate, calls } = fakeMigrate(() => '/r/blog/a.jpg');
    await resolveManualLeadCover(ENV, { url: TWEET_URL }, {
      fetchTweet: vi.fn(async () => ({ images: ['https://pbs.twimg.com/media/AAA?format=png&name=orig'] })),
      migrate,
    });
    expect(calls).toEqual(['https://pbs.twimg.com/media/AAA?format=png&name=orig']);
  });

  test('推文没有图 → tweet_no_images', async () => {
    const result = await resolveManualLeadCover(ENV, { url: TWEET_URL }, {
      fetchTweet: vi.fn(async () => ({ images: [] })),
    });
    expect(result).toEqual({ cover: null, source: null, reason: 'tweet_no_images' });
  });

  test('取证网关出错 → tweet_fetch_failed，不往外抛', async () => {
    const result = await resolveManualLeadCover(ENV, { url: TWEET_URL }, {
      fetchTweet: vi.fn(async () => { throw new Error('tweet_evidence:tweet_not_found'); }),
    });
    expect(result).toEqual({ cover: null, source: null, reason: 'tweet_fetch_failed' });
  });

  test('推文链接绝不走网页抓取那条路', async () => {
    const fetcher = pageFetcher('<meta property="og:image" content="https://example.com/a.jpg">');
    await resolveManualLeadCover(ENV, { url: TWEET_URL }, {
      fetcher, fetchTweet: vi.fn(async () => ({ images: [] })),
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

interface FakeCall { sql: string; binds: unknown[] }

/** 记下每条 SQL 与绑定参数的假 D1。`rows` 按 SQL 注释标记分派。 */
function fakeDb(rows: {
  item?: { url: string | null; extra: string | null } | null;
  scan?: Array<{ id: string }>;
  remaining?: number;
}) {
  const calls: FakeCall[] = [];
  const statement = (sql: string, binds: unknown[]) => ({
    first: async () => {
      if (sql.includes('cover_row')) return rows.item ?? null;
      if (sql.includes('cover_backfill_remaining')) return { c: rows.remaining ?? 0 };
      return null;
    },
    all: async () => ({ results: sql.includes('cover_backfill_scan') ? (rows.scan || []) : [] }),
    run: async () => ({ success: true }),
  });
  const DB = {
    prepare: (sql: string) => ({
      bind: (...binds: unknown[]) => {
        calls.push({ sql, binds });
        return statement(sql, binds);
      },
    }),
  };
  return { env: { DB } as unknown as Env, calls };
}

describe('ensureManualLeadCover', () => {
  const ITEM = 'blog:manual:ml-20260916-abc123def456';

  test('已经有站内封面就跳过，绝不覆盖', async () => {
    const { env, calls } = fakeDb({
      item: { url: 'https://example.com/a', extra: JSON.stringify({ cover_image: '/r/blog/old.jpg' }) },
    });
    const migrate = vi.fn(async () => '/r/blog/new.jpg');
    expect(await ensureManualLeadCover(env, ITEM, { migrate }))
      .toEqual({ status: 'skipped', reason: 'already', cover: '/r/blog/old.jpg' });
    expect(migrate).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  test('外链形态的旧 cover_image 不算数，照样重取', async () => {
    const { env, calls } = fakeDb({
      item: { url: 'https://example.com/post', extra: JSON.stringify({ cover_image: 'https://cdn/x.jpg' }) },
    });
    const result = await ensureManualLeadCover(env, ITEM, {
      fetcher: pageFetcher('<meta property="og:image" content="https://example.com/hero.jpg">'),
      migrate: vi.fn(async () => '/r/blog/hero.jpg'),
    });
    expect(result).toEqual({ status: 'set', cover: '/r/blog/hero.jpg', reason: 'og' });
    const update = calls[1];
    expect(update.sql).toContain('cover_set');
    expect(update.sql).toContain("NOT LIKE '/r/%'");
    expect(update.binds).toEqual(['/r/blog/hero.jpg', 'og', expect.any(String), ITEM]);
    // 签名覆盖的列与键一个都不能出现在写库语句里。
    expect(update.sql).not.toMatch(/\b(title|content|content_translated|author|url|published_at|media)\s*=/);
    expect(update.sql).not.toContain('event_fingerprint');
    expect(update.sql).not.toContain('$.manual_lead');
    expect(update.sql).not.toContain('$.manual_source_support');
  });

  test('条目没有链接 → 跳过', async () => {
    const { env } = fakeDb({ item: { url: '', extra: '{}' } });
    expect(await ensureManualLeadCover(env, ITEM)).toEqual({ status: 'skipped', reason: 'no_url' });
  });

  test('条目不存在 → 跳过', async () => {
    const { env } = fakeDb({ item: null });
    expect(await ensureManualLeadCover(env, ITEM)).toEqual({ status: 'skipped', reason: 'not_found' });
  });

  test('连试三次且上次尝试在 24h 内 → 不再试', async () => {
    const now = Date.parse('2026-09-16T10:00:00Z');
    const { env, calls } = fakeDb({
      item: {
        url: 'https://example.com/post',
        extra: JSON.stringify({ cover_attempts: 3, cover_last_attempt_at: '2026-09-16T02:00:00Z' }),
      },
    });
    expect(await ensureManualLeadCover(env, ITEM, { now }))
      .toEqual({ status: 'skipped', reason: 'attempts' });
    expect(calls).toHaveLength(1);
  });

  test('上次尝试已超 24h → 再试一次', async () => {
    const now = Date.parse('2026-09-16T10:00:00Z');
    const { env } = fakeDb({
      item: {
        url: 'https://example.com/post',
        extra: JSON.stringify({ cover_attempts: 5, cover_last_attempt_at: '2026-09-14T02:00:00Z' }),
      },
    });
    const result = await ensureManualLeadCover(env, ITEM, {
      now,
      fetcher: pageFetcher('<meta property="og:image" content="https://example.com/hero.jpg">'),
      migrate: vi.fn(async () => '/r/blog/hero.jpg'),
    });
    expect(result.status).toBe('set');
  });

  test('force=1 无视次数上限', async () => {
    const now = Date.parse('2026-09-16T10:00:00Z');
    const { env } = fakeDb({
      item: {
        url: 'https://example.com/post',
        extra: JSON.stringify({ cover_attempts: 9, cover_last_attempt_at: '2026-09-16T09:00:00Z' }),
      },
    });
    const result = await ensureManualLeadCover(env, ITEM, {
      now, force: true,
      fetcher: pageFetcher('<meta property="og:image" content="https://example.com/hero.jpg">'),
      migrate: vi.fn(async () => '/r/blog/hero.jpg'),
    });
    expect(result.status).toBe('set');
  });

  test('取不到时记一次失败计数与原因', async () => {
    const now = Date.parse('2026-09-16T10:00:00Z');
    const { env, calls } = fakeDb({
      item: { url: 'https://example.com/post', extra: JSON.stringify({ cover_attempts: 1 }) },
    });
    const result = await ensureManualLeadCover(env, ITEM, {
      now, fetcher: pageFetcher('<p>没有图</p>'),
    });
    expect(result).toEqual({ status: 'failed', reason: 'no_candidates', cover: null });
    const update = calls[1];
    expect(update.sql).toContain('cover_attempt');
    expect(update.binds).toEqual([2, 'no_candidates', new Date(now).toISOString(), ITEM]);
  });

  test('读库出故障也不往外抛', async () => {
    const env = {
      DB: { prepare: () => { throw new Error('d1 down'); } },
    } as unknown as Env;
    expect(await ensureManualLeadCover(env, ITEM)).toEqual({ status: 'failed', reason: 'exception' });
  });
});

describe('backfillManualLeadCover', () => {
  function scanRows(count: number): Array<{ id: string }> {
    return Array.from({ length: count }, (_, index) => ({ id: `blog:manual:ml-20260916-${index}` }));
  }

  test('dry=1 零外呼零写，只报命中条数', async () => {
    const { env, calls } = fakeDb({ scan: scanRows(4), remaining: 4 });
    const fetcher = pageFetcher('<meta property="og:image" content="https://example.com/a.jpg">');
    const stats = await backfillManualLeadCover(env, { date: '2026-09-16', dry: true }, { fetcher });
    expect(stats).toMatchObject({ scanned: 4, set: 0, skipped: 4, failed: 0, remaining: 4 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(calls.every((call) => !call.sql.includes('cover_row'))).toBe(true);
  });

  test('按 review_date 的区间选行，days 往前推', async () => {
    const { env, calls } = fakeDb({ scan: [], remaining: 0 });
    await backfillManualLeadCover(env, { date: '2026-09-16', days: 3, limit: 7 });
    const scan = calls.find((call) => call.sql.includes('cover_backfill_scan'))!;
    expect(scan.sql).toContain("i.id = 'blog:manual:' || l.id");
    expect(scan.sql).toContain("NOT LIKE '/r/%'");
    expect(scan.binds.slice(0, 2)).toEqual(['2026-09-14', '2026-09-16']);
    expect(scan.binds[scan.binds.length - 1]).toBe(7);
  });

  test('limit 封顶 50，days 封顶 14', async () => {
    const { env, calls } = fakeDb({ scan: [], remaining: 0 });
    await backfillManualLeadCover(env, { date: '2026-09-16', days: 99, limit: 999 });
    const scan = calls.find((call) => call.sql.includes('cover_backfill_scan'))!;
    expect(scan.binds[0]).toBe('2026-09-03');
    expect(scan.binds[scan.binds.length - 1]).toBe(50);
  });

  test('force=1 时扫描不再排除已经试满三次的行', async () => {
    const { env, calls } = fakeDb({ scan: [], remaining: 0 });
    await backfillManualLeadCover(env, { date: '2026-09-16', force: true });
    const scan = calls.find((call) => call.sql.includes('cover_backfill_scan'))!;
    expect(scan.sql).not.toContain('cover_attempts');
  });

  test('并发不超过上限', async () => {
    const { env } = fakeDb({
      scan: scanRows(6), remaining: 0,
      item: { url: 'https://example.com/post', extra: '{}' },
    });
    let inFlight = 0;
    let peak = 0;
    const fetcher = vi.fn(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      inFlight -= 1;
      return htmlResponse('<meta property="og:image" content="https://example.com/a.jpg">');
    });
    const stats = await backfillManualLeadCover(env, { date: '2026-09-16', concurrency: 2 }, {
      fetcher, migrate: vi.fn(async () => '/r/blog/a.jpg'),
    });
    expect(peak).toBeLessThanOrEqual(2);
    expect(stats).toMatchObject({ scanned: 6, set: 6, failed: 0 });
    expect(stats.items).toHaveLength(6);
  });

  test('总预算用完就停，剩下的下一轮再说', async () => {
    const { env } = fakeDb({
      scan: scanRows(5), remaining: 5,
      item: { url: 'https://example.com/post', extra: '{}' },
    });
    const start = Date.parse('2026-09-16T10:00:00Z');
    let ticks = 0;
    // 第一次取 now 是算 deadline，之后每取一次就走 40s —— 第二条处理完预算就见底。
    const now = () => start + (ticks++ > 1 ? 120_000 : 0);
    const stats = await backfillManualLeadCover(env, { date: '2026-09-16', now, concurrency: 1 }, {
      fetcher: pageFetcher('<meta property="og:image" content="https://example.com/a.jpg">'),
      migrate: vi.fn(async () => '/r/blog/a.jpg'),
    });
    expect(stats.scanned).toBe(5);
    expect(stats.set).toBeLessThan(5);
    expect(stats.remaining).toBe(5);
  });

  test('读库失败只回零统计，不往外抛', async () => {
    const env = { DB: { prepare: () => { throw new Error('d1 down'); } } } as unknown as Env;
    expect(await backfillManualLeadCover(env, { date: '2026-09-16' }))
      .toEqual({ scanned: 0, set: 0, skipped: 0, failed: 0, remaining: 0, items: [] });
  });
});
