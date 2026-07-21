import { useState } from "react";
import type { GithubMetrics, Item, ItemExtra } from "../types";
import { buildResponsiveCardImage, cn, formatCompact, ordinal, parseJsonField, proxyImg, variantsForCurrentCover } from "../lib/utils";
import { smartTruncate } from "../lib/truncate";
import { useDrawer } from "../lib/drawerContext";
import { useImpressionRefresh } from "../lib/impressionRefresh";
import { langDotClass } from "../lib/githubLang";
import { resolveAssetUrl } from "../lib/asset";
import {
  LAZY_MEDIA_LOAD_POLICY,
  getMediaPriorityTelemetryLabel,
  type MediaLoadPolicy,
} from "../lib/mediaPriority";
import {
  IconLeaderboard,
  IconRepoForked,
  IconStarFill,
  IconWatching,
} from "./icons";
import { HL } from "./search/highlight";

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
  mediaPolicy?: MediaLoadPolicy;
}

export function GithubCard({
  item,
  mediaPolicy = LAZY_MEDIA_LOAD_POLICY,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverVariantFailed, setCoverVariantFailed] = useState(false);
  // onLoad 后检测真实 natural dims，aspect 极端 / 太小（banner / badge / repo icon）
  // 视为低信息密度图，不当流内 cover。同 worker share/handlers.ts:701 同款门控。
  const [coverRejected, setCoverRejected] = useState(false);
  const drawer = useDrawer();

  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<GithubMetrics>(item.metrics) ?? ({} as GithubMetrics);

  const ownerRepo = item.title || item.source_id || "";
  const owner = item.author || ownerRepo.split("/")[0] || "";
  const ownerAvatar = `https://avatars.githubusercontent.com/${owner}`;

  // Worker list DTO 已完成封面提取和相对路径解析；卡片不再下载或解析详情文档。
  const coverImage = extra.cover_url ? resolveAssetUrl(extra.cover_url) : null;
  const coverVariants = variantsForCurrentCover(
    extra.cover_url,
    extra.cover_variant_source,
    extra.cover_variants,
  );
  const coverSource = extra.cover_url
    ? buildResponsiveCardImage(extra.cover_url, coverVariants, { fallbackWidth: 400 })
    : null;

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

      {/* Cover image（Worker list DTO 的首张可用图）— 放 summary 后 footer 前。
          onError 兜底：图挂了直接隐藏；onLoad 后做 aspect/size 质量门控，
          banner / badge / 小 icon 等低信息密度图视为不合格隐藏 */}
      {coverImage && coverSource && !coverFailed && !coverRejected && (
        <picture className="mt-2.5 block">
          {coverSource.webpSrcSet && !coverVariantFailed && (
            <source type="image/webp" srcSet={coverSource.webpSrcSet} sizes="(max-width: 640px) calc(100vw - 32px), 400px" />
          )}
          <img
            src={coverSource.fallbackSrc}
            srcSet={coverSource.srcSet}
            sizes="(max-width: 640px) calc(100vw - 32px), 400px"
            width={800}
            height={450}
            alt=""
            loading={mediaPolicy.loading}
            fetchPriority={mediaPolicy.fetchPriority}
            decoding="async"
            data-feed-source={item.source_type}
            data-media-priority={getMediaPriorityTelemetryLabel(mediaPolicy)}
            className="aspect-[16/9] w-full rounded-2xl border border-neutral-200 bg-neutral-100 object-cover"
            onError={() => {
              if (coverSource.webpSrcSet && !coverVariantFailed) {
                setCoverVariantFailed(true);
              } else {
                setCoverFailed(true);
              }
            }}
            onLoad={(e) => {
              const w = e.currentTarget.naturalWidth;
              const h = e.currentTarget.naturalHeight;
              if (!w || !h) return;
              const ar = w / h;
              const maxDim = Math.max(w, h);
              if (ar > 2 || ar < 0.5 || maxDim < 240) setCoverRejected(true);
            }}
          />
        </picture>
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
