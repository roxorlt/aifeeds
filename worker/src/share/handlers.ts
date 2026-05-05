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
    share_url: `${site}/s/${token}`,
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
      item_id: fake === 'github' ? 'github:TauricResearch/TradingAgents' : fake === 'ph' ? 'product_hunt:manus' : 'x_list:fake',
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
  // GH/PH 抽第一张可用图作为海报媒体；fetch + base64 嵌入 SVG（resvg 不主动 fetch）
  const mediaInfo = await pickPosterMedia(
    String(item.source_type || ''),
    itemExtra,
    itemMedia,
    request,
  );
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
  const { site } = originsFor(request);
  const svg = await renderShareSvg(posterItem, {
    token,
    shareUrl: `${site}/s/${token}`,
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
  return `/avatars/avatar-${n}.png`;
}

// 选海报媒体图：GH 抽 readme_excerpt 全部非 SVG <img>，PH 抽 media JSON gallery；
// 顺序 fetch 每张做质量门控，第一张通过的用作海报媒体。
// 门控：
//   1. 宽高比 > 2 或 < 0.5 → banner / 长条，弃
//   2. 字节密度（file_size / pixel_count）< 0.18 → 大块纯色低信息，弃
// 最多探 5 张，避免拖慢 cold render。
async function pickPosterMedia(
  sourceType: string,
  extra: Record<string, unknown> | null,
  media: unknown,
  request: Request,
): Promise<{ dataUri: string; aspectRatio?: number } | undefined> {
  const candidates: string[] = [];
  if (sourceType === 'github') {
    const readme = typeof extra?.readme_excerpt === 'string' ? extra.readme_excerpt : '';
    if (readme) {
      const re = /<img[^>]*\bsrc="([^"]+\.(?:png|jpg|jpeg|gif|webp))"/gi;
      let m;
      while ((m = re.exec(readme)) !== null) {
        candidates.push(m[1]);
        if (candidates.length >= 8) break;
      }
    }
  } else if (sourceType === 'product_hunt') {
    if (Array.isArray(media)) {
      const arr = media as Array<{ type?: string; url?: string; role?: string }>;
      for (const x of arr) {
        if (typeof x?.url === 'string' && x.role !== 'logo' && x.type === 'image') {
          candidates.push(x.url);
          if (candidates.length >= 8) break;
        }
      }
    }
  }

  for (let i = 0; i < Math.min(candidates.length, 8); i++) {
    const result = await tryFetchPosterImage(candidates[i], request);
    if (result) return result;
  }
  return undefined;
}

async function tryFetchPosterImage(
  rawUrl: string,
  request: Request,
): Promise<{ dataUri: string; aspectRatio?: number } | undefined> {
  let url = rawUrl;
  // /r/* immutable hash 资源永远拉 prod（staging R2 不 mirror）
  if (url.startsWith('/r/')) {
    url = 'https://api.ai-feeds.com' + url;
  } else if (url.startsWith('/')) {
    const { api } = originsFor(request);
    url = api + url;
  }
  // PH imgix：限宽 1080 减小 fetch 体积
  if (url.includes('ph-files.imgix.net')) {
    const u = new URL(url);
    u.searchParams.set('w', '1080');
    u.searchParams.set('fit', 'max');
    url = u.toString();
  }

  try {
    const res = await fetch(url, {
      cf: { cacheTtl: 86400, cacheEverything: true },
      headers: { 'User-Agent': 'ai-feeds-poster-renderer/1.0' },
    });
    if (!res.ok) return undefined;
    const ct = res.headers.get('content-type') || 'image/png';
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 4 * 1024 * 1024) return undefined;

    // 质量门控（仅 PNG 能从字节流读维度；非 PNG 走通）
    const dim = probePngDimensions(buf);
    if (dim) {
      const ar = dim.width / dim.height;
      // 1) 宽高比检查：> 2（横长条）或 < 0.5（竖长条）→ 弃
      if (ar > 2 || ar < 0.5) {
        console.log(`[share-poster] reject ${rawUrl}: aspect ${ar.toFixed(2)}`);
        return undefined;
      }
      // 2) 字节密度（粗略反映信息熵）：byte / pixel 太低 = 大块纯色（icon/banner 多为此）
      // 经验阈值 0.18：内容截图 png 一般 0.5-2.0；icon/纯色 logo 普遍 0.05-0.15
      const density = buf.byteLength / (dim.width * dim.height);
      if (density < 0.18) {
        console.log(`[share-poster] reject ${rawUrl}: density ${density.toFixed(3)} (${dim.width}x${dim.height})`);
        return undefined;
      }
    }
    const b64 = arrayBufferToBase64(buf);
    return {
      dataUri: `data:${ct};base64,${b64}`,
      aspectRatio: dim ? dim.width / dim.height : undefined,
    };
  } catch (e) {
    console.error('[share-poster] media fetch failed:', rawUrl, e);
    return undefined;
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
  // checkAdminAuth 在 admin.ts，复用
  const { checkAdminAuth } = await import('../admin');
  if (!checkAdminAuth(request, env)) {
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
  // X / podcast / arxiv / 等 → /t/<full_id>
  // GitHub → /g/<owner>/<repo>
  if (itemId.startsWith('github:')) {
    const repo = itemId.slice('github:'.length); // 形如 'owner/repo'
    return `/g/${repo}`;
  }
  // 其他 source 走通用详情页 /t/<id>
  return `/t/${encodeURIComponent(itemId)}`;
}
