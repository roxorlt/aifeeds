import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { Components } from "react-markdown";
import type { GithubMetrics, Item, ItemExtra, MediaItem } from "../types";
import type { MetricsSnapshotGh } from "../api";
import { fetchItem } from "../api";
import { cn, formatCompact, ordinal, parseJsonField, proxyImg, timeAgo, timeAgoOrDate } from "../lib/utils";
import { langDotClass } from "../lib/githubLang";
import { extractFirstReadmeImage } from "./GithubCard";
import { Lightbox } from "./Lightbox";
import {
  IconLeaderboard,
  IconRepoForked,
  IconStarFill,
  IconWatching,
} from "./icons";

// dashboard origin（CF Pages）≠ worker origin（api.ai-feeds.com）；
// /r/<key> R2 反代在 worker 那边，dashboard 端访问要走 worker base。
// 之前老注释说"leave as same-origin"是 dashboard 和 worker 同源时代的逻辑
// (dashboard 部署在 ai-feeds.com 时假设 worker /r/ 也走 same-origin 反代)，
// CF Pages 拆开后失效 — README 里所有 /r/ 图片在抽屉里都 404。
const API_BASE = import.meta.env.VITE_API_BASE || "https://api.ai-feeds.com";

// Resolve relative URLs in README to absolute URLs.
//   - "/r/..." (worker R2 proxy) → prefix API_BASE so request hits worker origin
//   - relative "assets/foo.png" → raw.githubusercontent.com/<owner>/<repo>/<branch>/assets/foo.png
//   - root-relative "/foo" (other than /r/) → raw.githubusercontent.com/<owner>/<repo>/<branch>/foo
//   - absolute http(s):/data:/blob:/mailto:/anchor → untouched
function resolveRelative(
  src: string | undefined,
  owner: string,
  repo: string,
  branch: string,
  type: "raw" | "page",
): string | undefined {
  if (!src) return src;
  if (/^(https?:|data:|blob:|mailto:|#)/i.test(src)) return src;
  // R2 proxy path (worker /r/<key>) — 必须 prefix worker base，dashboard origin 没这路由
  if (src.startsWith("/r/")) return `${API_BASE}${src}`;
  const base =
    type === "raw"
      ? `https://raw.githubusercontent.com/${owner}/${repo}/${branch || "main"}`
      : `https://github.com/${owner}/${repo}/blob/${branch || "main"}`;
  if (src.startsWith("/")) return `${base}${src}`;
  return `${base}/${src.replace(/^\.\//, "")}`;
}

// Extract image URLs from the readme markdown in render order, resolved
// to absolute (R2 / GitHub raw / external) URLs. Used to feed Lightbox.
export function extractReadmeImages(
  markdown: string,
  owner: string,
  repo: string,
  branch: string,
): MediaItem[] {
  const out: MediaItem[] = [];
  const seen = new Set<string>();
  const push = (rawSrc: string) => {
    const resolved = resolveRelative(rawSrc, owner, repo, branch, "raw");
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    out.push({ type: "image", url: resolved });
  };
  // Markdown ![alt](url "optional title")
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(markdown)) !== null) push(m[1]);
  // HTML <img src="url" .../>
  const htmlRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((m = htmlRe.exec(markdown)) !== null) push(m[1]);
  return out;
}

