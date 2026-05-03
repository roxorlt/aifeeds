// Product Hunt card — feed item view (B variant from mockup
// docs/plans/_mockups/2026-05-03-ph-drawer-mockup.html top region):
//   logo (64×64) | rank badge · launch date · category · name · tagline · metrics row

import type { Item, ItemExtra, MediaItem, PhMetrics } from "../types";
import { cn, formatCompact, ordinal, parseJsonField } from "../lib/utils";
import { useDrawer } from "../lib/drawer";

function parseMedia(raw: Item["media"]): MediaItem[] {
  if (!raw) return [];
  if (typeof raw === "string") {
    try {
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw : [];
}

const AI_CATEGORY_STYLE: Record<string, { label: string; cls: string }> = {
  ai_code_editor:    { label: "AI Code Editor",    cls: "bg-violet-50 text-violet-700 ring-1 ring-violet-200" },
  ai_chatbot:        { label: "AI Chatbot",        cls: "bg-sky-50 text-sky-700 ring-1 ring-sky-200" },
  ai_agent:          { label: "AI Agent",          cls: "bg-rose-50 text-rose-700 ring-1 ring-rose-200" },
  ai_image_gen:      { label: "AI Image Gen",      cls: "bg-pink-50 text-pink-700 ring-1 ring-pink-200" },
  ai_video_gen:      { label: "AI Video Gen",      cls: "bg-fuchsia-50 text-fuchsia-700 ring-1 ring-fuchsia-200" },
  ai_audio:          { label: "AI Audio",          cls: "bg-amber-50 text-amber-700 ring-1 ring-amber-200" },
  ai_writing:        { label: "AI Writing",        cls: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" },
  ai_search:         { label: "AI Search",         cls: "bg-blue-50 text-blue-700 ring-1 ring-blue-200" },
  ai_dev_tool:       { label: "AI Dev Tool",       cls: "bg-cyan-50 text-cyan-700 ring-1 ring-cyan-200" },
  ai_workflow:       { label: "AI Workflow",       cls: "bg-orange-50 text-orange-700 ring-1 ring-orange-200" },
  ai_voice_agent:    { label: "AI Voice Agent",    cls: "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200" },
  ai_data_analysis:  { label: "AI Data Analysis",  cls: "bg-teal-50 text-teal-700 ring-1 ring-teal-200" },
  ai_design_tool:    { label: "AI Design Tool",    cls: "bg-lime-50 text-lime-700 ring-1 ring-lime-200" },
  ai_other:          { label: "AI",                cls: "bg-neutral-100 text-neutral-700 ring-1 ring-neutral-200" },
};

interface Props {
  item: Item;
}

export function PhCard({ item }: Props) {
  const drawer = useDrawer();
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<PhMetrics>(item.metrics) ?? ({} as PhMetrics);
  const media = parseMedia(item.media);

  const name = item.title || "?";
  const tagline = item.content_translated || item.content || "";
  const dailyRank = (extra as { daily_rank?: number }).daily_rank;
  const launchDate = extra.launch_date_pt || "";
  const dateMd = launchDate ? launchDate.slice(5) : ""; // "MM-DD"

  const aiCategory = (extra.ai_category as string) || "";
  const catStyle = AI_CATEGORY_STYLE[aiCategory];

  const logo = media.find((m: MediaItem) => (m as MediaItem & { role?: string }).role === "logo");
  const logoUrl = logo?.url;

  const votes = metrics.votes;
  const comments = metrics.comments;
  const makerHandle = item.handle || "";

  function open() {
    drawer.openItem(item);
  }

  return (
    <article
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <div className="flex items-start gap-3">
        {/* Logo */}
        {logoUrl ? (
          <img
            src={logoUrl}
            alt={name}
            className="h-14 w-14 shrink-0 rounded-2xl bg-neutral-200 object-cover"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
        ) : (
          <div className="h-14 w-14 shrink-0 rounded-2xl bg-neutral-200" />
        )}

        <div className="min-w-0 flex-1">
          {/* Header: rank · date · category */}
          <div className="flex items-center gap-1.5 text-[12px] text-neutral-500 mb-0.5">
            {dailyRank !== undefined && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 font-medium tabular-nums text-amber-700 ring-1 ring-amber-200"
                title={`PH 当日榜第 ${dailyRank} 名`}
              >
                #{dailyRank}
              </span>
            )}
            {dateMd && <span>· {dateMd} PT</span>}
            {catStyle && (
              <span className={cn("ml-1 rounded-full px-1.5 py-0 text-[11px] font-medium", catStyle.cls)}>
                {catStyle.label}
              </span>
            )}
          </div>

          {/* Name */}
          <div className="text-[15px] font-bold leading-tight text-neutral-900 break-words">
            {name}
          </div>

          {/* Tagline (1 line) */}
          {tagline && (
            <p className="mt-0.5 line-clamp-2 text-[13.5px] leading-snug text-neutral-700">
              {tagline}
            </p>
          )}

          {/* Footer metrics row */}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-neutral-500">
            {votes !== undefined && (
              <span className="inline-flex items-center gap-0.5">
                <span className="text-orange-500">▲</span>
                <span className="font-medium tabular-nums">{formatCompact(votes)}</span>
              </span>
            )}
            {comments !== undefined && (
              <>
                <span className="text-neutral-400">·</span>
                <span className="inline-flex items-center gap-0.5">
                  <span>💬</span>
                  <span className="tabular-nums">{formatCompact(comments)}</span>
                </span>
              </>
            )}
            {makerHandle && (
              <>
                <span className="text-neutral-400">·</span>
                <span>by @{makerHandle}</span>
              </>
            )}
            {dailyRank !== undefined && (
              <span className="ml-auto text-[11px] text-neutral-400" title={ordinal(dailyRank)}>
                {ordinal(dailyRank)}
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
