// PR5 share feature handlers
// 设计：docs/plans/2026-05-04-pr5-share-implementation.md § 3

import { nanoid } from 'nanoid';
import type { Env } from '../index';
import type { CreateShareRequest, CreateShareResponse, LandingRequest, ShareRelation } from './types';
import { authenticate } from '../auth/session';

// 根据 worker 请求 host 推 (site, api) origin，三环境（dev/staging/prod）都能匹配
function originsFor(request: Request): { site: string; api: string } {
  const url = new URL(request.url);
  const host = url.host;
  if (host === 'staging-api.ai-feeds.com') {
    return { site: 'https://staging.ai-feeds.com', api: 'https://staging-api.ai-feeds.com' };
  }
  if (host === 'api.ai-feeds.com') {
    return { site: 'https://ai-feeds.com', api: 'https://api.ai-feeds.com' };
  }
  // dev / wrangler local：site 跟 api 同 origin（vite proxy 透传）
  return { site: url.origin, api: url.origin };
}

function jsonRes(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function jsonErr(error: string, status = 400): Response {
  return jsonRes({ error }, status);
}

// ─── POST /api/share/create ──────────────────────────────────────────
// 输入: { item_id: string }
// 鉴权: cookie / session
// 返回: token + share_url + poster_url + expires_at

export async function handleShareCreate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // 1. 鉴权
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') return jsonErr('not authenticated', 401);

  // 2. 解析 body
  let body: CreateShareRequest;
  try {
    body = (await request.json()) as CreateShareRequest;
  } catch {
    return jsonErr('invalid json', 400);
  }
  if (!body.item_id || typeof body.item_id !== 'string') return jsonErr('item_id required', 400);

  // 3. 校验 item 存在
  const item = await env.DB.prepare(`SELECT id FROM items WHERE id = ? AND deleted_at IS NULL`)
    .bind(body.item_id)
    .first<{ id: string }>();
  if (!item) return jsonErr('item not found', 404);

  // 4. 生成 token + 写 share_relations
  // 注：nanoid 默认 21 字符；分享场景用 8 字符短码（碰撞概率约 50 亿次后才有 1%）
  const token = nanoid(8);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO share_relations (token, from_uid, item_id, shared_at) VALUES (?, ?, ?, ?)`,
  )
    .bind(token, auth.userId, body.item_id, now)
    .run();

  // 5. 返回 — origin 跟着 request host 走，staging / prod 不串
  const { site, api } = originsFor(request);
  const response: CreateShareResponse = {
    token,
    share_url: `${api}/s/${token}`,
    poster_url: `${api}/api/share/poster/${token}`,
    expires_at: now + 30 * 24 * 3600 * 1000, // 30 天（用于前端 hint，实际不强制 expire token）
  };
  return jsonRes(response);
}

// ─── GET /api/share/poster/:token ────────────────────────────────────
// 返回 image/png（Step 2 实现 SVG → PNG 渲染 + R2 缓存）
// 当前占位：返回 501 Not Implemented，dashboard 看到此状态可显示「正在生成…」

export async function handleSharePoster(request: Request, env: Env, token: string): Promise<Response> {
  const url = new URL(request.url);
  const fake = url.searchParams.get('fake'); // 'x' | 'github' | 'ph' — 跳过 DB 用 hardcoded 样本，仅 staging 验视觉
  const noCache = url.searchParams.get('nocache') === '1' || fake; // fake 模式 / 强制 bypass 不走 R2

  // ─── R2 缓存：命中直接返回 ────────────────────────────
  // key 形如 share/poster/<token>.png；写一次后 immutable，命中即时返回
  const r2Key = `share/poster/${token}.png`;
  if (env.READMES && !noCache) {
    const cached = await env.READMES.get(r2Key);
    if (cached) {
      return new Response(cached.body, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*', // dashboard fetch (跨域) 取 blob 需要
          'X-Poster-Cache': 'HIT',
          ...(cached.httpEtag ? { ETag: cached.httpEtag } : {}),
        },
      });
    }
  }

  let rel: ShareRelation | null = null;
  if (fake) {
    rel = {
      id: 0,
      token,
      from_uid: 'usr_fake',
      item_id:
        fake === 'github' ? 'github:TauricResearch/TradingAgents'
        : fake === 'ph' ? 'product_hunt:manus'
        : fake === 'hdx' ? 'huodongxing:6854850974100'
        : 'x_list:fake',
      shared_at: Date.now(),
      to_did: null,
      to_uid: null,
      landed_at: null,
      registered_at: null,
      scan_count: 0,
      last_scanned_at: null,
    };
  } else {
    rel = await env.DB.prepare(`SELECT * FROM share_relations WHERE token = ?`).bind(token).first<ShareRelation>();
    if (!rel) return jsonErr('share token not found', 404);
  }

  // Step 2.2 串通：用 svg-template 渲 v7 模板 → resvg 出 PNG。Step 2.3 接 R2 缓存。
  let item: Record<string, unknown> | null;
  if (fake === 'github') {
    item = {
      id: rel.item_id, source_type: 'github', title: 'TauricResearch/TradingAgents',
      content: '多智能体金融交易框架，通过模拟真实交易团队的分工（基本面分析师、情绪分析师、技术分析师、交易员、风控等），利用 LLM 驱动各角色协作决策。支持多种 LLM 提供商与灵活配置，并具备记忆与检查点恢复能力。研究向，非投资建议。',
      content_translated: null,
      metrics: JSON.stringify({ stars: 59000, forks: 11300, watchers: 497 }),
      extra: JSON.stringify({ daily_rank: 2, category: 'agent', contributors_count: 20 }),
    };
  } else if (fake === 'ph') {
    item = {
      id: rel.item_id, source_type: 'product_hunt', title: 'Manus',
      content: 'Manus 是一个通用 AI 智能体，能将你的想法转化为实际行动，擅长处理工作与生活中的各类任务；提供持续在线的云端计算机环境，无需服务器搭建即可运行 bot、Python 脚本、数据库等，实现 24/7 自动化执行；独特卖点是持久化云端运行与零运维。',
      content_translated: null,
      metrics: JSON.stringify({ comments: 44, rating: '4.20', followers: 1800 }),
      extra: JSON.stringify({ rank: 2, category: 'AI Agent' }),
    };
  } else if (fake === 'x') {
    item = {
      id: rel.item_id, source_type: 'x_list', author: 'Qwen', handle: '@Alibaba_Qwen',
      content: '来认识一下 Qwen3.6-35B-A3B：现已开源！这是一个稀疏 MoE 模型，总参数量 350 亿，激活参数量 30 亿。采用 Apache 2.0 许可证。其智能体编程能力与激活参数量是其 10 倍的模型相当，具备强大的推理与真实世界任务处理能力。',
      content_translated: null,
      metrics: JSON.stringify({ replies: 444, retweets: 2300, likes: 1, views: 262 }),
      extra: null,
    };
  } else if (fake === 'hdx') {
    item = {
      id: rel.item_id, source_type: 'huodongxing', title: '2026 中国出海企业家领袖峰会 · 北京站',
      author: '出海企业家俱乐部',
      handle: 'chuhai-club',
      content: '面向已经出海或正在准备出海的 AI 创业团队、产品经理、市场负责人。本期闭门讨论东南亚六国当前的真实落地难点：本地化工具链选型、支付清算、推广渠道与雇主合规。每位嘉宾 12 分钟分享 + 圆桌追问 + 现场 1v1 撮合。',
      content_translated: null,
      metrics: JSON.stringify({
        registered_count: 351,
        max_instance: 2000,
        organizer_fans: 463,
        follows: 28,
        visit_number: 14200,
      }),
      extra: JSON.stringify({
        city: '北京',
        district: '朝阳',
        is_online: false,
        is_free: true,
        start_short: '06/13 周六 09:00',
        start_time: '2026-06-13T09:00:00+08:00',
        end_time: '2026-06-13T18:00:00+08:00',
        tags: ['出海企业家', '全球化', '海外市场拓展', '东南亚'],
        ticket_tiers: [
          { sn: 1, name: '企业家票', price: 0, price_str: '免费' },
          { sn: 2, name: '投资人/服务商票', price: 0, price_str: '免费' },
        ],
        organizer: {
          name: '出海企业家俱乐部',
          slug: 'chuhai-club',
          url: 'https://chuhai-club.huodongxing.com',
          avatar_url: null,
          fans: 463,
          is_certified_company: true,
          is_vip_gold: false,
        },
        detail_enriched_at: Math.floor(Date.now() / 1000),
        status: 'active',
      }),
      media: null,
    };
  } else {
    item = await env.DB.prepare(`SELECT * FROM items WHERE id = ?`).bind(rel.item_id).first<Record<string, unknown>>();
    if (!item) {
      return jsonErr('item not found', 404);
    }
  }
  // 解析 metrics / extra（DB 里是 JSON 字符串）
  const safeJson = (v: unknown): Record<string, unknown> | null => {
    if (typeof v !== 'string') return (v as Record<string, unknown>) ?? null;
    try { return JSON.parse(v); } catch { return null; }
  };
  const itemMedia = safeJson(item.media);
  const itemExtra = safeJson(item.extra);
  const sourceType = String(item.source_type || '');
  // GH/PH/X 抽第一张可用图作为海报媒体（fetch + base64 嵌 SVG）
  const mediaInfo = await pickPosterMedia(sourceType, itemExtra, itemMedia, request, env);
  // GH owner 头像 / PH 产品 logo（X 暂不抓推文作者头像 — scraper 没存）
  const authorAvatarDataUri = await pickAuthorAvatar(sourceType, rel.item_id, itemMedia, itemExtra, request, env);
  const posterItem = {
    id: rel.item_id,
    source_type: String(item.source_type || ''),
    author: typeof item.author === 'string' ? item.author : undefined,
    handle: typeof item.handle === 'string' ? item.handle : undefined,
    title: typeof item.title === 'string' ? item.title : undefined,
    content: typeof item.content === 'string' ? item.content : undefined,
    content_translated: typeof item.content_translated === 'string' ? item.content_translated : undefined,
    metrics: safeJson(item.metrics),
    extra: itemExtra,
    mediaImageDataUri: mediaInfo?.dataUri,
    mediaAspectRatio: mediaInfo?.aspectRatio,
    mediaIsVideo: mediaInfo?.isVideo,
    authorAvatarDataUri,
  };
  // ─── 拉分享人真实信息 ─────────────────────────────────
  // from_uid 查 users 表拿 display_name + avatar_url；display_name 缺失留给
  // svg-template 用 hash 默认值；avatar_url 缺失则按 dashboard 同款规则推默认
  // /avatars/avatar-NN.png（保持前端 / 海报视觉一致）。头像 URL 需要 fetch 出
  // bytes → base64 嵌入 SVG（resvg 不主动 fetch external image）
  let sharerName: string | undefined;
  let sharerAvatarDataUri: string | undefined;
  if (!fake) {
    const user = await env.DB.prepare(
      `SELECT display_name, avatar_url FROM users WHERE id = ?`,
    ).bind(rel.from_uid).first<{ display_name: string | null; avatar_url: string | null }>();
    if (user?.display_name) sharerName = user.display_name;
    const avatarUrl = user?.avatar_url || defaultAvatarPath(rel.from_uid);
    sharerAvatarDataUri = await fetchAvatarAsDataUri(avatarUrl, request);
  }

  const { renderShareSvg } = await import('./svg-template');
  const { renderSvgToPng } = await import('./poster');
  const { api } = originsFor(request);
  const svg = await renderShareSvg(posterItem, {
    token,
    shareUrl: `${api}/s/${token}`,
    sharerSeed: rel.from_uid,
    sharerName,
    sharerAvatarDataUri,
  });
  // ?dev=1 → 直接返回 SVG 文本（debug 用）
  if (url.searchParams.get('dev') === '1') {
    return new Response(svg, { status: 200, headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  const png = await renderSvgToPng(svg);

  // 写 R2（fake 模式不写避免污染缓存）
  if (env.READMES && !noCache) {
    try {
      await env.READMES.put(r2Key, png, {
        httpMetadata: { contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable' },
      });
    } catch (e) {
      console.error('[share-poster] R2 put failed:', e);
    }
  }

  return new Response(png, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': noCache ? 'no-store' : 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*', // dashboard fetch (跨域) 取 blob 需要
      'X-Poster-Cache': 'MISS',
    },
  });
}

// 根据 avatar URL fetch + base64 → data URI
// 支持：https://... 完整 URL / /avatars/avatar-NN.png（需要拼 site origin）
async function fetchAvatarAsDataUri(avatarUrl: string, request: Request): Promise<string | undefined> {
  let absUrl = avatarUrl;
  if (avatarUrl.startsWith('/')) {
    const { site } = originsFor(request);
    absUrl = site + avatarUrl;
  }
  try {
    const res = await fetch(absUrl, {
      cf: { cacheTtl: 86400, cacheEverything: true },
      headers: { 'User-Agent': 'ai-feeds-poster-renderer/1.0' },
    });
    if (!res.ok) return undefined;
    const ct = res.headers.get('content-type') || 'image/png';
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 2 * 1024 * 1024) return undefined; // > 2MB 跳过，避免拖累渲染
    const b64 = arrayBufferToBase64(buf);
    return `data:${ct};base64,${b64}`;
  } catch (e) {
    console.error('[share-poster] avatar fetch failed:', avatarUrl, e);
    return undefined;
  }
}

// dashboard/lib/defaultProfile.ts 同源 djb2 hash + 30 张头像池
function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) + s.charCodeAt(i);
    h = h | 0;
  }
  return Math.abs(h);
}

function defaultAvatarPath(userId: string): string {
  const h = djb2Hash(userId + ':avatar');
  const n = String((h % 30) + 1).padStart(2, '0');
  // 用 256x256 小尺寸（dashboard/public/avatars-sm/，海报 120x120 用足够），
  // 减少 1254→120 暴力下采样的糊感
  return `/avatars-sm/avatar-${n}.png`;
}

// 选作者/项目头像（海报左上 logo 位置）：
// - GH = `https://github.com/<owner>.png`（GitHub 公开 endpoint，免登录）
// - PH = media JSON 中 role=logo 那张
// - X = 没数据，返回 undefined（落 hash 色块 + 首字母 fallback）
// - HDX (huodongxing) = extra.og_image / extra.thumbnail_full（活动 cover）
async function pickAuthorAvatar(
  sourceType: string,
  itemId: string,
  media: unknown,
  extra: Record<string, unknown> | null,
  request: Request,
  env: Env,
): Promise<string | undefined> {
  let url: string | undefined;
  if (sourceType === 'github') {
    // itemId 形如 'github:owner/repo'
    const m = itemId.match(/^github:([^/]+)\//);
    if (m) {
      url = `https://github.com/${m[1]}.png?size=256`;
    }
  } else if (sourceType === 'product_hunt') {
    if (Array.isArray(media)) {
      const arr = media as Array<{ type?: string; url?: string; role?: string }>;
      const logo = arr.find(x => x?.role === 'logo' && typeof x.url === 'string');
      if (logo?.url) url = logo.url;
    }
  } else if (sourceType === 'huodongxing') {
    // 海报 128×128 cover 位 — 优先 thumbnail_full（站点已是方图），其次 og_image（banner，居中裁切）
    // og_image / thumbnail_full 可能是 cdn.huodongxing.com 原 URL 或 /r/hdx/<sha> R2 路径，
    // 都交给 fetchAvatarOnly 处理
    const thumb = typeof extra?.thumbnail_full === 'string' ? extra.thumbnail_full : '';
    const og = typeof extra?.og_image === 'string' ? extra.og_image : '';
    url = thumb || og || undefined;
  } else if (sourceType === 'clawhub') {
    // owner GitHub avatar — itemId 形如 'clawhub:<slug>'，handle 在 items.handle 里。
    // 这里没拿 handle 字段，从 itemMedia 找 avatar 不靠谱（ClawHub 多数 skill 没有 inline 媒体），
    // 退而求其次：handlers.ts 上层调用时已经把 item.handle 写进了 PosterItem.handle 字段，
    // 这里 itemId 不带 handle，所以用专用路径：直接根据 source_id 走 GitHub avatar
    // 约定（owner GitHub handle === ClawHub publisher handle 在大多数 skill 上成立）。
    // ⚠️ 兜底：实在没头像则返 undefined，svg-template 走首字母 fallback
    const m = itemId.match(/^clawhub:(.+)$/);
    if (m) {
      // 通过 itemId 反查 D1 拿 handle
      try {
        const row = await env.DB.prepare(`SELECT handle FROM items WHERE id = ?`)
          .bind(itemId).first<{ handle: string | null }>();
        if (row?.handle) {
          url = `https://github.com/${row.handle}.png?size=256`;
        }
      } catch {
        // ignore — fall through to undefined
      }
    }
  }
  if (!url) return undefined;
  // 头像走单独路径：只需要 fetch + sniff + base64，不做 media 门控
  // （avatar 本来就是小方图，会被 max-dim < 800 + aspect~1 误杀）
  return await fetchAvatarOnly(url, env);
}

// 头像专用 fetcher：跳过 media 门控；但 logo 太小（< 64）也弃，海报上糊
async function fetchAvatarOnly(rawUrl: string, env: Env): Promise<string | undefined> {
  let url = rawUrl;
  if (url.startsWith('/r/') && env.READMES) {
    const key = url.slice(3);
    try {
      const obj = await env.READMES.get(key);
      if (!obj) return undefined;
      const buf = await obj.arrayBuffer();
      const sniffed = sniffImageType(buf);
      const ct = sniffed ? mimeFor(sniffed) : (obj.httpMetadata?.contentType || 'image/png');
      if (sniffed === 'svg') {
        // SVG → PNG via resvg
        const svgText = new TextDecoder().decode(new Uint8Array(buf));
        const { renderSvgToPng } = await import('./poster');
        const png = new Uint8Array(await renderSvgToPng(svgText));
        return `data:image/png;base64,${arrayBufferToBase64(png.buffer)}`;
      }
      // 维度检查：太小（< 64）的 logo 拉伸到 128 会糊，让上层走首字母 fallback
      const dim = probeImageDimensions(buf);
      if (dim && Math.max(dim.width, dim.height) < 64) {
        console.log(`[share-poster] avatar too small ${rawUrl}: ${dim.width}x${dim.height}`);
        return undefined;
      }
      return `data:${ct};base64,${arrayBufferToBase64(buf)}`;
    } catch (e) {
      console.error('[share-poster] avatar R2 read failed:', key, e);
      return undefined;
    }
  }
  if (url.startsWith('/')) {
    const url2 = (rawUrl.startsWith('/r/') ? 'https://api.ai-feeds.com' : '') + url;
    url = url2;
  }
  if (url.includes('ph-files.imgix.net')) {
    const u = new URL(url);
    u.searchParams.set('w', '512');
    u.searchParams.set('fit', 'max');
    u.searchParams.set('fm', 'png');
    url = u.toString();
  }
  try {
    const res = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!res.ok) return undefined;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 2 * 1024 * 1024) return undefined;
    const sniffed = sniffImageType(buf);
    const ct = sniffed ? mimeFor(sniffed) : (res.headers.get('content-type') || 'image/png');
    return `data:${ct};base64,${arrayBufferToBase64(buf)}`;
  } catch (e) {
    console.error('[share-poster] avatar fetch failed:', rawUrl, e);
    return undefined;
  }
}

