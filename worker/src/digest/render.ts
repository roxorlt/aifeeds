// digest 渲染共享纯函数:把 items 行按源转成对外 JSON 条目(rank + cover + 中文 title/summary)。
// 供 daily-api 实时渲染用。逻辑与 deliver.ts toDigestItem 对齐(clawhub 用 summary_translated);
// cover 取值对齐前端流内卡片:ph=媒体logo / gh=owner头像 / hf=社交缩略图 / x=推文附图 / clawhub=无。
// (deliver.ts 暂保留自己的私有副本,不在本次重构,避免动邮件链路。)

import type { DigestSource } from './config';

export interface RenderRow {
  id: string;
  title: string | null;
  content: string | null;
  content_translated: string | null;
  author: string | null;
  handle: string | null;
  url: string | null;
  media: string | null; // JSON string
  extra: string | null; // JSON string
}

export interface MediaAsset {
  type: 'image' | 'video';
  url: string; // 图片 URL,或视频播放源(mp4 / youtube 链接);相对路径已拼 apiBase
  poster?: string; // 视频封面帧(已拼 apiBase)
}

export interface RenderedItem {
  rank: number; // 该源热度排名(1-based)
  item_id: string;
  source: DigestSource;
  title: string;
  summary: string; // 截断到 ~180,跟邮件一致
  summary_full: string; // 完整(静态页可用更长)
  url: string;
  deep_link: string; // 站内抽屉深链
  author: string;
  cover: string | null; // 流内封面(通常 = media 第一张实质图);相对路径已拼 apiBase,无则 null
  logo: string | null; // 品牌 logo/icon(PH 产品图标;其他源多为 null)
  media: MediaAsset[]; // 详情页所有图片+视频(尽可能多;logo 不含在内;无媒体为 [])
  duration_sec?: number; // 播客单集时长(秒);仅 podcast(行业新闻板块)有,blog/其他源省略
  guests?: string[]; // 播客本集嘉宾名(LLM 抽取);仅 podcast 且抽到嘉宾时有
  intro?: string; // 内容简介:图文新闻→excerpt_zh / 播客→shownotes_zh(比一句话 summary 更完整);仅行业新闻有
  timeline?: Array<{ ts: string; topic: string; speaker?: string; point: string }>; // 话题脉络:仅有原生时间戳文字稿的 podcast 有
}