// Tailwind-styled markdown elements + relative-URL rewriter (closure-bound
// to owner/repo/branch so img/a in the README resolve to GitHub raw / blob).
// onImageClick: callback fired when user clicks an inline image, with the
// resolved URL — caller maps to lightbox index for opening.
function makeMarkdownComponents(
  owner: string,
  repo: string,
  branch: string,
  onImageClick?: (resolvedSrc: string) => void,
): Components {
  return {
    h1: ({ node: _node, ...props }) => (
      <h1 className="mt-5 mb-2 text-[18px] font-bold text-neutral-900" {...props} />
    ),
    h2: ({ node: _node, ...props }) => (
      <h2 className="mt-4 mb-2 text-[16px] font-bold text-neutral-900" {...props} />
    ),
    h3: ({ node: _node, ...props }) => (
      <h3 className="mt-3 mb-1.5 text-[14px] font-bold text-neutral-900" {...props} />
    ),
    h4: ({ node: _node, ...props }) => (
      <h4 className="mt-3 mb-1 text-[13px] font-semibold text-neutral-900" {...props} />
    ),
    p: ({ node: _node, ...props }) => (
      <p className="my-2 leading-relaxed text-neutral-700" {...props} />
    ),
    a: ({ node: _node, href, ...props }) => (
      <a
        href={resolveRelative(href, owner, repo, branch, "page")}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-600 hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
        {...props}
      />
    ),
    ul: ({ node: _node, ...props }) => (
      <ul className="my-2 list-disc pl-5 space-y-1 text-neutral-700" {...props} />
    ),
    ol: ({ node: _node, ...props }) => (
      <ol className="my-2 list-decimal pl-5 space-y-1 text-neutral-700" {...props} />
    ),
    li: ({ node: _node, ...props }) => <li {...props} />,
    code: ({ node: _node, className, children, ...props }) => {
      const isInline = !className?.includes("language-");
      if (isInline) {
        return (
          <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12px] text-neutral-800" {...props}>
            {children}
          </code>
        );
      }
      return (
        <code className={cn("font-mono text-[12px]", className)} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ node: _node, ...props }) => (
      <pre className="my-3 overflow-x-auto rounded-lg bg-neutral-50 p-3 ring-1 ring-neutral-200" {...props} />
    ),
    blockquote: ({ node: _node, ...props }) => (
      <blockquote className="my-3 border-l-2 border-neutral-300 pl-3 italic text-neutral-600" {...props} />
    ),
    hr: ({ node: _node, ...props }) => (
      <hr className="my-4 border-neutral-200" {...props} />
    ),
    img: ({ node: _node, src, ...props }) => {
      const resolved = resolveRelative(src as string | undefined, owner, repo, branch, "raw");
      return (
        <img
          src={resolved}
          className="my-2 max-w-full cursor-zoom-in rounded-md border border-neutral-200"
          loading="lazy"
          onClick={(e) => {
            // README 里 [![alt](src)](url) 这种"图片包链接"在 markdown 里
            // 渲染成 <a href><img/></a>。点 img 时事件冒泡到 anchor，
            // 触发其导航 default action — iOS 上装了 GitHub app 就被
            // universal link 拦截，整个跳出 ai-feeds。preventDefault 阻
            // 止 anchor 的默认导航，stopPropagation 防 anchor 自己的
            // onClick 也跑（虽然现在 a 的 onClick 只 stopPropagation
            // 没别的副作用，但保险起见）。Lightbox 正常打开。
            e.preventDefault();
            e.stopPropagation();
            if (resolved && onImageClick) onImageClick(resolved);
          }}
          onError={(e) => {
            // Hide broken images instead of showing the broken-link icon.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
          {...props}
        />
      );
    },
    table: ({ node: _node, ...props }) => (
      <div className="my-3 overflow-x-auto">
        <table className="min-w-full border-collapse text-[12px]" {...props} />
      </div>
    ),
    th: ({ node: _node, ...props }) => (
      <th className="border border-neutral-200 bg-neutral-50 px-2 py-1 text-left font-semibold" {...props} />
    ),
    td: ({ node: _node, ...props }) => (
      <td className="border border-neutral-200 px-2 py-1" {...props} />
    ),
  };
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

interface Props {
  item: Item;
}

export function GithubDrawerBody({ item }: Props) {
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<GithubMetrics>(item.metrics) ?? ({} as GithubMetrics);

  const ownerRepo = item.title || item.source_id || "";
  const owner = item.author || ownerRepo.split("/")[0] || "";
  const ownerAvatar = `https://avatars.githubusercontent.com/${owner}`;
  const summary = extra.ai_summary || "";
  const category = extra.ai_category as string | null | undefined;
  const dailyRank = extra.daily_rank as number | null | undefined;
  const trendingDate = extra.trending_date_str || "";
  const dateMd = trendingDate ? trendingDate.slice(5) : "";
  const license = extra.license_spdx as string | null | undefined;
  const readmeRaw = extra.readme_excerpt as string | null | undefined;
  const readmeTranslated = extra.readme_translated as string | null | undefined;
  const readmeLang = item.lang || "other";
  const contributorsInline = (extra.contributors_inline as Array<{ login: string; avatar_url: string }>) || [];
  const contributorsCount = (extra.contributors_count as number | null | undefined) ?? null;
  const recentCommits = (extra.recent_commits as Array<{
    sha: string;
    message: string;
    author: string;
    avatar: string | null;
    date: string;
    url: string;
  }> | null) || null;

  const language = ((metrics as Record<string, unknown>).language as string | undefined)
    || ((extra as unknown as Record<string, unknown>).language as string | undefined)
    || null;

  // Live metrics (latest snapshot) — fall back to metrics column for new items
  const stars = metrics.stars ?? metrics.total_stars;
  const forks = metrics.forks;
  const watchers = metrics.watchers;
  const [latestMetrics, setLatestMetrics] = useState<MetricsSnapshotGh | null>(null);
  const openIssues = latestMetrics?.open_issues ?? metrics.open_issues;
  const openPrs = latestMetrics?.open_prs ?? metrics.open_prs;

  // Tab state — only relevant when readme is non-Chinese.
  // Default to '译文' if translation already available (saves a click for
  // Chinese readers); otherwise '原文'.
  const showTabs = readmeLang !== "zh";
  const [tab, setTab] = useState<"orig" | "zh">(
    showTabs && readmeTranslated ? "zh" : "orig",
  );

  // Lightbox state for README images (mirrors X TweetCard behavior).
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // 提交记录折叠（PR6 反馈：默认收起，点击 meta 行的「提交记录」展开）
  const [showCommits, setShowCommits] = useState(false);

  useEffect(() => {
    // Pull metrics_history to surface freshest open_issues / open_prs.
    let cancelled = false;
    fetchItem(item.id).then((resp) => {
      if (cancelled) return;
      const hist = resp.metrics_history;
      if (hist && hist.length > 0) {
        setLatestMetrics(hist[hist.length - 1]);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [item.id]);

  const readmeToShow = tab === "zh" ? readmeTranslated : readmeRaw;

  // Markdown components closure-bound to repo info so img/a resolve relative
  // URLs to the right GitHub raw / blob URL. Click on inline image opens
  // Lightbox at the matching index.
  const repoName = ownerRepo.split("/")[1] || "";
  const defaultBranch = (extra.default_branch as string | undefined) || "main";
  const readmeImages = useMemo(
    () => extractReadmeImages(readmeToShow || readmeRaw || "", owner, repoName, defaultBranch),
    [readmeToShow, readmeRaw, owner, repoName, defaultBranch],
  );

  // Hero cover image：跟流内 GithubCard / 分享海报用同一张图源（README
  // 第一张 <img>），保证从 feed 点进抽屉后顶部 hero 视觉延续
  const heroCover = useMemo(() => {
    const readme = (extra as Record<string, unknown>).readme_excerpt;
    if (typeof readme !== "string" || !owner || !repoName) return null;
    return extractFirstReadmeImage(readme, owner, repoName, defaultBranch);
  }, [extra, owner, repoName, defaultBranch]);
  const [heroCoverFailed, setHeroCoverFailed] = useState(false);
  const markdownComponents = useMemo(
    () =>
      makeMarkdownComponents(owner, repoName, defaultBranch, (resolvedSrc) => {
        const idx = readmeImages.findIndex((m) => m.url === resolvedSrc);
        if (idx >= 0) setLightboxIndex(idx);
      }),
    [owner, repoName, defaultBranch, readmeImages],
  );

  return (
    <div className="text-neutral-900">
      {/* repo 头部 — 布局对齐 GithubCard：标题 + 右上角 rank pill / lang+cat / metrics / meta */}
      <div className="border-b border-neutral-100 p-5">
        <div className="flex items-start gap-3">
          <img
            src={proxyImg(ownerAvatar, 80)}
            alt={owner}
            className="h-12 w-12 shrink-0 rounded-full bg-neutral-200 object-cover"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
          <div className="min-w-0 flex-1">
            {/* 第一行：标题 + 右上角 rank pill */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div
                  data-drawer-title-anchor
                  className="text-[16px] font-bold leading-tight break-words"
                >
                  {ownerRepo}
                </div>
              </div>
              {dailyRank && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-neutral-700 ring-1 ring-amber-200">
                  {dateMd && <span className="font-medium tabular-nums">{dateMd}</span>}
                  <IconLeaderboard className="h-3 w-3 text-amber-500" />
                  <span className="font-semibold tabular-nums">{ordinal(dailyRank)}</span>
                </span>
              )}
            </div>

            {/* 第二行：Lang + Category */}
            {(language || category) && (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-neutral-500">
                {language && (
                  <span className="inline-flex items-center gap-1">
                    <span className={cn("h-2 w-2 rounded-full", langDotClass(language))} />
                    {language}
                  </span>
                )}
                {language && category && <span className="text-neutral-400">·</span>}
                {category && (
                  <span className={cn(
                    "rounded-full px-2 py-0.5 text-[11px] font-medium",
                    CATEGORY_STYLE[category] || CATEGORY_STYLE.other,
                  )}>
                    {category}
                  </span>
                )}
              </div>
            )}

            {/* 第三行：stars / forks / watchers */}
            {(stars !== undefined || forks !== undefined || watchers !== undefined) && (
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-neutral-500">
                {stars !== undefined && (
                  <span className="inline-flex items-center gap-1">
                    <IconStarFill className="h-3.5 w-3.5" />
                    {formatCompact(stars)}
                  </span>
                )}
                {forks !== undefined && <span className="text-neutral-400">·</span>}
                {forks !== undefined && (
                  <span className="inline-flex items-center gap-1">
                    <IconRepoForked className="h-3.5 w-3.5" />
                    {formatCompact(forks)}
                  </span>
                )}
                {watchers !== undefined && <span className="text-neutral-400">·</span>}
                {watchers !== undefined && (
                  <span className="inline-flex items-center gap-1">
                    <IconWatching className="h-3.5 w-3.5" />
                    {formatCompact(watchers)}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 项目元数据：License / Issues / PRs / 最近提交（点"提交记录"展开列表） */}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-neutral-600">
          {license && (
            <span>License: <span className="font-medium text-neutral-900">{license}</span></span>
          )}
          {openIssues !== undefined && openIssues !== null && (
            <span>Issues: <span className="font-medium text-neutral-900">{openIssues}</span></span>
          )}
          {openPrs !== undefined && openPrs !== null && (
            <span>PRs: <span className="font-medium text-neutral-900">{openPrs}</span></span>
          )}
          {recentCommits && recentCommits.length > 0 && recentCommits[0]?.date && (
            <span>
              commit{" "}
              <span className="font-medium text-neutral-900">
                {timeAgoOrDate(recentCommits[0].date)}
              </span>
            </span>
          )}
          {recentCommits && recentCommits.length > 0 && (
            <button
              type="button"
              onClick={() => setShowCommits((v) => !v)}
              className="inline-flex items-center gap-0.5 text-sky-600 hover:text-sky-700 hover:underline"
              aria-expanded={showCommits}
            >
              提交记录
              <span className="text-[10px]">{showCommits ? "▴" : "▾"}</span>
            </button>
          )}
        </div>

        {/* 折叠的 commit 明细列表 */}
        {showCommits && recentCommits && recentCommits.length > 0 && (
          <ul className="mt-3 space-y-1.5 border-t border-neutral-100 pt-3">
            {recentCommits.map((c) => (
              <li key={c.sha} className="flex items-start gap-2 text-[12px]">
                {c.avatar ? (
                  <img
                    src={proxyImg(c.avatar, 80)}
                    alt={c.author}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded-full bg-neutral-200 object-cover"
                    onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                  />
                ) : (
                  <span className="mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full bg-neutral-200" />
                )}
                <div className="min-w-0 flex-1">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-neutral-900 hover:text-neutral-700 hover:underline line-clamp-1 break-all"
                    title={c.message}
                  >
                    {c.message}
                  </a>
                  <div className="mt-0.5 text-[11px] text-neutral-500">
                    <span className="font-mono">{c.sha}</span>
                    {c.author && <span> · {c.author}</span>}
                    {c.date && <span> · {timeAgo(c.date)}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {/* contributors — inline 头像可空但有 count 时仍显示文字（兜底新数据
            scraper 落 contributors_count 但漏 contributors_inline 的情况） */}
        {(contributorsInline.length > 0 || (contributorsCount && contributorsCount > 0)) && (
          <div className="mt-2.5 inline-flex items-center gap-2">
            {contributorsInline.length > 0 && (
              <span className="flex items-center -space-x-1.5">
                {contributorsInline.slice(0, 5).map((c) => (
                  <img
                    key={c.login}
                    src={proxyImg(c.avatar_url, 80)}
                    alt={c.login}
                    className="h-5 w-5 rounded-full border-2 border-white bg-neutral-200"
                    onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                  />
                ))}
              </span>
            )}
            {contributorsCount && (
              <span className="text-[11px] text-neutral-500">{contributorsCount} contributors</span>
            )}
          </div>
        )}
      </div>

      {/* Hero cover image — 跟流内 GithubCard / 分享海报用同一张图源（README
          第一张 <img>），保持视觉延续：用户从 feed 点进抽屉，顶部第一眼仍是
          同一张 cover，再往下是 summary + README。w=800 因为抽屉宽度比流内
          卡片大约 2 倍，物理像素更高保证清晰度 */}
      {heroCover && !heroCoverFailed && (
        <div className="border-b border-neutral-100">
          <img
            src={proxyImg(heroCover, 800)}
            alt=""
            loading="lazy"
            className="w-full bg-neutral-100 object-cover"
            style={{ aspectRatio: "16/9" }}
            onError={() => setHeroCoverFailed(true)}
          />
        </div>
      )}

      {/* AI summary */}
      {summary && (
        <div className="border-b border-neutral-100 p-5">
          <p className="text-[14px] leading-relaxed text-neutral-700">{summary}</p>
        </div>
      )}

      {/* README + 条件 tab */}
      {readmeRaw && (
        <div>
          <div className="flex items-center justify-between border-b border-neutral-100 px-5 pt-5 pb-2">
            <h3 className="text-[13px] font-semibold text-neutral-900">README</h3>
            {showTabs && (
              <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5">
                <button
                  onClick={() => setTab("orig")}
                  className={cn(
                    "rounded px-2.5 py-1 text-[11px]",
                    tab === "orig" ? "bg-white font-semibold text-neutral-900 shadow-sm" : "text-neutral-600 hover:text-neutral-900",
                  )}
                >
                  原文
                </button>
                <button
                  onClick={() => setTab("zh")}
                  className={cn(
                    "rounded px-2.5 py-1 text-[11px]",
                    tab === "zh" ? "bg-white font-semibold text-neutral-900 shadow-sm" : "text-neutral-600 hover:text-neutral-900",
                  )}
                >
                  译文
                </button>
              </div>
            )}
          </div>
          <div className="max-w-none break-words p-5 text-[13px]">
            {tab === "zh" && !readmeTranslated ? (
              <p className="text-neutral-400">译文还没准备好，稍后再看</p>
            ) : (
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={markdownComponents}
              >
                {readmeToShow || readmeRaw}
              </Markdown>
            )}
          </div>
        </div>
      )}

      {/* Lightbox for README images (mirrors X TweetCard behavior). */}
      {lightboxIndex !== null && readmeImages.length > 0 && (
        <Lightbox
          media={readmeImages}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