// 选海报媒体图：GH 抽 readme_excerpt 全部非 SVG <img>，PH 抽 media JSON gallery；
// 顺序 fetch 每张做质量门控，第一张通过的用作海报媒体。
// 门控：
//   1. 宽高比 > 2 或 < 0.5 → banner / 长条，弃
//   2. 字节密度（file_size / pixel_count）< 0.18 → 大块纯色低信息，弃
// 最多探 5 张，避免拖慢 cold render。
// 从 X video URL 推算 poster URL（X 公开 URL pattern）
// https://video.twimg.com/tweet_video/<ID>.mp4 → https://pbs.twimg.com/tweet_video_thumb/<ID>.jpg
// amp_video_iframe / ext_tw_video 等其他 pattern 暂不支持（少见）
function twimgVideoPoster(videoUrl: string): string | undefined {
  const m = videoUrl.match(/video\.twimg\.com\/tweet_video\/([^.?]+)\.mp4/);
  if (m) return `https://pbs.twimg.com/tweet_video_thumb/${m[1]}.jpg`;
  return undefined;
}

async function pickPosterMedia(
  sourceType: string,
  extra: Record<string, unknown> | null,
  media: unknown,
  request: Request,
  env: Env,
): Promise<{ dataUri: string; aspectRatio?: number; isVideo?: boolean } | undefined> {
  // candidate 可带 known dims（X media 已提供 w/h，避免 fetch 后再探）
  // isVideo 标记：用作 svg-template 渲 media 时叠加 play 按钮
  const candidates: Array<{ url: string; width?: number; height?: number; isVideo?: boolean }> = [];

  if (sourceType === 'github') {
    const readme = typeof extra?.readme_excerpt === 'string' ? extra.readme_excerpt : '';
    if (readme) {
      // 接受所有 <img src="...">，包括 SVG（resvg 二次渲染成 PNG）
      // GitHub user-attachments URL 不带扩展名也纳入候选
      // 顺序：非 SVG 优先、SVG 后备（多数 SVG 是 shields/badges）
      const re = /<img[^>]*\bsrc="([^"]+)"/gi;
      const nonSvg: string[] = [];
      const svgs: string[] = [];
      let m;
      while ((m = re.exec(readme)) !== null) {
        const u = m[1];
        if (/\.svg(\?|$)/i.test(u)) svgs.push(u);
        else nonSvg.push(u);
        if (nonSvg.length + svgs.length >= 16) break;
      }
      for (const u of [...nonSvg, ...svgs]) {
        candidates.push({ url: u });
        if (candidates.length >= 10) break;
      }
    }
  } else if (sourceType === 'product_hunt') {
    if (Array.isArray(media)) {
      const arr = media as Array<{ type?: string; url?: string; role?: string; poster?: string; video_id?: string; platform?: string }>;
      // 先 gallery image
      for (const x of arr) {
        if (typeof x?.url === 'string' && x.role !== 'logo' && x.type === 'image') {
          candidates.push({ url: x.url });
          if (candidates.length >= 8) break;
        }
      }
      // 再 video poster：scraper 存的（如有）/ YouTube 推 maxresdefault.jpg
      for (const x of arr) {
        if (x?.type === 'video') {
          let poster: string | undefined = typeof x.poster === 'string' ? x.poster : undefined;
          if (!poster && x.platform === 'youtube' && x.video_id) {
            poster = `https://img.youtube.com/vi/${x.video_id}/maxresdefault.jpg`;
          }
          if (poster) {
            candidates.push({ url: poster, isVideo: true });
            if (candidates.length >= 8) break;
          }
        }
      }
    }
  } else if (sourceType === 'x_list') {
    // X media: [{type:'image'|'video', url, width, height, alt, poster?}]
    // 视频从 video.twimg.com/tweet_video/<id>.mp4 推 pbs.twimg.com/tweet_video_thumb/<id>.jpg
    if (Array.isArray(media)) {
      const arr = media as Array<{ type?: string; url?: string; width?: number; height?: number; poster?: string }>;
      // 先 image
      for (const x of arr) {
        if (x?.type === 'image' && typeof x.url === 'string') {
          candidates.push({ url: x.url, width: x.width, height: x.height });
          if (candidates.length >= 8) break;
        }
      }
      // 再 video poster
      for (const x of arr) {
        if (x?.type === 'video' && typeof x.url === 'string') {
          const poster = (typeof x.poster === 'string' ? x.poster : undefined) || twimgVideoPoster(x.url);
          if (poster) {
            candidates.push({ url: poster, width: x.width, height: x.height, isVideo: true });
            if (candidates.length >= 8) break;
          }
        }
      }
    }
  }

  for (let i = 0; i < Math.min(candidates.length, 8); i++) {
    const c = candidates[i];
    // 已有 known dims：先做 aspect 门控避免无效 fetch
    if (c.width && c.height) {
      const ar = c.width / c.height;
      if (ar > 4 || ar < 0.25) {
        console.log(`[share-poster] skip ${c.url}: known aspect ${ar.toFixed(2)}`);
        continue;
      }
    }
    const result = await tryFetchPosterImage(c.url, request, env, c.width, c.height, c.isVideo);
    if (result) return { ...result, isVideo: c.isVideo };
  }
  // fallback：GH readme 有 <video> 但所有 <img> 都被弃 → 灰底 + play 占位
  // （GitHub user-attachments video 没有可拿的 poster URL，video 解码超出 worker 能力）
  if (sourceType === 'github') {
    const readme = typeof extra?.readme_excerpt === 'string' ? extra.readme_excerpt : '';
    if (/<video\b/i.test(readme)) {
      return { dataUri: '', aspectRatio: 16 / 9, isVideo: true };
    }
  }
  return undefined;
}

