import { describe, test, expect } from 'vitest';
import { runBlogBodyRedecode } from './blog-body-redecode';
import type { Env } from '../index';

// Task 1 数据回填（2026-07-06）：扫 body_markdown/body_markdown_zh 含结构标签泄漏（字面
// <p> / <img …）的 blog item，重跑 htmlToMarkdown 转换写回，游标 body_redecoded_at 单调，
// dry 零写。mock DB 忠实解释谓词与写入。
interface FakeItem {
  id: string;
  source_type: string;
  url?: string | null;
  extra: Record<string, unknown>;
}

function bodyOf(it: FakeItem, zh = false): string {
  const v = it.extra[zh ? 'body_markdown_zh' : 'body_markdown'];
  return typeof v === 'string' ? v : '';
}

// 谓词：blog + 未打游标 + (body 或 body_zh 含 '<p' 或 '<img')
function actionable(it: FakeItem): boolean {
  if (it.source_type !== 'blog') return false;
  if (it.extra.body_redecoded_at) return false;
  const hit = (s: string) => s.includes('<p') || s.includes('<img');
  return hit(bodyOf(it)) || hit(bodyOf(it, true));
}

function makeEnv(items: FakeItem[]) {
  const updates: Array<{ sql: string; binds: unknown[] }> = [];
  const byId = new Map(items.map((it) => [it.id, it]));
  const DB = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...b: unknown[]) {
          bound = b;
          return stmt;
        },
        async all<T>() {
          if (/SELECT id, url, extra FROM items/i.test(sql)) {
            const limit = Number(bound[0]) || 1000;
            const rows = items
              .filter(actionable)
              .slice(0, limit)
              .map((it) => ({
                id: it.id,
                url: it.url ?? null,
                extra: JSON.stringify(it.extra),
              }));
            return { results: rows as unknown as T[] };
          }
          return { results: [] as T[] };
        },
        async first<T>() {
          if (/COUNT\(\*\)/i.test(sql)) {
            return { c: items.filter(actionable).length } as unknown as T;
          }
          return null;
        },
        async run() {
          updates.push({ sql, binds: bound });
          if (/WHERE id = \?/i.test(sql)) {
            const id = String(bound[bound.length - 1]);
            const it = byId.get(id);
            if (it) {
              // 忠实解析 json_set 的 path/value 对（binds 末位是 id）
              const pairs = [...sql.matchAll(/'(\$\.[a-z_]+)'\s*,\s*\?/gi)];
              pairs.forEach((mm, i) => {
                const path = mm[1];
                const val = bound[i];
                if (path === '$.body_markdown') it.extra.body_markdown = val;
                else if (path === '$.body_markdown_zh') it.extra.body_markdown_zh = val;
                else if (path === '$.body_redecoded_at') it.extra.body_redecoded_at = val;
              });
            }
          }
          return { success: true };
        },
      };
      return stmt;
    },
  };
  return { env: { DB } as unknown as Env, updates };
}

describe('runBlogBodyRedecode', () => {
  test('字面 <p>/<img> 泄漏 → 重转 markdown,游标推进', async () => {
    const items: FakeItem[] = [
      {
        id: 'blog:jiqizhixin:a',
        source_type: 'blog',
        url: 'https://jiqizhixin.com/a',
        extra: {
          feed_key: 'jiqizhixin',
          body_markdown:
            '<p>当大型推理模型普遍暴露推理轨迹</p><img src="https://img.jiqizhixin.com/hero.png"><p>第二段正文</p>',
        },
      },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runBlogBodyRedecode(env, { limit: 50, dry: false });
    expect(res.scanned).toBe(1);
    expect(res.fixed).toBe(1);
    expect(res.remaining).toBe(0);
    const nb = String(items[0].extra.body_markdown);
    expect(nb).not.toContain('<p>');
    expect(nb).not.toContain('<img');
    expect(nb).toContain('当大型推理模型普遍暴露推理轨迹');
    expect(nb).toContain('第二段正文');
    expect(nb).toContain('![](https://img.jiqizhixin.com/hero.png)');
    expect(items[0].extra.body_redecoded_at).toBeTruthy();
    expect(updates.length).toBe(1);
  });

  test('body_markdown_zh 也含泄漏 → 一并重转', async () => {
    const items: FakeItem[] = [
      {
        id: 'blog:jiqizhixin:zh',
        source_type: 'blog',
        url: 'https://jiqizhixin.com/zh',
        extra: {
          feed_key: 'jiqizhixin',
          body_markdown: '<p>English body</p>',
          body_markdown_zh: '<p>中文正文</p><img src="https://img.x/z.png">',
        },
      },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogBodyRedecode(env, { limit: 50, dry: false });
    expect(res.fixed).toBe(1);
    const zh = String(items[0].extra.body_markdown_zh);
    expect(zh).not.toContain('<p>');
    expect(zh).toContain('中文正文');
    expect(zh).toContain('![](https://img.x/z.png)');
    expect(String(items[0].extra.body_markdown)).not.toContain('<p>');
  });

  test('dry=1 → 零写,仍统计 fixed', async () => {
    const items: FakeItem[] = [
      {
        id: 'blog:jiqizhixin:d',
        source_type: 'blog',
        url: 'https://jiqizhixin.com/d',
        extra: { feed_key: 'jiqizhixin', body_markdown: '<p>正文</p>' },
      },
    ];
    const { env, updates } = makeEnv(items);
    const res = await runBlogBodyRedecode(env, { limit: 50, dry: true });
    expect(res.fixed).toBe(1);
    expect(updates.length).toBe(0);
    expect(items[0].extra.body_markdown).toBe('<p>正文</p>'); // 未写
    expect(items[0].extra.body_redecoded_at).toBeUndefined(); // 游标未推进
    expect(res.remaining).toBe(1); // dry 未推进 → 仍待处理
  });

  test('非 blog / 已打游标 / body 无泄漏 → 不进批', async () => {
    const items: FakeItem[] = [
      { id: 'pod:p', source_type: 'podcast', extra: { body_markdown: '<p>x</p>' } }, // 非 blog
      { id: 'blog:done', source_type: 'blog', extra: { body_markdown: '<p>x</p>', body_redecoded_at: 'done' } }, // 已处理
      { id: 'blog:clean', source_type: 'blog', extra: { body_markdown: '正常 markdown 正文，无标签。' } }, // 干净
    ];
    const { env } = makeEnv(items);
    const res = await runBlogBodyRedecode(env, { limit: 50, dry: false });
    expect(res.scanned).toBe(0);
  });

  test('干净 markdown 不被破坏（幂等：已清洗过的正文重跑无变化）', async () => {
    // 谓词命中（body 含裸 "<p" 片段是代码示例，非结构标签）但转换应保内容。
    const items: FakeItem[] = [
      {
        id: 'blog:code',
        source_type: 'blog',
        url: 'https://jiqizhixin.com/code',
        extra: {
          feed_key: 'jiqizhixin',
          // 含 '<p' 命中 LIKE，但 '<price'（非结构标签）不该被当 HTML 剥离
          body_markdown: '价格标签 <price> 示例，正常段落。',
        },
      },
    ];
    const { env } = makeEnv(items);
    const res = await runBlogBodyRedecode(env, { limit: 50, dry: false });
    expect(res.scanned).toBe(1);
    // <price> 非结构标签 → 不触发重转,内容保持,游标仍推进（防重扫）
    expect(res.fixed).toBe(0);
    expect(items[0].extra.body_markdown).toBe('价格标签 <price> 示例，正常段落。');
    expect(items[0].extra.body_redecoded_at).toBeTruthy();
  });
});
