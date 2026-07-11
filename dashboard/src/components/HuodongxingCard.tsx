// Huodongxing (活动行) feed card.
// 设计依据：docs/plans/_mockups (设计稿 21-event-card.html)，5 状态：
//   live (进行中 · 实心黑徽章+动) / soon (未开始 · 灰底默认) /
//   ended (已结束 · 灰化整卡 + 退化 CTA) / unenriched (详情加载中 · 骨架)
//
// 字段映射（与 worker §3 + frontend-handoff 对齐）：
//   title         → item.title
//   thumbnail     → media[].role === "thumbnail"（fallback: extra.thumbnail_full）
//   时间          → enriched: extra.start_short / 未 enrich: extra.time_raw
//   地点          → 线下: city · district / 线上: "线上活动" / 未 enrich: location_raw
//   价格          → is_free ? "免费" : min(ticket_tiers[].price) "起"
//   报名数        → metrics.registered_count（容量小时 "N/M" 双值）
//   正文          → item.content（backend 写入 og:description 或正文首段 100 字）
//   主办方        → extra.organizer.{name, avatar_url, fans, is_certified_company, is_vip_gold}
//   主办方粉丝    → metrics.organizer_fans（drawer 用；卡片简显）
//   CTA           → 跳 item.url（站外报名页）

import { useState } from "react";
import type { HuodongxingMetrics, HuodongxingOrganizer, Item, ItemExtra, MediaItem } from "../types";
import { buildResponsiveCardImage, cn, parseJsonField, proxyImg, variantsForCurrentCover } from "../lib/utils";
import { smartTruncate } from "../lib/truncate";
import { useDrawer } from "../lib/drawerContext";
import { useImpressionRefresh } from "../lib/impressionRefresh";
import {
  LAZY_MEDIA_LOAD_POLICY,
  getMediaPriorityTelemetryLabel,
  type MediaLoadPolicy,
} from "../lib/mediaPriority";
import {
  formatEventLocation,
  formatEventPrice,
  formatEventRegistered,
  formatEventTime,
  formatOrganizerFans,
  getEventState,
} from "../lib/huodongxing";
import { HL } from "./search/highlight";

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

// 状态徽章（live / soon / ended 三档）
function StatusBadge({ state }: { state: "live" | "soon" | "ended" }) {
  if (state === "live") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-neutral-900 px-1.5 py-0.5 text-[11px] font-medium leading-none text-white">
        <span className="inline-block h-1 w-1 rounded-full bg-white" />
        进行中
      </span>
    );
  }
  if (state === "soon") {
    return (
      <span className="inline-flex shrink-0 items-center rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium leading-none text-neutral-700">
        未开始
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium leading-none text-neutral-400 ring-1 ring-inset ring-neutral-300">
      已结束
    </span>
  );
}

// 地点 icon：线下用 pin，线上用 globe
function LocationIcon({ online }: { online: boolean }) {
  if (online) {
    return (
      <svg
        className="-mb-px inline-block h-3 w-3 align-middle"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        aria-hidden
      >
        <circle cx="6" cy="6" r="4.5" />
        <path d="M1.5 6h9M6 1.5c1.5 1.5 1.5 7.5 0 9M6 1.5c-1.5 1.5-1.5 7.5 0 9" />
      </svg>
    );
  }
  return (
    <svg
      className="-mb-px inline-block h-3 w-3 align-middle"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden
    >
      <path d="M6 1.5c-2 0-3.5 1.5-3.5 3.5 0 2.6 3.5 5.5 3.5 5.5s3.5-2.9 3.5-5.5c0-2-1.5-3.5-3.5-3.5z" />
      <circle cx="6" cy="5" r="1.2" />
    </svg>
  );
}