async function tryFetchPosterImage(
  rawUrl: string,
  request: Request,
  env: Env,
  knownW?: number,
  knownH?: number,
  isVideoPoster?: boolean,
): Promise<{ dataUri: string; aspectRatio?: number } | undefined> {
  // /r/* 资源在 R2：直接读 R2 binding，绕过 worker self-fetch（prod 上 self-fetch
  // 自己暴露的 /r/ 路由会再次进 worker，cold path 时延 + 偶发 504）
  if (rawUrl.startsWith('/r/')) {
    if (env.READMES) {
      const key = rawUrl.slice(3); // strip '/r/'
      try {
        const obj = await env.READMES.get(key);
        if (!obj) {
          console.log(`[share-poster] R2 miss: ${key}`);
          return undefined;
        }
        const buf = await obj.arrayBuffer();
        if (buf.byteLength > 4 * 1024 * 1024) {
          console.log(`[share-poster] R2 too big: ${key} ${buf.byteLength}`);
          return undefined;
        }
        const ct = obj.httpMetadata?.contentType || 'image/png';
        return await maybeConvertAndEncode(buf, ct, rawUrl, knownW, knownH, isVideoPoster);
      } catch (e) {
        console.error('[share-poster] R2 read failed:', key, e);
        return undefined;
      }
    }
    // 非 prod 环境（staging worker 没 mirror R2 资源）兜底走 prod fetch
    rawUrl = 'https://api.ai-feeds.com' + rawUrl;
  }

  let url = rawUrl;
  if (url.startsWith('/')) {
    const { api } = originsFor(request);
    url = api + url;
  }
  // PH imgix：限宽 1080 减小 fetch 体积；强转 png（resvg-wasm 不支持 gif/webp 嵌入）
  if (url.includes('ph-files.imgix.net')) {
    const u = new URL(url);
    u.searchParams.set('w', '1080');
    u.searchParams.set('fit', 'max');
    u.searchParams.set('fm', 'png'); // gif/webp source → png output
    url = u.toString();
  }
  // X pbs.twimg.com：把 name=small/120x120 改成 name=large 拿原图，避免缩略图变形
  if (url.includes('pbs.twimg.com')) {
    const u = new URL(url);
    u.searchParams.set('name', 'large');
    url = u.toString();
  }

  try {
    const res = await fetch(url, {
      cf: { cacheTtl: 86400, cacheEverything: true },
      headers: { 'User-Agent': 'ai-feeds-poster-renderer/1.0' },
    });
    if (!res.ok) {
      console.log(`[share-poster] fetch ${url} → ${res.status}`);
      return undefined;
    }
    const ct = res.headers.get('content-type') || 'image/png';
    const buf = await res.arrayBuffer();
    return await maybeConvertAndEncode(buf, ct, rawUrl, knownW, knownH, isVideoPoster);
  } catch (e) {
    console.error('[share-poster] media fetch failed:', rawUrl, e);
    return undefined;
  }
}

