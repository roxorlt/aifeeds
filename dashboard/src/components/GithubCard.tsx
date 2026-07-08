import { useMemo, useState } from "react";
import type { GithubMetrics, Item, ItemExtra } from "../types";
import { cn, formatCompact, ordinal, parseJsonField, proxyImg } from "../lib/utils";
import { smartTruncate } from "../lib/truncate";
import { useDrawer } from "../lib/drawer";
import { useImpressionRefresh } from "../lib/impressionRefresh";
import { langDotClass } from "../lib/githubLang";
import {
  IconLeaderboard,
  IconRepoForked,
  IconStarFill,
  IconWatching,
} from "./icons";
import { HL } from "./search/highlight";

// dashboard origin（CF Pages） != worker origin（api.ai-feeds.com）；
// /r/<key> R2 反代在 worker 那边，dashboard 端不能用相对路径访问。
const API_BASE = import.meta.env.VITE_API_BASE || "https://api.ai-feeds.com";

// 从 README excerpt 抽第一张可用 cover image。逻辑同 worker
// share/handlers.ts (line 471-491)：那边给分享海报选 cover，dashboard
// 这边给 feed 卡片选 cover，挑同一张，保证用户看到的卡片预览跟分享出去的海报一致。
//
// 排除 SVG（大部分是 shields/badges）+ 已知 badge host。相对路径 resolve 到
// raw.githubusercontent.com；/r/ 路径拼 worker API base（worker 才有 /r/ 路由）。
function extractFirstReadmeImage(
  readme: string,
  owner: string,
  repo: string,
  branch: string,
): string | null {
  const urls: string[] = [];
  // Markdown ![alt](url)
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(readme)) !== null) urls.push(m[1]);
  // HTML <img src="url">
  const htmlRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((m = htmlRe.exec(readme)) !== null) urls.push(m[1]);
  if (urls.length === 0) return null;
  const isBadge = (u: string): boolean =>
    /\.svg(\?|$)/i.test(u) ||
    /(shields\.io|badgen\.net|badge\.fury|forthebadge|img\.shields)/i.test(u);
  const picked = urls.find((u) => !isBadge(u)) || urls[0];
  if (!picked) return null;
  if (/^(https?:|data:|blob:)/i.test(picked)) return picked;
  // /r/<key> 是 worker R2 反代路由（不在 dashboard origin）→ 拼 API base
  if (picked.startsWith("/r/")) return `${API_BASE}${picked}`;
  const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch || "main"}`;
  if (picked.startsWith("/")) return `${base}${picked}`;
  return `${base}/${picked.replace(/^\.\//, "")}`;
}

const CATEGORY_STYLE: Record<string, string> = {
  agent: "bg-violet-100 text-violet-700",
  model: "bg-rose-100 text-rose-700",
  tool: "bg-blue-100 text-blue-700",
  infra: "bg-orange-100 text-orange-700",
  app: "bg-emerald-100 text-emerald-700",
  tutorial: "bg-amber-100 text-amber-700",
  other: "bg-neutral-100 text-neutral-700",
};


function bjtDateFromIso(isoOrTs: string | number | undefined | null): string {
  if (!isoOrTs) return "";
  let date: Date;
  if (typeof isoOrTs === "number") {
    date = new Date(isoOrTs * 1000);
  } else {
    date = new Date(isoOrTs);
  }
  if (isNaN(date.getTime())) return "";
  // Format MM-DD in BJT
  const bjtMs = date.getTime() + (date.getTimezoneOffset() + 480) * 60 * 1000;
  const bjt = new Date(bjtMs);
  return `${String(bjt.getMonth() + 1).padStart(2, "0")}-${String(bjt.getDate()).padStart(2, "0")}`;
}

interface Props {
  item: Item;
  // 首屏前几张卡(Feed 传入):封面图 eager + fetchPriority=high,LCP 优化
  eager?: boolean;
}

export function GithubCard({ item, eager }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  // onLoad 后检测真实 natural dims，aspect 极端 / 太小（banner / badge / repo icon）
  // 视为低信息密度图，不当流内 cover。同 worker share/handlers.ts:701 同款门控。
  const [coverRejected, setCoverRejected] = useState(false);
  const drawer = useDrawer();

  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<GithubMetrics>(item.metrics) ?? ({} as GithubMetrics);

  const ownerRepo = item.title || item.source_id || "";
  const owner = item.author || ownerRepo.split("/")[0] || "";
  const repo = ownerRepo.split("/")[1] || "";
  const branch = (extra as Record<string, unknown>).default_branch as string | undefined;
  const ownerAvatar = `https://avatars.githubusercontent.com/${owner}`;

  // README 第一张 cover image — 跟 worker 分享海报用同一张图源（README excerpt 里的 <img>），
  // 保证用户在 feed 看到的卡片预览和分享出去的海报封面一致。
  const coverImage = useMemo(() => {
    const readme = (extra as Record<string, unknown>).readme_excerpt;
    if (typeof readme !== "string" || !owner || !repo) return null;
    return extractFirstReadmeImage(readme, owner, repo, branch || "main");
  }, [extra, owner, repo, branch]);

  const language = (metrics as Record<string, unknown>).language as string | undefined
    || (extra as Record<string, unknown>).language as string | undefined
    || null;

  const stars = metrics.stars ?? metrics.total_stars;
  const forks = metrics.forks;
  const watchers = metrics.watchers;
  // issues/PRs/commit 不在 feed 卡片展示，抽屉里仍会读 metrics.* 显示
  const summary = extra.ai_summary || "";
  const category = extra.ai_category as string | null | undefined;
  const dailyRank = extra.daily_rank as number | null | undefined;
  const trendingDate = extra.trending_date_str || bjtDateFromIso(item.published_at);
  const dateMd = trendingDate ? trendingDate.slice(5) : "";
  const contributorsInline = (extra.contributors_inline as Array<{ login: string; avatar_url: string }>) || [];
  const contributorsCount = (extra.contributors_count as number | null | undefined) ?? null;

  function open() {
    drawer.openItem(item);
  }

  // BE §5b: 视口停留 500ms 弱触发 metrics refresh
  const refreshRef = useImpressionRefresh(item.id);

  return (
    <article
      ref={refreshRef}
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <div className="flex items-start gap-3">
        <img
          src={proxyImg(ownerAvatar, 80)}
          alt={owner}
          loading="lazy"
          decoding="async"
          className="h-10 w-10 shrink-0 rounded-full bg-neutral-200 object-cover"
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
        />
        <div className="min-w-0 flex-1">
          {/* 第一行：标题 + 右上角 rank pill（替代原 category 徽章位置） */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-bold leading-tight text-neutral-900 break-words">
                <HL text={ownerRepo} />
              </div>
            </div>
            {dailyRank && (
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-neutral-700 ring-1 ring-amber-200">
                {dateMd && <span className="whitespace-nowrap font-medium tabular-nums">{dateMd}</span>}
                <IconLeaderboard className="h-3 w-3 text-amber-500" />
                <span className="whitespace-nowrap font-semibold tabular-nums">{ordinal(dailyRank)}</span>
              </span>
            )}
          </div>

          {/* 第二行：Lang + Category（同一行；category 不再放右上角） */}
          {(language || category) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-neutral-500">
              {language && (
                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
                  <span className={cn("h-2 w-2 rounded-full", langDotClass(language))} />
                  {language}
                </span>
              )}
              {language && category && <span className="shrink-0 text-neutral-400">·</span>}
              {category && (
                <span
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
                    CATEGORY_STYLE[category] || CATEGORY_STYLE.other,
                  )}
                >
                  {category}
                </span>
              )}
            </div>
          )}

          {/* feed 卡片不再显示 stars/forks/watchers（下移到 footer 跟 PH
              vote/comments 同位置）+ issues/PRs/commit（feed 不展示，
              抽屉里保留）。让 meta 区紧凑，正文获得更多视觉重心。 */}

        </div>
      </div>

      {/* Summary 跨整张卡宽（不再缩进到 avatar 右），meta 行保留在 avatar 右列。
          PH/GH 走 YouTube 卡片风格：标题块紧凑头部，正文 + footer 占满宽度，
          跟 X 推文（严格左对齐）的视觉风格区分。 */}
      {summary && (
        <>
          <p
            className={cn(
              "mt-2 text-[15px] leading-[1.45] text-neutral-900 break-words",
              !expanded && "line-clamp-4",
            )}
          >
            <HL text={expanded ? summary : smartTruncate(summary, 280)} />
          </p>
          {!expanded && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded(true);
              }}
              className="mt-1 text-[14px] text-sky-600 hover:underline"
            >
              展开
            </button>
          )}
        </>
      )}

      {/* Cover image（README 第一张可用图）— 放 summary 后 footer 前，
          跟分享海报用同一张图源（worker share/handlers.ts 同款提取策略）。
          onError 兜底：图挂了直接隐藏；onLoad 后做 aspect/size 质量门控，
          banner / badge / 小 icon 等低信息密度图视为不合格隐藏 */}
      {coverImage && !coverFailed && !coverRejected && (
        <img
          src={proxyImg(coverImage, 400)}
          alt=""
          loading={eager ? "eager" : "lazy"}
          fetchPriority={eager ? "high" : undefined}
          className="mt-2.5 aspect-[16/9] w-full rounded-2xl border border-neutral-200 bg-neutral-100 object-cover"
          onError={() => setCoverFailed(true)}
          onLoad={(e) => {
            const w = e.currentTarget.naturalWidth;
            const h = e.currentTarget.naturalHeight;
            if (!w || !h) return;
            const ar = w / h;
            const maxDim = Math.max(w, h);
            if (ar > 2 || ar < 0.5 || maxDim < 240) setCoverRejected(true);
          }}
        />
      )}

      {/* Footer 跨整张卡宽：左 stars/forks/watchers（跟 PH 卡片 vote/comments
          位置一致），右 contributors（头像 + count）— 跟 PH 的 makers 行同款
          排版对齐三个源 */}
      {(stars !== undefined || forks !== undefined || watchers !== undefined || contributorsInline.length > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-neutral-500">
          {stars !== undefined && (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
              <IconStarFill className="h-3.5 w-3.5" />
              <span className="tabular-nums whitespace-nowrap">{formatCompact(stars)}</span>
            </span>
          )}
          {forks !== undefined && (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
              <IconRepoForked className="h-3.5 w-3.5" />
              <span className="tabular-nums whitespace-nowrap">{formatCompact(forks)}</span>
            </span>
          )}
          {watchers !== undefined && (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" title={`${watchers} watchers`}>
              <IconWatching className="h-3.5 w-3.5" />
              <span className="tabular-nums whitespace-nowrap">{formatCompact(watchers)}</span>
            </span>
          )}
          {(contributorsInline.length > 0 || (contributorsCount && contributorsCount > 0)) && (
            <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5 text-neutral-500">
              {contributorsInline.length > 0 && (
                <span className="flex shrink-0 -space-x-1.5">
                  {contributorsInline.slice(0, 3).map((c) => (
                    <img
                      key={c.login}
                      src={proxyImg(c.avatar_url, 80)}
                      alt={c.login}
                      loading="lazy"
                      decoding="async"
                      className="h-5 w-5 rounded-full border border-white bg-neutral-200"
                      onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                    />
                  ))}
                </span>
              )}
              {contributorsCount && contributorsCount > 0 && (
                <span className="min-w-0 truncate whitespace-nowrap text-[12px]">{contributorsCount} contributors</span>
              )}
            </span>
          )}
        </div>
      )}
    </article>
  );
}
