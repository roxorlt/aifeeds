// 订阅推送邮件模板。welcome 邮件(订阅即时发)+ digest 正式日报。
// 邮件 HTML 约束:table 布局 + inline CSS + 无 JS,跨客户端兼容(Gmail/Outlook/Apple/QQ/163)。
// 源名对齐主站频道 tab;每条 title 深链到 aifeeds 抽屉(经回流端点带 token 自动注册登录)。

import { DIGEST_SOURCE_ORDER, type DigestSource, type Density } from './config';

const SITE = 'https://ai-feeds.com';

// 占位品牌色,待 FE 出最终规格替换。
const BRAND = {
  text: '#16181c',
  sub: '#6b7280',
  accent: '#2563eb',
  border: '#e5e7eb',
  bg: '#f6f7f9',
  card: '#ffffff',
  headerBg: '#16181c',
  headerSub: '#cbd5e1',
  headerLink: '#93c5fd',
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

function cnDate(ts = Date.now()): string {
  const d = new Date(ts + 8 * 3600 * 1000);
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`;
}

function sourcesLine(sources: DigestSource[]): string {
  return DIGEST_SOURCE_ORDER.filter((s) => sources.includes(s))
    .map((s) => SOURCE_LABELS[s])
    .join(' · ');
}

// ── welcome 邮件(订阅即时发)──

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
    `AI Feeds · ${SITE}`,
  ]
    .filter((l) => l !== '')
    .join('\n');

  const confirmBtn = input.confirmUrl
    ? `<tr><td style="padding:8px 0 4px;">
         <a href="${input.confirmUrl}" style="display:inline-block;background:${BRAND.accent};color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:11px 22px;border-radius:8px;">确认并进站看看 →</a>
       </td></tr>`
    : '';

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92%;background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:14px;overflow:hidden;font-family:${FONT};">
    <tr><td style="padding:26px 28px 20px;text-align:center;background:${BRAND.headerBg};">
      <div style="font-size:24px;font-weight:800;color:#fff;letter-spacing:.5px;">AI Feeds</div>
      <div style="font-size:12px;color:${BRAND.headerSub};margin-top:4px;">每日 AI 多源精选</div>
    </td></tr>
    <tr><td style="padding:20px 28px 4px;">
      <div style="font-size:17px;font-weight:600;color:${BRAND.text};">订阅成功</div>
      <p style="font-size:14px;line-height:1.7;color:${BRAND.text};margin:12px 0 0;">
        你已订阅 <strong>${escapeHtml(srcText)}</strong>，每天 <strong>${escapeHtml(when)}</strong>（北京时间）推送，档位为 ${escapeHtml(dens)}。
      </p>
      <p style="font-size:14px;line-height:1.7;color:${BRAND.sub};margin:8px 0 0;">下一个推送时间点，你会收到第一封正式日报。</p>
    </td></tr>
    <tr><td style="padding:12px 28px 20px;"><table role="presentation" cellpadding="0" cellspacing="0">${confirmBtn}</table></td></tr>
    <tr><td style="padding:16px 28px 24px;border-top:1px solid ${BRAND.border};">
      <div style="font-size:12px;color:${BRAND.sub};line-height:1.6;">
        不想再收到？<a href="${input.unsubscribeUrl}" style="color:${BRAND.sub};">一键退订</a>。<br>AI Feeds · <a href="${SITE}" style="color:${BRAND.sub};">ai-feeds.com</a>
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  return { subject, text, html };
}

// ── digest 正式日报邮件 ──

export interface DigestItem {
  source: DigestSource;
  title: string;
  summary: string;
  url: string; // 原始链接(text 版 fallback,极端情况)
  deepLinkPath: string; // aifeeds 抽屉深链 path,如 /t/<id> /g/<owner>/<repo>
  author: string;
  hook: string | null;
  cover?: string;
}

export interface DigestEmailInput {
  subject: string; // 精华标题(node-run 生成,如"AlphaFold3, M4 芯片, 模型规范")
  items: DigestItem[];
  emailToken: string | null; // 回流 token:每条 link 带它经回流端点自动注册登录
  unsubscribeUrl: string;
}

// 每条 link:有 token 走回流端点(自动注册登录)+ 落地抽屉深链;无 token 直接深链。
function itemLink(deepLinkPath: string, token: string | null): string {
  if (token) {
    return `${SITE}/api/digest/return?u=${encodeURIComponent(token)}&to=${encodeURIComponent(deepLinkPath)}`;
  }
  return `${SITE}${deepLinkPath}`;
}

function renderCard(it: DigestItem, link: string): string {
  const author = it.author ? `${escapeHtml(it.author)} · ` : '';
  const hook = it.hook
    ? `<div style="font-size:13px;color:${BRAND.accent};margin-top:5px;line-height:1.55;">${escapeHtml(it.hook)}</div>`
    : '';
  const cover = it.cover
    ? `<img src="${escapeHtml(it.cover)}" width="100%" style="max-width:536px;border-radius:8px;margin-top:8px;display:block;" alt="" />`
    : '';
  return `<tr><td style="padding:10px 28px 14px;border-bottom:1px solid ${BRAND.border};">
    <a href="${escapeHtml(link)}" style="text-decoration:none;display:block;">
      <div style="font-size:15px;font-weight:600;color:${BRAND.accent};line-height:1.45;">${escapeHtml(it.title)}</div>
      <div style="font-size:13px;color:${BRAND.sub};margin-top:4px;line-height:1.6;">${author}${escapeHtml(it.summary)}</div>
      ${hook}
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
  const date = cnDate();
  const enterUrl = input.emailToken
    ? `${SITE}/api/digest/return?u=${encodeURIComponent(input.emailToken)}`
    : SITE;

  const groups: Partial<Record<DigestSource, DigestItem[]>> = {};
  for (const it of input.items) (groups[it.source] ||= []).push(it);
  const orderedSources = DIGEST_SOURCE_ORDER.filter((s) => groups[s]?.length);

  // text 版
  const textParts = [`【AI Feeds】${date} · ${headline}`, ''];
  for (const s of orderedSources) {
    textParts.push(`【${SOURCE_LABELS[s]}】`);
    for (const it of groups[s]!) {
      textParts.push(`· ${it.title}${it.hook ? `\n  ${it.hook}` : ''}\n  ${itemLink(it.deepLinkPath, input.emailToken)}`);
    }
    textParts.push('');
  }
  textParts.push(`进站看全部:${enterUrl}`);
  textParts.push(`退订:${input.unsubscribeUrl}`);
  const text = textParts.join('\n');

  // html 分区 + 卡片
  let sections = '';
  for (const s of orderedSources) {
    sections += `<tr><td style="padding:22px 28px 4px;">
      <span style="display:inline-block;font-size:13px;font-weight:700;color:#fff;background:${BRAND.accent};padding:4px 14px;border-radius:14px;">${escapeHtml(SOURCE_LABELS[s])}</span>
    </td></tr>`;
    for (const it of groups[s]!) sections += renderCard(it, itemLink(it.deepLinkPath, input.emailToken));
  }

  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:20px 0;">
<tr><td align="center">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:92%;background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:14px;overflow:hidden;font-family:${FONT};">
    <tr><td style="padding:26px 28px 20px;text-align:center;background:${BRAND.headerBg};">
      <div style="font-size:24px;font-weight:800;color:#fff;letter-spacing:.5px;">AI Feeds</div>
      <div style="font-size:12px;color:${BRAND.headerSub};margin-top:4px;">每日 AI 多源精选 · ${date}</div>
      <div style="font-size:12px;margin-top:12px;">
        <a href="${SITE}" style="color:${BRAND.headerLink};text-decoration:none;">访问主站</a>
        <span style="color:#475569;">&nbsp;|&nbsp;</span>
        <a href="${enterUrl}" style="color:${BRAND.headerLink};text-decoration:none;">注册 / 登录</a>
      </div>
    </td></tr>
    <tr><td style="padding:18px 28px 2px;">
      <div style="font-size:16px;font-weight:700;color:${BRAND.text};line-height:1.5;">${escapeHtml(headline)}</div>
    </td></tr>
    ${sections}
    <tr><td style="padding:26px 28px;text-align:center;background:${BRAND.bg};border-top:1px solid ${BRAND.border};">
      <div style="font-size:19px;font-weight:800;color:${BRAND.text};">AI Feeds</div>
      <div style="font-size:12px;color:${BRAND.sub};margin-top:4px;">多源 AI 资讯,一站精选</div>
      <a href="${enterUrl}" style="display:inline-block;margin-top:14px;background:${BRAND.accent};color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 24px;border-radius:8px;">进站看全部 →</a>
      <div style="font-size:11px;color:${BRAND.sub};margin-top:18px;line-height:1.6;">
        <a href="${input.unsubscribeUrl}" style="color:${BRAND.sub};">退订</a>
        <span style="color:${BRAND.border};">·</span>
        <a href="${SITE}" style="color:${BRAND.sub};">ai-feeds.com</a>
      </div>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;

  return { subject: `${date} · ${headline}`, text, html };
}