// SVG → PNG 二次渲染（用 resvg），其他类型直接走 validateAndEncode
async function maybeConvertAndEncode(
  buf: ArrayBuffer,
  contentType: string,
  origUrl: string,
  knownW?: number,
  knownH?: number,
  isVideoPoster?: boolean,
): Promise<{ dataUri: string; aspectRatio?: number } | undefined> {
  // 优先信 magic bytes，不信 R2 metadata / response header（GH user-attachments
  // 跟 R2 mirror 经常 ct 跟实际 bytes 不符 — .png 文件里塞 JPEG 之类的）
  const realType = sniffImageType(buf);
  const isSvg = realType === 'svg' || (!realType && (contentType.includes('svg') || /\.svg(\?|$)/i.test(origUrl)));
  if (!isSvg) {
    const ct = realType ? mimeFor(realType) : contentType;
    return validateAndEncode(buf, ct, origUrl, knownW, knownH, isVideoPoster);
  }
  try {
    const svgText = new TextDecoder().decode(new Uint8Array(buf));
    // 快速 viewBox 探查：太长条 banner 提前弃，避免无谓 resvg 渲染
    const vb = svgText.match(/viewBox=["']\s*[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)/);
    if (vb) {
      const w = parseFloat(vb[1]);
      const h = parseFloat(vb[2]);
      if (w > 0 && h > 0) {
        const ar = w / h;
        if (ar > 4 || ar < 0.25) {
          console.log(`[share-poster] reject ${origUrl}: svg viewBox aspect ${ar.toFixed(2)}`);
          return undefined;
        }
      }
    }
    const { renderSvgToPng } = await import('./poster');
    const png = await renderSvgToPng(svgText);
    // ⚠️ resvg.asPng() 返回 Uint8Array view 指向 wasm memory；必须复制出实际 bytes
    // 否则后续 base64 编码会把整块 wasm memory（含其他 PNG/无关数据）一起编进去
    const pngCopy = new Uint8Array(png);
    return validateAndEncode(pngCopy.buffer, 'image/png', origUrl, knownW, knownH);
  } catch (e) {
    console.error('[share-poster] svg → png failed:', origUrl, e);
    return undefined;
  }
}

// 共用质量门控 + base64 编码：fetch 路径 / R2 路径都走这个
function validateAndEncode(
  buf: ArrayBuffer,
  contentType: string,
  origUrl: string,
  knownW?: number,
  knownH?: number,
  isVideoPoster?: boolean,
): { dataUri: string; aspectRatio?: number } | undefined {
  if (buf.byteLength > 4 * 1024 * 1024) {
    console.log(`[share-poster] reject ${origUrl}: too big ${buf.byteLength}`);
    return undefined;
  }
  // 质量门控：PNG / JPEG / GIF 都能读维度；不认识的格式跳过门控
  // video poster 跳过尺寸门控（X video thumbnail 一般 480×480 / 720×720）
  const dim = probeImageDimensions(buf);
  if (dim) {
    const ar = dim.width / dim.height;
    if (ar > 4 || ar < 0.25) {
      console.log(`[share-poster] reject ${origUrl}: aspect ${ar.toFixed(2)}`);
      return undefined;
    }
    const density = buf.byteLength / (dim.width * dim.height);
    if (density < 0.05) {
      console.log(`[share-poster] reject ${origUrl}: density ${density.toFixed(3)} (${dim.width}x${dim.height})`);
      return undefined;
    }
    if (!isVideoPoster) {
      // 全局最小尺寸：max dim < 600 → 弃（icon、button、shields、wechat 群 QR 都偏小）
      const maxDim = Math.max(dim.width, dim.height);
      if (maxDim < 600) {
        console.log(`[share-poster] reject ${origUrl}: too small ${dim.width}x${dim.height}`);
        return undefined;
      }
      // 中等尺寸方图额外门控：> 600 但 < 1000 + aspect ~1 也按 icon/QR 处理
      if (maxDim < 1000 && ar > 0.7 && ar < 1.4) {
        console.log(`[share-poster] reject ${origUrl}: small square ${dim.width}x${dim.height}`);
        return undefined;
      }
    }
  }
  const b64 = arrayBufferToBase64(buf);
  const aspectRatio = dim
    ? dim.width / dim.height
    : (knownW && knownH ? knownW / knownH : undefined);
  return { dataUri: `data:${contentType};base64,${b64}`, aspectRatio };
}

// 嗅探图片真实类型（magic bytes）：内容为王，不信 content-type / extension
function sniffImageType(buf: ArrayBuffer): 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' | undefined {
  if (buf.byteLength < 12) return undefined;
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (v.getUint32(0) === 0x89504E47 && v.getUint32(4) === 0x0D0A1A0A) return 'png';
  // JPEG: FF D8 FF
  if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return 'jpeg';
  // GIF: 47 49 46 38
  if (v.getUint32(0) === 0x47494638) return 'gif';
  // WebP: RIFF.... WEBP
  if (v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) return 'webp';
  // SVG（XML）：检查首 ~256 字节有 '<svg' 或 '<?xml ... <svg'
  const headLen = Math.min(buf.byteLength, 256);
  const head = new TextDecoder().decode(u8.slice(0, headLen));
  if (/<svg\b/i.test(head)) return 'svg';
  if (/^\s*<\?xml/i.test(head)) return 'svg'; // XML prolog 通常意味着 SVG
  return undefined;
}

function mimeFor(t: 'png' | 'jpeg' | 'gif' | 'webp' | 'svg'): string {
  switch (t) {
    case 'png': return 'image/png';
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
  }
}

// 探 PNG 文件头宽高（IHDR chunk: bytes 16-19=width, 20-23=height）；非 PNG 返回 undefined
function probePngDimensions(buf: ArrayBuffer): { width: number; height: number } | undefined {
  const view = new DataView(buf);
  if (buf.byteLength < 24) return undefined;
  // PNG 签名 89 50 4E 47 0D 0A 1A 0A
  if (view.getUint32(0) !== 0x89504E47 || view.getUint32(4) !== 0x0D0A1A0A) return undefined;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) return undefined;
  return { width, height };
}

