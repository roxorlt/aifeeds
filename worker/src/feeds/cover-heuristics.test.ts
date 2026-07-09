import { describe, test, expect } from 'vitest';
import {
  COVER_BLACKLIST,
  COVER_KEYWORD_OVERRIDE_MIN_DIM,
  isBlacklistedCover,
  isNoCoverSource,
} from './cover-heuristics';

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

// isBlacklistedCover：弱信号（关键词）+ 强信号（尺寸）联合判据（Fix，2026-07-09）。
// 关键词命中的图，仅当能测出尺寸且 maxDim ≥ COVER_KEYWORD_OVERRIDE_MIN_DIM 时判为真头图放行；
// 否则（小图 / 尺寸测不出）维持拒绝。实测依据：真品牌 logo maxDim ≤ 828（qbitai 300 / mit 32），
// 真 og 头图 maxDim ≥ 1200（nvidia 2048 / techcrunch press hero 1200）。
describe('isBlacklistedCover — 关键词 + 尺寸联合判据', () => {
  // ── 回归锁：本次 bug。NVIDIA GFN Thursday 2048×1024 正经头图，文件名 no-copy-logo
  //    （「不带文案和 logo 的版本」）含 'logo' 词边界 → 旧纯关键词误拒；尺寸复核后放行 ──
  test("回归锁：nvidia ...-no-copy-logo.jpg 2048×1024 → 放行（不拒）", () => {
    const u =
      'https://blogs.nvidia.com/wp-content/uploads/2026/07/gfn-thursday-7-2-blog-2048x1024-no-copy-logo.jpg';
    expect(COVER_BLACKLIST.test(u)).toBe(true); // 关键词仍命中（弱信号）
    expect(isBlacklistedCover(u, 2048, 1024)).toBe(false); // 尺寸够大 → override 放行
  });

  test('techcrunch Claude-logo press hero 1200×675 → 放行', () => {
    const u =
      'https://techcrunch.com/wp-content/uploads/2026/07/Cowork-Web-Mobile-Press-alt-Claude-logo-1920x1080-1.png?resize=1200,675';
    expect(isBlacklistedCover(u, 1200, 675)).toBe(false);
  });

  // ── 必拦：真品牌 logo / 图标（关键词命中 + 小图 or 尺寸测不出）→ 维持拒绝 ──
  test('qbitai 品牌 logo 300×300 → 仍拒（小图，未过尺寸门）', () => {
    const u = 'https://www.qbitai.com/wp-content/uploads/imgs/qbitai-logo-1.png';
    expect(isBlacklistedCover(u, 300, 300)).toBe(true);
  });

  test('mit-tech-review cropped-TR-Logo ?w=32 32×32 → 仍拒', () => {
    const u =
      'https://wp.technologyreview.com/wp-content/uploads/2024/01/cropped-TR-Logo-Block-Centered-R.png?w=32';
    expect(isBlacklistedCover(u, 32, 32)).toBe(true);
  });

  test('favicon.png 尺寸测不出（undefined）→ 仍拒（回退纯关键词）', () => {
    expect(isBlacklistedCover('https://s.com/favicon.png')).toBe(true);
    expect(isBlacklistedCover('https://s.com/favicon.png', undefined, undefined)).toBe(true);
  });

  test('apple-touch-icon.png 尺寸测不出 → 仍拒', () => {
    expect(isBlacklistedCover('https://s.com/apple-touch-icon.png')).toBe(true);
  });

  test('qrcode / avatar 小图 → 仍拒', () => {
    expect(isBlacklistedCover('https://s.com/qrcode_QbitAI_1.jpg', 258, 258)).toBe(true);
    expect(isBlacklistedCover('https://s.com/author-avatar-2x.png', 96, 96)).toBe(true);
  });

  // ── 无关键词：任何尺寸都不拒（弱信号未触发，尺寸不参与）──
  test('无关键词 → 恒不拒（含小图）', () => {
    expect(isBlacklistedCover('https://s.com/real-hero.jpg', 2048, 1024)).toBe(false);
    expect(isBlacklistedCover('https://s.com/real-hero.jpg', 100, 100)).toBe(false);
    expect(isBlacklistedCover('https://s.com/silicon-valley-ai.jpg', 50, 50)).toBe(false);
  });

  // ── 阈值边界：恰好 == 阈值 → 放行；阈值 - 1 → 拒 ──
  test(`阈值边界：maxDim == ${COVER_KEYWORD_OVERRIDE_MIN_DIM} 放行，${COVER_KEYWORD_OVERRIDE_MIN_DIM - 1} 拒`, () => {
    const u = 'https://s.com/brand-logo.png';
    expect(isBlacklistedCover(u, COVER_KEYWORD_OVERRIDE_MIN_DIM, 600)).toBe(false);
    expect(isBlacklistedCover(u, COVER_KEYWORD_OVERRIDE_MIN_DIM - 1, 600)).toBe(true);
  });

  // ── 只要有一维缺失即视为「测不出」→ 拒 ──
  test('宽或高任一缺失/为 0 → 视为测不出 → 拒', () => {
    const u = 'https://s.com/brand-logo.png';
    expect(isBlacklistedCover(u, 2048, undefined)).toBe(true);
    expect(isBlacklistedCover(u, undefined, 2048)).toBe(true);
    expect(isBlacklistedCover(u, 2048, 0)).toBe(true);
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
