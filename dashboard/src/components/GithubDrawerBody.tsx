import { useEffect, useState } from "react";
import type { GithubMetrics, Item, ItemExtra } from "../types";
import type { MetricsSnapshotGh } from "../api";
import { fetchItem } from "../api";
import { cn, formatCompact, ordinal, parseJsonField } from "../lib/utils";
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

  // Live metrics (latest snapshot) — fall back to metrics column for new items
  const stars = metrics.stars ?? metrics.total_stars;
  const forks = metrics.forks;
  const watchers = metrics.watchers;
  const [latestMetrics, setLatestMetrics] = useState<MetricsSnapshotGh | null>(null);
  const openIssues = latestMetrics?.open_issues ?? metrics.open_issues;
  const openPrs = latestMetrics?.open_prs ?? metrics.open_prs;

  // Tab state — only relevant when readme is non-Chinese
  const showTabs = readmeLang !== "zh";
  const [tab, setTab] = useState<"orig" | "zh">(showTabs ? "orig" : "orig");

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

  return (
    <div className="text-neutral-900">
      {/* repo 头部 */}
      <div className="border-b border-neutral-100 p-5">
        <div className="flex items-start gap-3">
          <img
            src={ownerAvatar}
            alt={owner}
            className="h-12 w-12 shrink-0 rounded-full bg-neutral-200 object-cover"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[16px] font-bold leading-tight break-words">{ownerRepo}</div>
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
          </div>
          {category && (
            <span className={cn(
              "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium",
              CATEGORY_STYLE[category] || CATEGORY_STYLE.other,
            )}>
              {category}
            </span>
          )}
        </div>

        {/* 排名 chip */}
        {dailyRank && (
          <div className="mt-3">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[12px] text-neutral-700 ring-1 ring-amber-200">
              {dateMd && <span className="font-medium tabular-nums">{dateMd}</span>}
              <IconLeaderboard className="h-3.5 w-3.5 text-amber-500" />
              <span className="font-semibold tabular-nums">{ordinal(dailyRank)}</span>
              <span className="text-neutral-500">· GitHub 热榜</span>
            </span>
          </div>
        )}

        {/* 项目元数据：License / Issues / PRs（commit 暂未抓） */}
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
        </div>

        {/* contributors */}
        {contributorsInline.length > 0 && (
          <div className="mt-2.5 inline-flex items-center gap-2">
            <span className="flex items-center -space-x-1.5">
              {contributorsInline.slice(0, 5).map((c) => (
                <img
                  key={c.login}
                  src={c.avatar_url}
                  alt={c.login}
                  className="h-5 w-5 rounded-full border-2 border-white bg-neutral-200"
                  onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                />
              ))}
            </span>
            {contributorsCount && (
              <span className="text-[11px] text-neutral-500">{contributorsCount} contributors</span>
            )}
          </div>
        )}
      </div>

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
            {showTabs && readmeTranslated && (
              <div className="flex gap-1 rounded-md bg-neutral-100 p-0.5">
                <button
                  onClick={() => setTab("orig")}
                  className={cn(
                    "rounded px-2.5 py-1 text-[11px]",
                    tab === "orig" ? "bg-white font-semibold text-neutral-900 shadow-sm" : "text-neutral-600 hover:text-neutral-900",
                  )}
                >
                  English
                </button>
                <button
                  onClick={() => setTab("zh")}
                  className={cn(
                    "rounded px-2.5 py-1 text-[11px]",
                    tab === "zh" ? "bg-white font-semibold text-neutral-900 shadow-sm" : "text-neutral-600 hover:text-neutral-900",
                  )}
                >
                  中文
                </button>
              </div>
            )}
          </div>
          <pre className="prose prose-sm max-w-none whitespace-pre-wrap break-words p-5 text-[13px] leading-relaxed text-neutral-700">
            {readmeToShow || (showTabs && tab === "zh" ? "翻译尚未生成（异步任务）" : readmeRaw)}
          </pre>
        </div>
      )}
    </div>
  );
}