// 通用维度探查：PNG / JPEG / GIF / WebP；不认识返回 undefined
function probeImageDimensions(buf: ArrayBuffer): { width: number; height: number } | undefined {
  const png = probePngDimensions(buf);
  if (png) return png;
  const v = new DataView(buf);
  if (buf.byteLength < 4) return undefined;
  // JPEG: walk segments (FF Mn LL LL ...) 找 SOF (C0-CF except C4/C8/CC)
  if (v.getUint8(0) === 0xFF && v.getUint8(1) === 0xD8) {
    let i = 2;
    while (i < buf.byteLength - 1) {
      if (v.getUint8(i) !== 0xFF) return undefined;
      const marker = v.getUint8(i + 1);
      i += 2;
      // SOF0..SOF15，跳过 DHT (C4) / JPG (C8) / DAC (CC)
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        if (i + 7 > buf.byteLength) return undefined;
        const height = v.getUint16(i + 3);
        const width = v.getUint16(i + 5);
        if (!width || !height) return undefined;
        return { width, height };
      }
      // 普通 segment：长度 2 字节 + 数据
      if (i + 2 > buf.byteLength) return undefined;
      const segLen = v.getUint16(i);
      i += segLen;
    }
    return undefined;
  }
  // GIF: 47 49 46 38 ... 6,7=width(LE) 8,9=height(LE)
  if (v.getUint32(0) === 0x47494638 && buf.byteLength >= 10) {
    return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  }
  // WebP VP8/VP8L/VP8X: 复杂，省略（少见且这场景遇到概率低）
  return undefined;
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  // 分块拼接，避免 String.fromCharCode 单次处理过多元素栈溢出
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(bin);
}

