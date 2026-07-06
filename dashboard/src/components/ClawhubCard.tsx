import type { Item } from "../types";
import { cn, formatCompact, parseJsonField, proxyImg } from "../lib/utils";
import { cleanTruncatedSummary, smartTruncate } from "../lib/truncate";
import { useDrawer } from "../lib/drawer";
import { useImpressionRefresh } from "../lib/impressionRefresh";
import {
  IconStarFill,
  IconDownload,
  IconPackage,
} from "./icons";
import { HL } from "./search/highlight";

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

  // v1: items.content / content_translated 现在装的是 README 全文（长文档），
  // 卡片正文改用 extra.summary_translated（200 字短描述，刚好放 4 行）。
  // 老 v0 数据 fallback 到 content_translated/content（那时 content 装的就是 summary）
  const summary =
    extra.summary_translated ||
    item.content_translated ||
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

  // BE §5b: 视口停留 500ms 弱触发 metrics refresh
  const refreshRef = useImpressionRefresh(item.id);

  return (
    <article
      ref={refreshRef}
      onClick={open}
      className="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60"
    >
      <div className="flex items-start gap-3">
        {ownerAvatar ? (
          <img
            src={proxyImg(ownerAvatar, 80)}
            alt={ownerHandle}
            loading="lazy"
            decoding="async"
            className="h-10 w-10 shrink-0 rounded-full bg-neutral-200 object-cover"
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
        ) : (
          <div className="h-10 w-10 shrink-0 rounded-full bg-neutral-200" />
        )}

        <div className="min-w-0 flex-1">
          {/* Title — text-[15px] font-bold（手册基线）*/}
          <div className="text-[15px] font-bold leading-tight text-neutral-900 break-words">
            <HL text={displayName} />
          </div>

          {/* Meta line — text-[13px] 跟 GH/PH 卡片对齐 */}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-neutral-500">
            {ownerHandle && <span className="truncate whitespace-nowrap">@{ownerHandle}</span>}
            {version && (
              <>
                <span className="shrink-0 text-neutral-400">·</span>
                <span className="shrink-0 whitespace-nowrap tabular-nums">v{version}</span>
              </>
            )}
            <span className="shrink-0 text-neutral-400">·</span>
            <span
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                categoryStyle,
              )}
            >
              {categoryLabel}
            </span>
          </div>
        </div>
      </div>

      {/* Body — text-[15px] leading-[1.45] line-clamp-4，跟 GH/PH 同款 */}
      {summary && (
        <p className="mt-2 text-[15px] leading-[1.45] text-neutral-900 break-words line-clamp-4">
          <HL text={cleanTruncatedSummary(smartTruncate(summary, 280))} />
        </p>
      )}

      {/* Footer metrics — text-[13px]，gap-x-3 gap-y-0.5，跟 GH/PH 同款 */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] text-neutral-500 tabular-nums">
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" title={`${stars} 星标`}>
          <IconStarFill className="h-3.5 w-3.5 text-amber-500" />
          {formatCompact(stars)}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" title={`${downloads} 下载`}>
          <IconDownload className="h-3.5 w-3.5" />
          {formatCompact(downloads)}
        </span>
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap" title={`${installs} 当前安装`}>
          <IconPackage className="h-3.5 w-3.5" />
          {formatCompact(installs)} active
        </span>
      </div>
    </article>
  );
}
