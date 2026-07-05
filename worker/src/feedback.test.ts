// 单测:用户反馈的纯函数 helpers(content 校验 / 图片 MIME·大小·扩展名映射 /
// BJT 日期边界 / LIKE 转义 / remaining 计算 / image_url 拼接 / device JSON 解析)。
// 跑法(与本仓库其它 .ts 单测一致):`npx tsx --test src/feedback.test.ts`
//   —— node 原生 --experimental-strip-types 不解析仓库里的无扩展名相对 import,
//      tsx 才能跑通;此测只触及纯函数,不依赖 Workers runtime。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bjtDay,
  escapeLike,
  extForMime,
  validateContent,
  validateImageMeta,
  remainingAfter,
  imageUrlFromKey,
  parseClientDevice,
  CONTENT_MAX,
  REPLY_MAX,
  IMG_MAX_BYTES,
  DAILY_CAP,
} from './feedback';

// ─── content 校验 ─────────────────────────────────────────────────────
test('validateContent: 空/纯空白/非字符串 → content required', () => {
  for (const bad of ['', '   ', '\n\t ', null, undefined, 123, {}]) {
    const r = validateContent(bad, CONTENT_MAX);
    assert.deepEqual(r, { ok: false, error: 'content required' }, `input=${JSON.stringify(bad)}`);
  }
});

test('validateContent: 前后空白被 trim,返回 trim 后的值', () => {
  const r = validateContent('  你好 世界  ', CONTENT_MAX);
  assert.deepEqual(r, { ok: true, value: '你好 世界' });
});

test('validateContent: 恰好上限通过,超一个字 → content too long', () => {
  const at = validateContent('a'.repeat(CONTENT_MAX), CONTENT_MAX);
  assert.deepEqual(at, { ok: true, value: 'a'.repeat(CONTENT_MAX) });
  const over = validateContent('a'.repeat(CONTENT_MAX + 1), CONTENT_MAX);
  assert.deepEqual(over, { ok: false, error: 'content too long' });
});

test('validateContent: 回复用 REPLY_MAX=5000 上限', () => {
  assert.equal(REPLY_MAX, 5000);
  assert.equal(validateContent('a'.repeat(REPLY_MAX), REPLY_MAX).ok, true);
  assert.deepEqual(validateContent('a'.repeat(REPLY_MAX + 1), REPLY_MAX), {
    ok: false,
    error: 'content too long',
  });
});

// ─── 图片 MIME / 大小 / 扩展名映射 ────────────────────────────────────
test('extForMime: 白名单 4 种映射正确', () => {
  assert.equal(extForMime('image/jpeg'), 'jpg');
  assert.equal(extForMime('image/png'), 'png');
  assert.equal(extForMime('image/webp'), 'webp');
  assert.equal(extForMime('image/gif'), 'gif');
});

test('extForMime: svg 与其它类型 → null(显式禁 svg)', () => {
  for (const bad of ['image/svg+xml', 'text/plain', 'application/pdf', 'image/bmp', '', 'IMAGE/PNG']) {
    assert.equal(extForMime(bad), null, `mime=${bad}`);
  }
});

test('validateImageMeta: 合法图片返回 ext + 归一化 mime', () => {
  assert.deepEqual(validateImageMeta(1000, 'image/png'), { ok: true, ext: 'png', mime: 'image/png' });
});

test('validateImageMeta: mime 带 charset / 大写 → 归一化后仍匹配', () => {
  assert.deepEqual(validateImageMeta(1000, 'image/JPEG; charset=binary'), {
    ok: true,
    ext: 'jpg',
    mime: 'image/jpeg',
  });
});

test('validateImageMeta: size 边界 —— 恰好 5MB 通过,+1 字节 too large', () => {
  assert.equal(validateImageMeta(IMG_MAX_BYTES, 'image/png').ok, true);
  assert.deepEqual(validateImageMeta(IMG_MAX_BYTES + 1, 'image/png'), {
    ok: false,
    error: 'image too large',
  });
});