// ─── GET /s/:token ───────────────────────────────────────────────────
// 扫码命中：写 landed_at + to_did，redirect 到详情页

export async function handleShareRedirect(request: Request, env: Env, ctx: ExecutionContext, token: string): Promise<Response> {
  const { site } = originsFor(request);
  const rel = await env.DB.prepare(`SELECT * FROM share_relations WHERE token = ?`).bind(token).first<ShareRelation>();
  if (!rel) {
    // token 不存在直接 redirect 首页
    return Response.redirect(site, 302);
  }

  const did = request.headers.get('X-Device-Id') || extractDeviceIdFromCookie(request);
  const now = Date.now();

  // 异步写更新：首次扫码补 to_did + landed_at；后续 +1 scan_count
  ctx.waitUntil(
    (async () => {
      if (!rel.landed_at) {
        await env.DB.prepare(
          `UPDATE share_relations SET to_did = ?, landed_at = ?, scan_count = 1, last_scanned_at = ? WHERE token = ?`,
        )
          .bind(did, now, now, token)
          .run();
      } else {
        await env.DB.prepare(
          `UPDATE share_relations SET scan_count = scan_count + 1, last_scanned_at = ? WHERE token = ?`,
        )
          .bind(now, token)
          .run();
      }
    })(),
  );

  // 解析 item_id 拿 detail URL：item_id 形如 'x_list:123…' / 'github:owner/repo' / 'product_hunt:slug'
  // 详情页路由跟 dashboard 现有 url-routing 一致：/t/<full_id> 或 /g/<owner>/<repo>
  const detailPath = buildDetailPath(rel.item_id);
  const target = `${site}${detailPath}?from=${encodeURIComponent(rel.from_uid)}&ref=share&token=${token}`;
  return Response.redirect(target, 302);
}