// 认证企业 / VIP 金牌 徽章
function CertBadge({ kind }: { kind: "cert" | "vip" }) {
  if (kind === "cert") {
    return (
      <svg className="inline-block h-3 w-3 shrink-0" viewBox="0 0 13 13" fill="#171717" aria-label="企业认证">
        <path d="M6.5 0L8 1.3l2 .1.1 2 1.3 1.5L10.6 6.5l.8 1.7-1.7.8-.1 2-2 .1L6.5 12.4 4.9 11.1l-2-.1-.1-2L1.5 7.5l1.3-1.6-.8-1.7 1.7-.8.1-2 2-.1z" />
        <path
          d="M3.7 6.6L5.5 8.4 9 4.9"
          stroke="#fff"
          strokeWidth="1.3"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  return (
    <svg className="inline-block h-3 w-3 shrink-0" viewBox="0 0 13 13" fill="#171717" aria-label="VIP 金牌主办方">
      <path d="M1.5 4l2.3-1.5L6.5 5l2.7-2.5L11.5 4l-1 6h-8z" />
    </svg>
  );
}

// 外链跳出小箭头
function ExtLinkIcon() {
  return (
    <svg className="h-2.5 w-2.5" viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M3.5 1.5h6v6M9.5 1.5l-7 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

interface Props {
  item: Item;
  mediaPolicy?: MediaLoadPolicy;
}

export function HuodongxingCard({
  item,
  mediaPolicy = LAZY_MEDIA_LOAD_POLICY,
}: Props) {
  const drawer = useDrawer();
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverVariantFailed, setCoverVariantFailed] = useState(false);
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<HuodongxingMetrics>(item.metrics) ?? ({} as HuodongxingMetrics);
  const media = parseMedia(item.media);

  const state = getEventState(extra);
  const isEnded = state === "ended";
  const isUnenriched = state === "unenriched";

  const title = item.title || "";
  const timeStr = formatEventTime(extra);
  const locationStr = formatEventLocation(extra);
  const priceStr = formatEventPrice(extra);
  const registeredStr = formatEventRegistered(metrics.registered_count, metrics.max_instance);
  const isOnline = Boolean(extra.is_online);

  // PM 2026-05-25:卡片改 HfPaper 风格 — 顶部 16:9 大封面 + 下面紧凑信息.
  // 封面用 drawer 头图同源字段 (extra.og_image → thumbnail_full → media role=thumbnail).
  // 流内 cover 跟抽屉头图视觉一致, 用户点开 drawer 也是同一张图
  const thumb = media.find((m) => (m as MediaItem & { role?: string }).role === "thumbnail");
  const coverUrl = extra.og_image || extra.thumbnail_full || thumb?.url || "";
  const storedCoverVariants = variantsForCurrentCover(
    coverUrl,
    extra.card_thumbnail_variant_source,
    extra.card_thumbnail_variants,
  ) || (thumb?.url === coverUrl
      ? thumb.card_variants
      : undefined);
  const coverSource = coverUrl
    ? buildResponsiveCardImage(
        coverUrl,
        storedCoverVariants,
        { fallbackWidth: 400 },
      )
    : null;

  // 正文：item.content (backend 写入 og:description 或正文首段 100 字)
  // 未来如 backend 加 ai_summary 字段，优先用之
  const body = (extra.ai_summary as string | undefined) || item.content || "";

  const organizer = extra.organizer as HuodongxingOrganizer | undefined;
  const orgName = organizer?.name || item.author || "";
  const orgAvatar = organizer?.avatar_url ? proxyImg(organizer.avatar_url, 80) : "";
  const orgFans = formatOrganizerFans(metrics.organizer_fans ?? organizer?.fans);

  function open(e: React.MouseEvent) {
    // CTA 点击不打开 drawer（用户意图是跳报名页）
    if ((e.target as HTMLElement).closest("a[data-cta]")) return;
    drawer.openItem(item);
  }

  // BE §5b: 视口停留 500ms 弱触发 metrics refresh
  const refreshRef = useImpressionRefresh(item.id);

  return (
    <article
      ref={refreshRef}
      onClick={open}
      className={`cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60 ${
        isEnded ? "bg-neutral-50/60" : ""
      }`}
    >
      {/* PM 2026-05-25:改 HfPaper 风格 — 顶部 16:9 cover + 紧凑信息.
          cover 取 drawer 头图同源 (extra.og_image / thumbnail_full), 跟用户
          点开抽屉看到的头图视觉一致 */}
      {coverSource && !coverFailed && (
        <div className={cn(
          "mb-2.5 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-100",
          isEnded && "opacity-60 grayscale-[.5]",
        )}
          data-feed-source={item.source_type}
          data-media-priority={getMediaPriorityTelemetryLabel(mediaPolicy)}
        >
          <picture className="block">
            {coverSource.webpSrcSet && !coverVariantFailed && (
              <source type="image/webp" srcSet={coverSource.webpSrcSet} sizes="(max-width: 640px) calc(100vw - 32px), 400px" />
            )}
            <img
              src={coverSource.fallbackSrc}
              srcSet={coverSource.srcSet}
              sizes="(max-width: 640px) calc(100vw - 32px), 400px"
              width={thumb?.width || 800}
              height={thumb?.height || 450}
              alt={title}
              loading={mediaPolicy.loading}
              fetchPriority={mediaPolicy.fetchPriority}
              decoding="async"
              className="aspect-[16/9] w-full object-cover"
              onError={() => {
                if (coverSource.webpSrcSet && !coverVariantFailed) {
                  setCoverVariantFailed(true);
                } else {
                  setCoverFailed(true);
                }
              }}
            />
          </picture>
        </div>
      )}

      {/* Title row:标题 + 状态徽章 (跨整张卡宽, 没有 avatar 缩进) */}
      <div className="flex flex-wrap items-start gap-1.5">
        <h3
          className={`min-w-0 flex-1 break-words text-[15px] font-bold leading-tight ${
            isEnded ? "text-neutral-500" : "text-neutral-900"
          }`}
        >
          <HL text={title} />
        </h3>
        {state !== "unenriched" && <StatusBadge state={state} />}
        {state === "unenriched" && (
          <span className="inline-flex shrink-0 items-center rounded-full bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium leading-none text-neutral-700">
            未开始
          </span>
        )}
      </div>

      {/* Meta:时间 · 地点 · 价格 · 报名数 */}
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] leading-[1.5] text-neutral-500">
        {timeStr && <span className="shrink-0 whitespace-nowrap tabular-nums">{timeStr}</span>}
        {timeStr && locationStr && <span className="shrink-0 text-neutral-400">·</span>}
        {locationStr && (
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap">
            <LocationIcon online={isOnline} />
            {locationStr}
          </span>
        )}
        {locationStr && priceStr && <span className="shrink-0 text-neutral-400">·</span>}
        {priceStr && (
          <span className={cn(
            "shrink-0 whitespace-nowrap",
            priceStr === "免费" ? "font-medium text-neutral-700" : "tabular-nums",
          )}>
            {priceStr}
          </span>
        )}
        {(timeStr || locationStr || priceStr) && registeredStr && <span className="shrink-0 text-neutral-400">·</span>}
        {registeredStr && <span className="shrink-0 whitespace-nowrap tabular-nums">{registeredStr}</span>}
      </div>

      {/* Body / Skeleton — unenriched 状态显骨架 */}
      {isUnenriched ? (
        <>
          <div className="mt-2.5 flex flex-col gap-2">
            <div className="h-2.5 w-[92%] rounded bg-[linear-gradient(90deg,#f5f5f5_0%,#e5e5e5_50%,#f5f5f5_100%)]" />
            <div className="h-2.5 w-[64%] rounded bg-[linear-gradient(90deg,#f5f5f5_0%,#e5e5e5_50%,#f5f5f5_100%)]" />
          </div>
          <div className="mt-1 inline-flex items-center gap-1 text-[12px] text-neutral-400">
            <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
              <circle cx="6" cy="6" r="4.5" />
              <path d="M6 3.5v3l2 1" strokeLinecap="round" />
            </svg>
            活动详情加载中…
          </div>
        </>
      ) : body ? (
        <p
          className={`mt-2 line-clamp-3 break-words text-[15px] leading-[1.45] ${
            isEnded ? "text-neutral-500" : "text-neutral-900"
          }`}
        >
          <HL text={smartTruncate(body, 200)} />
        </p>
      ) : null}

      {/* Footer：左 organizer / 右 CTA */}
      <div className="mt-2.5 flex items-center gap-1.5 text-[13px] text-neutral-500">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {orgAvatar ? (
            <img
              src={orgAvatar}
              alt={orgName}
              loading="lazy"
              decoding="async"
              className="h-[18px] w-[18px] shrink-0 rounded-full bg-neutral-200 object-cover"
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
          ) : (
            <span
              className="h-[18px] w-[18px] shrink-0 rounded-full bg-[repeating-linear-gradient(135deg,#d4d4d4_0_3px,#c0c0c0_3px_6px)]"
            />
          )}
          {orgName && (
            <span className="min-w-0 truncate whitespace-nowrap font-medium text-neutral-900">{orgName}</span>
          )}
          {organizer?.is_certified_company && <CertBadge kind="cert" />}
          {organizer?.is_vip_gold && <CertBadge kind="vip" />}
          {orgFans && (
            <>
              <span className="shrink-0 text-neutral-400">·</span>
              <span className="shrink-0 whitespace-nowrap tabular-nums">{orgFans}</span>
            </>
          )}
        </span>
        {isEnded ? (
          <span className="shrink-0 whitespace-nowrap rounded-full border border-neutral-200 px-2 py-0.5 text-[12px] font-medium text-neutral-400">
            已结束
          </span>
        ) : item.url ? (
          <a
            data-cta
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-[12px] font-medium text-sky-600 transition-colors hover:border-neutral-400 hover:bg-neutral-50"
          >
            报名
            <ExtLinkIcon />
          </a>
        ) : null}
      </div>
    </article>
  );
}
