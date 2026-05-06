import type { Item } from "../types";
import { cn, formatCompact, parseJsonField } from "../lib/utils";
import { useDrawer } from "../lib/drawer";
import {
  IconStarFill,
  IconDownload,
  IconPackage,
} from "./icons";

// 8-class category color map (worker derives client-side keyword match,
// stored in extra.category). Mirrors mockup design.
const CATEGORY_STYLE: Record<string, string> = {
  workflows: "bg-violet-100 text-violet-700",
  "mcp-tools": "bg-blue-100 text-blue-700",
  prompts: "bg-violet-100 text-violet-700",
  "dev-tools": "bg-neutral-100 text-neutral-700",
  data: "bg-teal-100 text-teal-700",
  security: "bg-rose-100 text-rose-700",
  automation: "bg-emerald-100 text-emerald-700",
  other: "bg-neutral-100 text-neutral-700",
};

const CATEGORY_LABEL: Record<string, string> = {
  workflows: "Workflow",
  "mcp-tools": "MCP",
  prompts: "Prompt",
  "dev-tools": "Dev",
  data: "Data",
  security: "Security",
  automation: "自动化",
  other: "其他",
};

interface ClawhubMetrics {
  stars?: number;
  downloads?: number;
  installsCurrent?: number;
  installsAllTime?: number;
  comments?: number;
  versions?: number;
}

interface ClawhubExtra {
  slug?: string;
  latest_version?: string;
  category?: string;
  owner_image?: string;
  summary_translated?: string;
  ch_pending?: boolean;
}

interface Props {
  item: Item;
}

export function ClawhubCard({ item }: Props) {
  const drawer = useDrawer();

  const extra = parseJsonField<ClawhubExtra>(item.extra) ?? ({} as ClawhubExtra);
  const metrics = parseJsonField<ClawhubMetrics>(item.metrics) ?? ({} as ClawhubMetrics);

  const ownerHandle = item.handle || "";
  const ownerAvatar = extra.owner_image || (ownerHandle ? `https://avatars.githubusercontent.com/${ownerHandle}` : "");
  const displayName = item.title || item.source_id || "";

  const summary =
    item.content_translated ||
    extra.summary_translated ||
    item.content ||
    "";

  const category = extra.category || "other";
  const categoryLabel = CATEGORY_LABEL[category] || category;
  const categoryStyle = CATEGORY_STYLE[category] || CATEGORY_STYLE.other;

  const stars = metrics.stars ?? 0;
  const downloads = metrics.downloads ?? 0;
  const installs = metrics.installsCurrent ?? 0;
  const version = extra.latest_version;

  function open() {
    drawer.openItem(item);
  }

  return (
    <article
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <div className="flex items-start gap-3">
        {ownerAvatar ? (
          <img
            src={ownerAvatar}
            alt={ownerHandle}
            className="h-10 w-10 shrink-0 rounded-full bg-neutral-200 object-cover"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-full bg-neutral-200" />
        )}

        <div className="min-w-0 flex-1">
          {/* Title */}
          <div className="text-[15px] font-bold leading-tight text-neutral-900 break-words">
            {displayName}
          </div>

          {/* Second line: @handle · v · category chip */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-neutral-500">
            {ownerHandle && <span className="truncate">@{ownerHandle}</span>}
            {version && (
              <>
                <span className="text-neutral-400">·</span>
                <span className="tabular-nums">v{version}</span>
              </>
            )}
            <span className="text-neutral-400">·</span>
            <span
              className={cn(
                "rounded-full px-1.5 text-[10px] font-medium",
                categoryStyle,
              )}
            >
              {categoryLabel}
            </span>
          </div>
        </div>
      </div>

      {/* Body: README/summary translated, line-clamp-4 */}
      {summary && (
        <p className="mt-2 text-[13px] leading-relaxed text-neutral-700 line-clamp-4 break-words">
          {summary}
        </p>
      )}

      {/* Metrics: stars / downloads / active installs */}
      <div className="mt-2.5 flex items-center gap-3 text-[12px] text-neutral-500 tabular-nums">
        <span className="inline-flex items-center gap-1" title={`${stars} 星标`}>
          <IconStarFill className="h-3.5 w-3.5 text-amber-500" />
          {formatCompact(stars)}
        </span>
        <span className="inline-flex items-center gap-1" title={`${downloads} 下载`}>
          <IconDownload className="h-3.5 w-3.5" />
          {formatCompact(downloads)}
        </span>
        <span className="inline-flex items-center gap-1" title={`${installs} 当前安装`}>
          <IconPackage className="h-3.5 w-3.5" />
          {formatCompact(installs)} active
        </span>
      </div>
    </article>
  );
}