// ─── POST /api/share/landing ─────────────────────────────────────────
// 落地详情页时前端调用，补 to_did（redirect 时浏览器可能没 device_id cookie）

export async function handleShareLanding(request: Request, env: Env): Promise<Response> {
  let body: LandingRequest;
  try {
    body = (await request.json()) as LandingRequest;
  } catch {
    return jsonErr('invalid json', 400);
  }
  if (!body.token) return jsonErr('token required', 400);

  const did = request.headers.get('X-Device-Id');
  if (!did) return jsonErr('X-Device-Id required', 400);

  // 仅当 to_did 为空时 UPDATE（防止覆盖已记录的首次扫码 did）
  await env.DB.prepare(
    `UPDATE share_relations
       SET to_did = ?, landed_at = ?
     WHERE token = ? AND to_did IS NULL`,
  )
    .bind(did, Date.now(), body.token)
    .run();

  return jsonRes({ ok: true });
}

// ─── GET /api/admin/share/:token ─────────────────────────────────────
// admin 工具，看一个 token 的扫码统计

export async function handleAdminShareStats(request: Request, env: Env, token: string): Promise<Response> {
  // checkAdminAuth 在 admin.ts，复用（CF Access JWT 优先，Basic Auth fallback）
  const { checkAdminAuth } = await import('../admin');
  if (!(await checkAdminAuth(request, env))) {
    return new Response('Authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="ai-feeds admin"' },
    });
  }

  const rel = await env.DB.prepare(`SELECT * FROM share_relations WHERE token = ?`).bind(token).first<ShareRelation>();
  if (!rel) return jsonErr('share token not found', 404);

  return jsonRes(rel);
}

