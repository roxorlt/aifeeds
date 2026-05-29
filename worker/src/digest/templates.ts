// 订阅推送邮件模板 v3(FE 视觉规格 2026-05-29)。
// table 布局 + inline CSS + 无 JS,跨客户端兼容(Gmail/Outlook/Apple/QQ/163)。
// 精选档 A 方案:邮件不显示单独"亮点"行,精选只体现"条数更少";每条 title 深链到抽屉(回流端点带 token 自动注册登录)。

import { DIGEST_SOURCE_ORDER, type DigestSource, type Density } from './config';

const SITE = 'https://ai-feeds.com';
const SLOGAN = '专注 AI 领域资讯聚合';

// FE v3 配色 token
const C = {
  text: '#171717', // neutral-900 标题/深色条/黑按钮
  body: '#525252', // neutral-600 卡片简介
  sub: '#737373', // neutral-500 日期/meta/footer
  accent: '#0284c7', // sky-600 仅行内链接
  headerLink: '#7dd3fc', // sky-300 深色条上链接
  border: '#e5e5e5',
  band: '#f5f5f5', // 源分区灰带
  bg: '#fafafa',
  card: '#ffffff',
  headerSub: '#a3a3a3',
};
const FONT = `'HarmonyOS Sans SC','PingFang SC',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif`;

// 源名 = 主站频道 tab 名(dashboard App.tsx)
export const SOURCE_LABELS: Record<DigestSource, string> = {
  'ph': '热门产品',
  'gh': '开源项目',
  'hf-paper': '论文',
  'clawhub': '龙虾技能',
  'x': '动态',
};

export function slotLabel(bjt: number): string {
  if (bjt < 12) return `早上 ${bjt}:00`;
  if (bjt === 12) return '中午 12:00';
  if (bjt < 18) return `下午 ${bjt}:00`;
  return `晚上 ${bjt}:00`;
}