export function cleanText(s: string): string {
  return (s || '').replace(/[#*`>_~]/g, '').replace(/\s+/g, ' ').trim();
}

export function clampSentences(s: string, maxLen = 180): string {
  const clean = cleanText(s);
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen);
  const lastPunct = Math.max(
    slice.lastIndexOf('。'),
    slice.lastIndexOf('！'),
    slice.lastIndexOf('？'),
    slice.lastIndexOf('；'),
  );
  return lastPunct > maxLen * 0.5 ? slice.slice(0, lastPunct + 1) : slice + '…';
}

export function deepLinkPath(itemId: string): string {
  const idx = itemId.indexOf(':');
  if (idx < 0) return '/';
  const st = itemId.slice(0, idx);
  const sid = itemId.slice(idx + 1);
  switch (st) {
    case 'x_list':
      return `/t/${encodeURIComponent(sid)}`;
    case 'github': {
      const [o, r] = sid.split('/');
      return o && r ? `/g/${encodeURIComponent(o)}/${encodeURIComponent(r)}` : '/';
    }
    case 'product_hunt': {
      const [slug, date] = sid.split(':');
      return slug && date ? `/ph/${encodeURIComponent(slug)}/${encodeURIComponent(date)}` : '/';
    }
    case 'clawhub':
      return `/c/${encodeURIComponent(sid)}`;
    case 'hf_paper':
      return `/h/${encodeURIComponent(sid)}`;
    case 'blog':
    case 'podcast':
      // 行业新闻(blog/podcast):/o/<完整 composite id>,对齐 dashboard parseDeepLinkFromPath
      return `/o/${encodeURIComponent(itemId)}`;
    default:
      return '/';
  }
}

function ghRepoName(itemId: string): string {
  const idx = itemId.indexOf(':');
  const sid = idx >= 0 ? itemId.slice(idx + 1) : itemId;
  const slash = sid.lastIndexOf('/');
  return slash >= 0 ? sid.slice(slash + 1) : sid;
}

function ghOwner(itemId: string): string {
  const idx = itemId.indexOf(':');
  const sid = idx >= 0 ? itemId.slice(idx + 1) : itemId;
  return sid.split('/')[0] || '';
}

function safeParse(s: string | null): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

// GH README excerpt 抽所有非 badge 图(<img>/![]()),按出现顺序去重 + 拼 abs URL。
// cover 取第一张,media 取全部。跳过 .svg 和 shields 类 badge;/r/ 拼 apiBase,相对路径拼 raw.githubusercontent。
function resolveReadmeImages(readme: string, owner: string, repo: string, branch: string, apiBase: string): string[] {
  const raw: string[] = [];
  let m: RegExpExecArray | null;
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)/g;
  while ((m = mdRe.exec(readme)) !== null) raw.push(m[1]);
  const htmlRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((m = htmlRe.exec(readme)) !== null) raw.push(m[1]);
  const isBadge = (u: string): boolean =>
    /\.svg(\?|$)/i.test(u) || /(shields\.io|badgen\.net|badge\.fury|forthebadge|img\.shields)/i.test(u);
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch || 'main'}`;
  const resolve = (u: string): string => {
    if (/^(https?:|data:|blob:)/i.test(u)) return u;
    if (u.startsWith('/r/')) return `${apiBase}${u}`;
    return u.startsWith('/') ? `${base}${u}` : `${base}/${u.replace(/^\.\//, '')}`;
  };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const u of raw) {
    if (isBadge(u)) continue;
    const r = resolve(u);
    if (!seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

// 封面图(对齐前端流内卡片 + 用户规则:gh/hf/ph 取真图,x 仅推文附图,clawhub 不取头像)
function pickCover(source: DigestSource, row: RenderRow, ex: Record<string, unknown>, apiBase: string): string | null {
  const abs = (u: string | null | undefined): string | null =>
    !u ? null : u.startsWith('http') ? u : `${apiBase}${u}`;
  let media: unknown = null;
  try {
    media = JSON.parse(row.media || 'null');
  } catch {
    /* ignore */
  }
  const imgs = Array.isArray(media)
    ? (media as Array<Record<string, unknown>>).filter((m) => m && m.type === 'image' && m.url)
    : [];
  switch (source) {
    case 'ph': {
      // 流内卡片封面 = 第一张非 logo 的 image(产品截图/hero shot),否则 video poster;
      // logo 只是头部 40×40 小图标,不当封面。对齐前端 PhCard.selectPhCover + share/handlers。
      const shot = imgs.find((m) => m.role !== 'logo');
      if (shot) return abs(shot.url as string);
      const vids = Array.isArray(media)
        ? (media as Array<Record<string, unknown>>).filter((m) => m && m.type === 'video')
        : [];
      for (const v of vids) {
        const poster = (v.poster as string) || (v.url as string); // PH video.url 即缩略图
        if (poster) return abs(poster);
      }
      return null;
    }
    case 'gh': {
      // 流内封面 = README 第一张真图(hero/截图),无则 null;owner 头像不当封面
      const readme = typeof ex.readme_excerpt === 'string' ? (ex.readme_excerpt as string) : '';
      if (!readme) return null;
      return resolveReadmeImages(readme, ghOwner(row.id), ghRepoName(row.id), (ex.default_branch as string) || 'main', apiBase)[0] || null;
    }
    case 'hf-paper': {
      if (imgs.length) return abs(imgs[0].url as string);
      const fig = ex.figure_image as Record<string, unknown> | undefined;
      if (fig && typeof fig === 'object' && fig.r2_url) return abs(fig.r2_url as string);
      return null;
    }
    case 'x': {
      // 推文附图;有 video 用 poster(X video.url 是 mp4 流,不能当图);都没有 null(不用作者头像)
      if (imgs.length) return abs(imgs[0].url as string);
      const vids = Array.isArray(media)
        ? (media as Array<Record<string, unknown>>).filter((m) => m && m.type === 'video')
        : [];
      for (const v of vids) {
        if (v.poster) return abs(v.poster as string);
      }
      return null;
    }
    case 'clawhub':
      return null; // 不用作者头像
    case 'news': {
      // 行业新闻:博客/播客封面 = extra.cover_image,否则 media 第一张图
      const cov = (ex.cover_image as string) || '';
      if (cov) return abs(cov);
      return imgs.length ? abs(imgs[0].url as string) : null;
    }
    default:
      return null;
  }
}

// 品牌 logo/icon 独立字段。目前仅 PH 有产品 logo(media role=logo);其他源无产品 logo → null。
function pickLogo(source: DigestSource, row: RenderRow, apiBase: string): string | null {
  if (source !== 'ph') return null;
  let media: unknown = null;
  try {
    media = JSON.parse(row.media || 'null');
  } catch {
    /* ignore */
  }
  if (!Array.isArray(media)) return null;
  const logo = (media as Array<Record<string, unknown>>).find(
    (m) => m && m.type === 'image' && m.role === 'logo' && m.url,
  );
  if (!logo) return null;
  const u = logo.url as string;
  return u.startsWith('http') ? u : `${apiBase}${u}`;
}

// 详情页所有图片+视频(尽可能多)。logo 不进 media(单独字段);按 url 去重。
function buildMedia(source: DigestSource, row: RenderRow, ex: Record<string, unknown>, apiBase: string): MediaAsset[] {
  const abs = (u: string | null | undefined): string => (!u ? '' : u.startsWith('http') ? u : `${apiBase}${u}`);
  let media: unknown = null;
  try {
    media = JSON.parse(row.media || 'null');
  } catch {
    /* ignore */
  }
  const arr = Array.isArray(media) ? (media as Array<Record<string, unknown>>) : [];
  const out: MediaAsset[] = [];
  switch (source) {
    case 'ph':
      for (const m of arr) {
        if (m.role === 'logo') continue; // logo 单独字段
        if (m.type === 'image' && m.url) out.push({ type: 'image', url: abs(m.url as string) });
        else if (m.type === 'video') {
          // PH video:url 是缩略图(jpeg),videoUrl 是 youtube 播放链接
          out.push({ type: 'video', url: (m.videoUrl as string) || abs(m.url as string), poster: abs(m.url as string) });
        }
      }
      break;
    case 'gh': {
      const readme = typeof ex.readme_excerpt === 'string' ? (ex.readme_excerpt as string) : '';
      if (readme) {
        for (const u of resolveReadmeImages(readme, ghOwner(row.id), ghRepoName(row.id), (ex.default_branch as string) || 'main', apiBase)) {
          out.push({ type: 'image', url: u });
        }
      }
      break;
    }
    case 'hf-paper': {
      for (const m of arr) if (m.type === 'image' && m.url) out.push({ type: 'image', url: abs(m.url as string) });
      const fig = ex.figure_image as Record<string, unknown> | undefined;
      if (fig && typeof fig === 'object') {
        const fu = (fig.r2_url as string) || (fig.raw_url as string);
        if (fu) out.push({ type: 'image', url: abs(fu) });
      }
      break;
    }
    case 'x':
      for (const m of arr) {
        if (m.type === 'image' && m.url) out.push({ type: 'image', url: abs(m.url as string) });
        else if (m.type === 'video') {
          // X video:url 是 mp4 流,poster 是缩略图
          const v: MediaAsset = { type: 'video', url: abs(m.url as string) };
          if (m.poster) v.poster = abs(m.poster as string);
          out.push(v);
        }
      }
      break;
    case 'clawhub':
      break; // skill 无媒体
    case 'news':
      // 行业新闻:博客/播客正文图片(及视频)
      for (const m of arr) {
        if (m.type === 'image' && m.url) out.push({ type: 'image', url: abs(m.url as string) });
        else if (m.type === 'video' && m.url) {
          const v: MediaAsset = { type: 'video', url: abs(m.url as string) };
          if (m.poster) v.poster = abs(m.poster as string);
          out.push(v);
        }
      }
      break;
  }
  const seen = new Set<string>();
  return out.filter((a) => {
    const k = `${a.url}|${a.poster || ''}`;
    if (seen.has(k) || !a.url) return false;
    seen.add(k);
    return true;
  });
}

export function renderItem(source: DigestSource, row: RenderRow, rank: number, apiBase: string): RenderedItem {
  const ex = safeParse(row.extra);
  const ct = row.content_translated || '';
  const body = ct || row.content || '';
  let title: string;
  let summary: string;
  switch (source) {
    case 'gh':
      title = ghRepoName(row.id);
      summary = (ex.ai_summary as string) || ct;
      break;
    case 'ph':
      title = row.title || '';
      summary = (ex.ai_summary as string) || ct;
      break;
    case 'hf-paper': // 标题=原始论文标题译文(title_zh),对齐前端 HfPaperCard;摘要=详细中文摘要
      title = (ex.title_zh as string) || row.title || '';
      summary = (ex.summary_zh as string) || (ex.ai_summary_zh as string) || '';
      break;
    case 'x':
      title = (ex.ai_summary as string) || body.slice(0, 60);
      summary = ct || row.content || '';
      break;
    case 'clawhub':
      title = row.title || '';
      summary = (ex.summary_translated as string) || (ex.summary_en as string) || ct;
      break;
    case 'news': // 行业新闻(blog/podcast):中文标题 title_zh + 一句话中文摘要 ai_summary_zh
      title = (ex.title_zh as string) || row.title || '';
      summary = (ex.ai_summary_zh as string) || ct;
      break;
    default:
      title = row.title || body.slice(0, 60);
      summary = body;
  }
  // 播客专属:单集时长 + 本集嘉宾(blog / 其他源没有 → 省略,不进 JSON)
  const durationSec = typeof ex.duration_sec === 'number' && ex.duration_sec > 0 ? ex.duration_sec : undefined;
  const guests = Array.isArray(ex.guests)
    ? (ex.guests as unknown[]).filter((g): g is string => typeof g === 'string' && g.trim() !== '')
    : [];
  // 行业新闻专属:内容简介(图文→excerpt_zh / 播客→shownotes_zh)+ 话题脉络(有原生时间戳文字稿的播客)
  let intro: string | undefined;
  let timeline: RenderedItem['timeline'];
  if (source === 'news') {
    const isPod = row.id.startsWith('podcast:');
    const introRaw = String((isPod ? ex.shownotes_zh : ex.excerpt_zh) || '').trim();
    if (introRaw) intro = clampSentences(introRaw, 800);
    if (isPod && Array.isArray(ex.timeline) && ex.timeline.length) {
      timeline = ex.timeline as RenderedItem['timeline'];
    }
  }
  return {
    rank,
    item_id: row.id,
    source,
    title: cleanText(title || '(无标题)').slice(0, 120),
    summary: clampSentences(summary),
    summary_full: cleanText(summary),
    url: row.url || '',
    deep_link: deepLinkPath(row.id),
    author: row.author || row.handle || '',
    cover: pickCover(source, row, ex, apiBase),
    logo: pickLogo(source, row, apiBase),
    media: buildMedia(source, row, ex, apiBase),
    ...(durationSec ? { duration_sec: durationSec } : {}),
    ...(guests.length ? { guests } : {}),
    ...(intro ? { intro } : {}),
    ...(timeline && timeline.length ? { timeline } : {}),
  };
}