// ─── helpers ─────────────────────────────────────────────────────────

function extractDeviceIdFromCookie(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)device_id=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function buildDetailPath(itemId: string): string {
  // 各 source 详情页路由必须跟 dashboard drawer.tsx parseDeepLinkFromPath 对齐，
  // 否则扫码 redirect 过去会被当 X 推文 query 失败显示"推文不存在"。
  //
  //   X / podcast / arxiv / fallback → /t/<source_id>
  //   GitHub        → /g/<owner>/<repo>
  //   Product Hunt  → /ph/<slug>/<date>
  //   ClawHub       → /c/<slug>
  //   Huodongxing   → /e/<event_id>
  if (itemId.startsWith('github:')) {
    const repo = itemId.slice('github:'.length); // 形如 'owner/repo'
    return `/g/${repo}`;
  }
  if (itemId.startsWith('product_hunt:')) {
    // composite source_id 'slug:date'
    const parts = itemId.slice('product_hunt:'.length).split(':');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return `/ph/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
    }
  }
  if (itemId.startsWith('clawhub:')) {
    const slug = itemId.slice('clawhub:'.length);
    if (slug) return `/c/${encodeURIComponent(slug)}`;
  }
  if (itemId.startsWith('huodongxing:')) {
    const eid = itemId.slice('huodongxing:'.length);
    if (eid) return `/e/${encodeURIComponent(eid)}`;
  }
  // X list / 未知 source → /t/<full_id> 兜底（保持 PR5 既有行为，不冒回归风险）
  return `/t/${encodeURIComponent(itemId)}`;
}