export function densityLabel(d: Density): string {
  return d === 'curated' ? '精选档(AI 优选,更少更精)' : '默认档(每个来源各取前几条)';
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// YYYY-MM-DD(北京时间)
function isoDate(ts = Date.now()): string {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function withUtm(pathOrUrl: string): string {
  const sep = pathOrUrl.includes('?') ? '&' : '?';
  return `${pathOrUrl}${sep}utm_source=email&utm_campaign=digest`;
}

function sourcesLine(sources: DigestSource[]): string {
  return DIGEST_SOURCE_ORDER.filter((s) => sources.includes(s))
    .map((s) => SOURCE_LABELS[s])
    .join(' · ');
}

// ── welcome 邮件 ──

export interface WelcomeEmailInput {
  sources: DigestSource[];
  slotBjt: number;
  density: Density;
  confirmUrl: string | null;
  unsubscribeUrl: string;
}

export function buildWelcomeEmail(input: WelcomeEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const srcText = sourcesLine(input.sources);
  const when = slotLabel(input.slotBjt);
  const dens = densityLabel(input.density);
  const subject = '欢迎订阅 AI Feeds 每日精选';

  const text = [
    '【AI Feeds】欢迎订阅每日精选',
    '',
    `你已订阅:${srcText}`,
    `推送时间:每天 ${when}(北京时间)`,
    `内容档位:${dens}`,
    '',
    '下一个推送时间点,你会收到第一封正式日报。',
    input.confirmUrl ? `\n确认并进站看看:${input.confirmUrl}` : '',
    '',
    `不想再收到?一键退订:${input.unsubscribeUrl}`,
    '',
    `AI Feeds · ${SLOGAN}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  const confirmBtn = input.confirmUrl
    ? `<tr><td style="padding:8px 0 4px;">
         <a href="${input.confirmUrl}" style="display:inline-block;background:${C.text};color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:11px 24px;border-radius:8px;">确认并进站看看</a>
       </td></tr>`
    : '';

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92%;background:${C.card};border:1px solid ${C.border};border-radius:12px;overflow:hidden;font-family:${FONT};">
    <tr><td style="padding:20px 28px 16px;text-align:center;background:${C.text};">
      <div style="font-size:22px;font-weight:800;color:#fff;">AI Feeds</div>
      <div style="font-size:12px;color:${C.headerSub};margin-top:3px;">${SLOGAN}</div>
    </td></tr>
    <tr><td style="padding:20px 28px 4px;">
      <div style="font-size:17px;font-weight:700;color:${C.text};">订阅成功</div>
      <p style="font-size:14px;line-height:1.7;color:${C.body};margin:12px 0 0;">
        你已订阅 <strong style="color:${C.text};">${escapeHtml(srcText)}</strong>，每天 <strong style="color:${C.text};">${escapeHtml(when)}</strong>（北京时间）推送，档位为 ${escapeHtml(dens)}。
      </p>
      <p style="font-size:14px;line-height:1.7;color:${C.sub};margin:8px 0 0;">下一个推送时间点，你会收到第一封正式日报。</p>
    </td></tr>
    <tr><td style="padding:12px 28px 20px;"><table role="presentation" cellpadding="0" cellspacing="0">${confirmBtn}</table></td></tr>
    <tr><td style="padding:16px 28px 24px;border-top:1px solid ${C.border};">
      <div style="font-size:12px;color:${C.sub};line-height:1.6;">不想再收到？<a href="${input.unsubscribeUrl}" style="color:${C.accent};">一键退订</a>。AI Feeds · ${SLOGAN}</div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  return { subject, text, html };
}

// ── digest 正式日报 ──

export interface DigestItem {
  source: DigestSource;
  title: string;
  summary: string;
  url: string;
  deepLinkPath: string;
  author: string;
  cover?: string;
}

export interface DigestEmailInput {
  subject: string; // 精华标题(只作邮件主题行)
  items: DigestItem[];
  emailToken: string | null;
  unsubscribeUrl: string;
}

// 每条 link:回流端点(带 token 自动注册登录)+ 落地抽屉深链(带 utm);无 token 直接深链。
function itemLink(deepLinkPath: string, token: string | null): string {
  const dest = withUtm(deepLinkPath);
  if (token) return `${SITE}/api/digest/return?u=${encodeURIComponent(token)}&to=${encodeURIComponent(dest)}`;
  return `${SITE}${dest}`;
}

function enterLink(token: string | null): string {
  const dest = withUtm('/');
  if (token) return `${SITE}/api/digest/return?u=${encodeURIComponent(token)}&to=${encodeURIComponent(dest)}`;
  return `${SITE}${dest}`;
}

function renderCard(it: DigestItem, link: string): string {
  const author = it.author ? `${escapeHtml(it.author)} · ` : '';
  const cover = it.cover
    ? `<img src="${escapeHtml(it.cover)}" width="100%" style="max-width:536px;border-radius:8px;margin-top:8px;display:block;" alt="" />`
    : '';
  return `<tr><td style="padding:14px 28px;border-bottom:1px solid ${C.border};">
    <a href="${escapeHtml(link)}" style="text-decoration:none;display:block;">
      <div style="font-size:16px;font-weight:700;color:${C.text};text-decoration:underline;line-height:1.45;">${escapeHtml(it.title)}</div>
      <div style="font-size:14px;color:${C.body};margin-top:6px;line-height:1.65;">${author}${escapeHtml(it.summary)}</div>
      ${cover}
    </a>
  </td></tr>`;
}

export function buildDigestEmail(input: DigestEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const headline = input.subject || '今日 AI 精选';
  const date = isoDate();
  const enterUrl = enterLink(input.emailToken);

  const groups: Partial<Record<DigestSource, DigestItem[]>> = {};
  for (const it of input.items) (groups[it.source] ||= []).push(it);
  const orderedSources = DIGEST_SOURCE_ORDER.filter((s) => groups[s]?.length);

  // text 版
  const textParts = [`【AI Feeds】${date}`, ''];
  for (const s of orderedSources) {
    textParts.push(`【${SOURCE_LABELS[s]}】`);
    for (const it of groups[s]!) {
      textParts.push(`· ${it.title}\n  ${it.summary}\n  ${itemLink(it.deepLinkPath, input.emailToken)}`);
    }
    textParts.push('');
  }
  textParts.push(`进站看全部:${enterUrl}`);
  textParts.push(`退订:${input.unsubscribeUrl}`);
  const text = textParts.join('\n');

  // html 分区(整条灰带)+ 卡片
  let sections = '';
  for (const s of orderedSources) {
    sections += `<tr><td style="padding:0;">
      <div style="background:${C.band};border-top:1px solid ${C.border};border-bottom:1px solid ${C.border};padding:11px 28px;font-size:15px;font-weight:700;color:${C.text};">${escapeHtml(SOURCE_LABELS[s])}</div>
    </td></tr>`;
    for (const it of groups[s]!) sections += renderCard(it, itemLink(it.deepLinkPath, input.emailToken));
  }

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:20px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92%;background:${C.card};border:1px solid ${C.border};border-radius:12px;overflow:hidden;font-family:${FONT};">
    <tr><td style="padding:18px 28px 14px;text-align:center;background:${C.text};">
      <div style="font-size:21px;font-weight:800;color:#fff;letter-spacing:.5px;">AI Feeds</div>
      <div style="font-size:12px;color:${C.headerSub};margin-top:3px;">${SLOGAN} · ${date}</div>
      <div style="font-size:12px;margin-top:9px;">
        <a href="${withUtm(SITE)}" style="color:${C.headerLink};text-decoration:none;">访问主站</a>
        <span style="color:#525252;">&nbsp;|&nbsp;</span>
        <a href="${enterUrl}" style="color:${C.headerLink};text-decoration:none;">注册 / 登录</a>
      </div>
    </td></tr>
    ${sections}
    <tr><td style="padding:24px 28px;text-align:center;background:${C.bg};border-top:1px solid ${C.border};">
      <a href="${enterUrl}" style="display:inline-block;background:${C.text};color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 28px;border-radius:8px;">进站看全部</a>
      <div style="font-size:12px;color:${C.sub};margin-top:16px;line-height:1.6;">
        不想再收到？<a href="${input.unsubscribeUrl}" style="color:${C.accent};">一键退订</a>。AI Feeds · ${SLOGAN}
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  return { subject: headline, text, html };
}
