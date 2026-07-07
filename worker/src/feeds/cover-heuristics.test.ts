import { describe, test, expect } from 'vitest';
import { COVER_BLACKLIST, isNoCoverSource } from './cover-heuristics';

// COVER_BLACKLIST 路径段/词边界锚定（Fix 1，2026-07-07）：关键词只在被非字母（`/ _ - . @` /
// 数字 / 串首尾等，即不与字母相邻）分隔时命中，消除 icon⊂silicon / logo⊂catalogo 类子串误伤。
describe('COVER_BLACKLIST — 路径段边界锚定', () => {
  // ── 必拦：关键词处在词/路径段边界，确属封面垃圾 ──
  describe('必拦用例（品牌 logo / 头像 / 图标 / 二维码 / 徽章 / 页脚）', () => {
    const MUST_BLOCK = [
      'qbitai-logo-1.png',
      'favicon.ico', // favicon 含 icon 子串，边界化后靠独立 favicon 关键词兜住
      'avatar.jpg',
      'user_avatar_small.png',
      'qrcode_x.jpg',
      'site-icon.svg',
      'brand_logo@2x.png', // 后缘 '@' 非字母 → 仍算边界
      // 逐词保留原清单拦截意图
      'https://www.qbitai.com/wp-content/uploads/2019/01/qrcode_QbitAI_1.jpg',
      'https://s.com/footer_qrcode_QbitAI_1.jpg',
      'https://s.com/author-avatar-2x.png',
      'share_erweima.png',
      '文章-二维码.jpg',
      'verified-badge.svg',
      'page_footer.png',
      'promo_qr_code.png',
      'promo-qr-code.png',
      '/r/blog/site-logo.png',
      'logo.png',
      'logo2x.png', // 后缘数字非字母 → 边界命中（仍是 logo）
      // 复数形态加固（Fix，2026-07-07）：词表组后缀 `s?`，拦住目录/文件名的复数写法
      'logos.png',
      '/assets/logos/brand.png',
      'icons.svg',
      'avatars.jpg',
    ];
    for (const u of MUST_BLOCK) {
      test(`拦: ${u}`, () => {
        expect(COVER_BLACKLIST.test(u)).toBe(true);
      });
    }
  });

  // ── 必放：关键词是更长字母词的子串（silICON / catalOGO / bioLOGIcal…）→ 不误杀 ──
  describe('必放用例（含 icon/logo/logi/ico 子串的正常词）', () => {
    const MUST_ALLOW = [
      'silicon-valley-ai.jpg',
      'iconic-design.png',
      'technology-2026.jpg',
      'catalogue-cover.png',
      'catalogo-cover.png', // catalogo 字面含 'logo' 子串，边界化后放行
      'biological-research.jpg',
      'real-hero.jpg',
      'https://platform.theverge.com/wp-content/uploads/sites/2/2026/07/hero.jpg',
      'logotype.png', // logo 后紧邻字母 't'（非可选 's'）→ s? 加固不误伤，仍放行
    ];
    for (const u of MUST_ALLOW) {
      test(`放: ${u}`, () => {
        expect(COVER_BLACKLIST.test(u)).toBe(false);
      });
    }
  });
});

describe('isNoCoverSource', () => {
  test('jiqizhixin 命中', () => {
    expect(isNoCoverSource('jiqizhixin')).toBe(true);
  });
  test('qbitai 不命中（正文有真 hero，靠关键词层拦 logo）', () => {
    expect(isNoCoverSource('qbitai')).toBe(false);
  });
  test('空/undefined 安全返回 false', () => {
    expect(isNoCoverSource(null)).toBe(false);
    expect(isNoCoverSource(undefined)).toBe(false);
    expect(isNoCoverSource('')).toBe(false);
  });
});