test('validateImageMeta: 非白名单 MIME → unsupported image type', () => {
  assert.deepEqual(validateImageMeta(1000, 'image/svg+xml'), {
    ok: false,
    error: 'unsupported image type',
  });
});

test('validateImageMeta: size 校验先于 MIME(超大 svg 报 too large 而非 unsupported)', () => {
  assert.deepEqual(validateImageMeta(IMG_MAX_BYTES + 1, 'image/svg+xml'), {
    ok: false,
    error: 'image too large',
  });
});

// ─── BJT 日期边界(北京时区 = UTC+8)─────────────────────────────────
test('bjtDay: 23:59 / 00:00 BJT 边界(对应 15:59:59Z / 16:00:00Z)', () => {
  // BJT 23:59:59.999 = UTC 15:59:59.999 → 仍属当天
  assert.equal(bjtDay(Date.parse('2026-07-05T15:59:59.999Z')), '2026-07-05');
  // BJT 00:00:00.000(次日)= UTC 16:00:00.000 → 翻到下一天
  assert.equal(bjtDay(Date.parse('2026-07-05T16:00:00.000Z')), '2026-07-06');
});

test('bjtDay: 白天/月末跨日均正确', () => {
  assert.equal(bjtDay(Date.parse('2026-07-05T04:00:00Z')), '2026-07-05');
  // UTC 月末 22:00 = BJT 次月 06:00
  assert.equal(bjtDay(Date.parse('2026-07-31T22:00:00Z')), '2026-08-01');
});

// ─── LIKE 通配符转义 ──────────────────────────────────────────────────
test('escapeLike: 无特殊字符原样返回', () => {
  assert.equal(escapeLike('alice'), 'alice');
  assert.equal(escapeLike('13800138000'), '13800138000');
});

test('escapeLike: % _ \\ 各前置反斜杠(配合 ESCAPE \\)', () => {
  assert.equal(escapeLike('50%'), '50\\%');
  assert.equal(escapeLike('a_b'), 'a\\_b');
  assert.equal(escapeLike('a\\b'), 'a\\\\b');
  // 全部三种混合:先转反斜杠也不会二次转义(单次 replace)
  assert.equal(escapeLike('%_\\'), '\\%\\_\\\\');
});

// ─── remaining 计算(remaining = cap - 含本条当日总数,下限 0)──────────
test('remainingAfter: 第 1/2/3 条后剩余 2/1/0', () => {
  assert.equal(DAILY_CAP, 3);
  assert.equal(remainingAfter(1, DAILY_CAP), 2);
  assert.equal(remainingAfter(2, DAILY_CAP), 1);
  assert.equal(remainingAfter(3, DAILY_CAP), 0);
});

test('remainingAfter: 不为负(clamp 到 0)', () => {
  assert.equal(remainingAfter(4, DAILY_CAP), 0);
  assert.equal(remainingAfter(0, DAILY_CAP), 3);
});

// ─── image_url 拼接 ───────────────────────────────────────────────────
test('imageUrlFromKey: 有 key 拼 /r/ 前缀,无 key → null', () => {
  assert.equal(imageUrlFromKey('feedback/abc123.jpg'), '/r/feedback/abc123.jpg');
  assert.equal(imageUrlFromKey(null), null);
  assert.equal(imageUrlFromKey(undefined), null);
  assert.equal(imageUrlFromKey(''), null);
});

// ─── device JSON 解析(非法/超限静默 null)─────────────────────────────
test('parseClientDevice: 合法 JSON 返回对象', () => {
  assert.deepEqual(parseClientDevice('{"ua":"x","dpr":2}'), { ua: 'x', dpr: 2 });
});

test('parseClientDevice: 空/非字符串/非法 JSON/超 8KB → null(不抛错)', () => {
  assert.equal(parseClientDevice(null), null);
  assert.equal(parseClientDevice(''), null);
  assert.equal(parseClientDevice(123), null);
  assert.equal(parseClientDevice('{not json'), null);
  assert.equal(parseClientDevice('"' + 'a'.repeat(9000) + '"'), null);
});
