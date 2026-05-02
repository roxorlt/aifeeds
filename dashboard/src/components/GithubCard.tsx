import { useState } from "react";
import type { GithubMetrics, Item, ItemExtra } from "../types";
import { cn, formatCompact, ordinal, parseJsonField } from "../lib/utils";
import { useDrawer } from "../lib/drawer";
import {
  IconLeaderboard,
  IconRepoForked,
  IconStarFill,
  IconWatching,
} from "./icons";

const CATEGORY_STYLE: Record<string, string> = {
  agent: "bg-violet-100 text-violet-700",
  model: "bg-rose-100 text-rose-700",
  tool: "bg-blue-100 text-blue-700",
  infra: "bg-orange-100 text-orange-700",
  app: "bg-emerald-100 text-emerald-700",
  tutorial: "bg-amber-100 text-amber-700",
  other: "bg-neutral-100 text-neutral-700",
};

function langDot(lang: string | null | undefined) {
  if (!lang) return null;
  // Approx GitHub language colors for the common ones
  const colors: Record<string, string> = {
    Python: "bg-blue-400",
    JavaScript: "bg-yellow-300",
    TypeScript: "bg-sky-500",
    Go: "bg-cyan-400",
    Rust: "bg-orange-500",
    C: "bg-neutral-400",
    "C++": "bg-pink-400",
    Java: "bg-red-500",
    Ruby: "bg-red-600",
    Shell: "bg-green-500",
    Swift: "bg-orange-400",
    Kotlin: "bg-purple-500",
    HTML: "bg-orange-300",
    CSS: "bg-blue-300",
    Vue: "bg-emerald-400",
  };
  return colors[lang] || "bg-neutral-300";
}

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
}

export function GithubCard({ item }: Props) {
  const [expanded, setExpanded] = useState(false);
  const drawer = useDrawer();

  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<GithubMetrics>(item.metrics) ?? ({} as GithubMetrics);

  const ownerRepo = item.title || item.source_id || "";
  const owner = item.author || ownerRepo.split("/")[0] || "";
  const ownerAvatar = `https://avatars.githubusercontent.com/${owner}`;

  const language = (metrics as Record<string, unknown>).language as string | undefined
    || (extra as Record<string, unknown>).language as string | undefined
    || null;

  const stars = metrics.stars ?? metrics.total_stars;
  const forks = metrics.forks;
  const watchers = metrics.watchers;
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

  return (
    <article
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <div className="flex items-start gap-3">
        <img
          src={ownerAvatar}
          alt={owner}
          className="h-10 w-10 shrink-0 rounded-full bg-neutral-200 object-cover"
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
        />
        <div className="min-w-0 flex-1">
          {/* Header row: title + meta + category badge（徽章浮在右侧顶部） */}
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <div className="text-[15px] font-bold leading-tight text-neutral-900 break-words">
                {ownerRepo}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-neutral-500">
                {language && (
                  <span className="inline-flex items-center gap-1">
                    <span className={cn("h-2 w-2 rounded-full", langDot(language))} />
                    {language}
                  </span>
                )}
                {language && stars !== undefined && <span className="text-neutral-400">·</span>}
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
            </div>
            {category && (
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                  CATEGORY_STYLE[category] || CATEGORY_STYLE.other,
                )}
              >
                {category}
              </span>
            )}
          </div>

          {/* Summary（缩进对齐到标题，跟 X card 推文正文一致字号 15 / 1.45） */}
          {summary && (
            <>
              <p
                className={cn(
                  "mt-2 text-[15px] leading-[1.45] text-neutral-900 break-words",
                  !expanded && "line-clamp-3",
                )}
              >
                {summary}
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

          {/* Footer 行 */}
          <div className="mt-3 flex items-center justify-between text-[12px] text-neutral-500">
            {(dateMd || dailyRank) && (
          <span
            className="inline-flex cursor-help items-center gap-1.5"
            title={
              dailyRank && dateMd
                ? `${dateMd.replace("-", " 月 ")} 日 GitHub 热榜第 ${dailyRank} 名`
                : ""
            }
          >
            {dateMd && <span className="font-medium tabular-nums">{dateMd}</span>}
            {dailyRank && (
              <>
                <IconLeaderboard className="h-3.5 w-3.5 text-amber-500" />
                <span className="font-semibold tabular-nums text-neutral-700">
                  {ordinal(dailyRank)}
                </span>
              </>
            )}
          </span>
        )}
        {contributorsInline.length > 0 && (
          <span className="inline-flex items-center gap-2">
            <span className="flex items-center -space-x-1.5">
              {contributorsInline.slice(0, 3).map((c) => (
                <img
                  key={c.login}
                  src={c.avatar_url}
                  alt={c.login}
                  className="h-5 w-5 rounded-full border-2 border-white bg-neutral-200"
                  onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                />
              ))}
            </span>
            {contributorsCount && contributorsCount > 0 && (
              <span className="text-neutral-500">{contributorsCount} contributors</span>
            )}
          </span>
        )}
          </div>
        </div>
      </div>
    </article>
  );
}
