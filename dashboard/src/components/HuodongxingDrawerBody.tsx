// Huodongxing (活动行) drawer body — 9 段抽屉
// 设计依据：docs/plans/_mockups (设计稿 22-event-drawer-v2.html)
//
// 9 段（外层 TweetDrawer 已渲染 header 和底部 "在活动行查看完整详情 ↗" CTA，
// 这里只渲染 body 内容）：
//   1. § Head — og_image cover + eyebrow + title overlay
//   2. § Head meta — 4 个 chip（日期 / 地点 / 主办方 / 状态）
//   3. § KPI 行（4 列）— 已报名 + bar / 座位剩余 / 主办方粉丝 / 浏览
//   4. § 关键信息 chips — 日期 / 时间 / 地点 / 线下or线上 / 价格 / tags
//   5. § 活动地址 — location_full 或 "报名后可查看"
//   6. § 票种 — ticket_tiers 卡片
//   7. § 嘉宾 — guests 或 empty state
//   8. § 主办方 — avatar + name + cert + meta + (关注按钮 v1 占位)
//   9. § 联系咨询 — QR + phone + email
//
// Loading state（detail_enriched_at == null）：
//   §1 head + §8 organizer 始终显示；§2 部分显示（已知字段）；
//   §3-§7 + §9 折叠成 loading panel + spinner + skeleton

import type {
  HuodongxingContact,
  HuodongxingGuest,
  HuodongxingMetrics,
  HuodongxingOrganizer,
  HuodongxingTicketTier,
  Item,
  ItemExtra,
} from "../types";
import { parseJsonField, formatCompact } from "../lib/utils";
import { resolveAssetUrl } from "../lib/asset";
import { formatEventLocation, formatEventTime, formatOrganizerFans, getEventState } from "../lib/huodongxing";

interface Props {
  item: Item;
}

// SVG icons — 跟 design 22 一致（lucide 风格）
function IconCal({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  );
}
function IconPin({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0118 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}
function IconUser({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
    </svg>
  );
}
function IconPhone({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M22 16.9v3a2 2 0 01-2.2 2A19.8 19.8 0 012 4.2 2 2 0 014 2h3a2 2 0 012 1.7l.7 4a2 2 0 01-.6 1.9L7.9 11a16 16 0 005 5l1.4-1.2a2 2 0 011.9-.6l4 .7a2 2 0 011.8 2z" />
    </svg>
  );
}
function IconMail({ className = "h-3 w-3" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M2 7l10 6 10-6" />
    </svg>
  );
}
function IconCertCircle({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-label="认证企业">
      <circle cx="8" cy="8" r="7" fill="#0EA5E9" />
      <path d="M5 8.3l2.2 2.2L11.2 6" stroke="#fff" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconVipCrown({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="#171717" aria-label="VIP 金牌主办方">
      <path d="M2 5l3-2 3 3 3-3 3 2-1.2 7H3.2z" />
    </svg>
  );
}

// 容量百分比（KPI 进度条用）
function ratio(reg?: number, max?: number): number {
  if (!reg || !max || max <= 0) return 0;
  return Math.min(1, reg / max);
}

// 票档状态文本 → tailwind 颜色
function ticketStatusClass(status: string | undefined): string {
  if (!status) return "text-neutral-500";
  if (/售罄|已满|结束/.test(status)) return "text-rose-700";
  if (/审核|申请/.test(status)) return "text-amber-700";
  return "text-emerald-700"; // 报名中 / 热销中
}

// 嘉宾头像 fallback：圆形带首字
function GuestAvatar({ guest, idx }: { guest: HuodongxingGuest; idx: number }) {
  const url = guest.avatar_url ? resolveAssetUrl(guest.avatar_url) : "";
  const initial = guest.name?.charAt(0) || String(idx + 1);
  if (url) {
    return (
      <img
        src={url}
        alt={guest.name}
        className="h-10 w-10 shrink-0 rounded-full bg-neutral-200 object-cover"
        onError={(e) => (e.currentTarget.style.visibility = "hidden")}
      />
    );
  }
  return (
    <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-sm font-semibold text-neutral-700">
      {initial}
    </span>
  );
}

export function HuodongxingDrawerBody({ item }: Props) {
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);
  const metrics = parseJsonField<HuodongxingMetrics>(item.metrics) ?? ({} as HuodongxingMetrics);
  const state = getEventState(extra);
  const isEnriched = extra.detail_enriched_at != null;

  const title = item.title || "";
  const timeStr = formatEventTime(extra);
  const locationStr = formatEventLocation(extra);
  const isOnline = Boolean(extra.is_online);
  const organizer = extra.organizer as HuodongxingOrganizer | undefined;
  const orgName = organizer?.name || item.author || "";

  // OG / cover image (head)
  const ogImage = extra.og_image ? resolveAssetUrl(extra.og_image) : extra.thumbnail_full ? resolveAssetUrl(extra.thumbnail_full) : "";

  // KPI 数据
  const registered = metrics.registered_count;
  const maxInst = metrics.max_instance;
  const seatLeft = typeof registered === "number" && typeof maxInst === "number" ? Math.max(0, maxInst - registered) : undefined;
  const orgFansNum = metrics.organizer_fans;
  const visit = metrics.visit_number;

  // tickets / guests / contact
  const tickets = (extra.ticket_tiers as HuodongxingTicketTier[] | undefined) || [];
  const guests = (extra.guests as HuodongxingGuest[] | undefined) || [];
  const contact = extra.contact as HuodongxingContact | undefined;
  const tags = (extra.tags as string[] | undefined) || [];

  // Eyebrow 文案：根据状态变化
  const eyebrowText =
    state === "live"
      ? "正在进行"
      : state === "ended"
        ? "已结束"
        : timeStr
          ? `报名中 · ${timeStr}`
          : "报名中";

  return (
    <div className="bg-white">
      {/* ============================================================
          § 1 Head — cover + eyebrow + title overlay
          ============================================================ */}
      <div className="relative aspect-[1200/630] w-full overflow-hidden border-b border-neutral-200">
        {ogImage ? (
          <img
            src={ogImage}
            alt={title}
            className="h-full w-full object-cover"
            onError={(e) => (e.currentTarget.style.display = "none")}
          />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-[#0d1f3c] via-[#1e3a5f] to-[#324a7a]" />
        )}
        {/* 暗化叠加 + 渐变；保证文字可读 */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />
        {/* 左上 eyebrow */}
        <span
          className={`absolute left-5 top-4 inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/15 px-2.5 py-1 text-[11px] font-medium text-white/95 backdrop-blur ${
            state === "live" ? "" : ""
          }`}
        >
          {state === "live" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400 shadow-[0_0_6px_#62B91D]" />}
          {eyebrowText}
        </span>
        {/* 左下 title */}
        <h2 className="absolute bottom-4 left-5 right-5 break-words text-[22px] font-bold leading-[1.25] text-white text-balance drop-shadow-[0_2px_18px_rgba(0,0,0,.32)]">
          {title}
        </h2>
      </div>

      {/* ============================================================
          § 2 Head meta — 4 个 chip（日期 / 地点 / 主办方 / 状态）
          ============================================================ */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-neutral-200 px-5 py-3.5">
        {timeStr && (
          <span className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[12px] tabular-nums text-neutral-700">
            <IconCal />
            {timeStr}
          </span>
        )}
        {locationStr && (
          <span className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[12px] text-neutral-700">
            <IconPin />
            {locationStr}
          </span>
        )}
        {orgName && (
          <span className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[12px] text-neutral-700">
            <IconUser />
            <span className="max-w-[160px] truncate">{orgName}</span>
          </span>
        )}
        {state === "live" && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-600" />
            正在进行
          </span>
        )}
        {state === "soon" && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[12px] font-semibold text-emerald-700">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-600" />
            报名中
          </span>
        )}
        {state === "ended" && (
          <span className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1 text-[12px] text-neutral-500">
            已结束
          </span>
        )}
      </div>

      {/* ============================================================
          Loading state — detail 未 enrich 时，§3-§7 + §9 折叠
          ============================================================ */}
      {!isEnriched && (
        <div className="flex flex-col items-center gap-3.5 border-b border-neutral-200 bg-neutral-50/60 px-5 py-8">
          <div className="h-7 w-7 animate-spin rounded-full border-[2.5px] border-neutral-200 border-t-neutral-600" />
          <div className="text-[13px] font-medium text-neutral-900">详情加载中…</div>
          <div className="max-w-[320px] text-center text-[12px] leading-[1.55] text-neutral-500">
            主办方与时间地点已加载。
            <br />
            票种、嘉宾、详细地址等通常在抓取后 5 分钟–1 小时内填充完毕。
          </div>
          <div className="mt-1 flex w-full flex-col gap-2.5">
            <div className="h-2.5 w-[85%] rounded bg-[linear-gradient(90deg,#e5e5e5_0%,#f5f5f5_50%,#e5e5e5_100%)]" />
            <div className="h-2.5 w-[70%] rounded bg-[linear-gradient(90deg,#e5e5e5_0%,#f5f5f5_50%,#e5e5e5_100%)]" />
            <div className="h-2.5 w-[55%] rounded bg-[linear-gradient(90deg,#e5e5e5_0%,#f5f5f5_50%,#e5e5e5_100%)]" />
          </div>
        </div>
      )}

      {/* ============================================================
          § 3 KPI（4 列）— enriched only
          ============================================================ */}
      {isEnriched && (
        <div className="grid grid-cols-4 gap-2 border-b border-neutral-200 px-4 py-4 text-center">
          <div className="px-1">
            <div className="inline-flex items-baseline justify-center gap-0.5 text-[17px] font-bold leading-tight tabular-nums text-neutral-900">
              {typeof registered === "number" ? formatCompact(registered) : "—"}
              {typeof maxInst === "number" && <span className="text-[12px] font-medium text-neutral-400">/{formatCompact(maxInst)}</span>}
            </div>
            <div className="mt-1 text-[11px] text-neutral-500">已报名</div>
            {typeof registered === "number" && typeof maxInst === "number" && maxInst > 0 && (
              <div className="mx-3 mt-1.5 h-[3px] overflow-hidden rounded-sm bg-neutral-100">
                <span
                  className="block h-full rounded-sm bg-neutral-700"
                  style={{ width: `${Math.round(ratio(registered, maxInst) * 100)}%` }}
                />
              </div>
            )}
          </div>
          <div className="px-1">
            <div className="text-[17px] font-bold leading-tight tabular-nums text-neutral-900">
              {typeof seatLeft === "number" ? formatCompact(seatLeft) : "—"}
            </div>
            <div className="mt-1 text-[11px] text-neutral-500">座位剩余</div>
          </div>
          <div className="px-1">
            <div className="text-[17px] font-bold leading-tight tabular-nums text-neutral-900">
              {typeof orgFansNum === "number" ? formatCompact(orgFansNum) : "—"}
            </div>
            <div className="mt-1 text-[11px] text-neutral-500">主办方粉丝</div>
          </div>
          <div className="px-1">
            <div className="text-[17px] font-bold leading-tight tabular-nums text-neutral-900">
              {typeof visit === "number" ? formatCompact(visit) : "—"}
            </div>
            <div className="mt-1 text-[11px] text-neutral-500">浏览</div>
          </div>
        </div>
      )}

      {/* ============================================================
          § 4 关键信息 chips — enriched only
          ============================================================ */}
      {isEnriched && (
        <section className="border-b border-neutral-200 px-5 py-5">
          <div className="mb-3 text-[13px] font-medium text-neutral-500">关键信息</div>
          <div className="flex flex-wrap gap-1.5">
            {timeStr && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 px-2.5 py-1.5 text-[12px] font-medium text-neutral-700">
                <IconCal />
                {timeStr}
              </span>
            )}
            {locationStr && (
              <span className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-1.5 text-[12px] font-medium text-neutral-700">
                {locationStr}
              </span>
            )}
            <span className="inline-flex items-center rounded-full bg-neutral-100 px-2.5 py-1.5 text-[12px] font-medium text-neutral-700">
              {isOnline ? "线上活动" : "线下活动"}
            </span>
            {extra.is_free === true && (
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2.5 py-1.5 text-[12px] font-medium text-emerald-700">
                免费
              </span>
            )}
            {extra.is_private && (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-1.5 text-[12px] font-medium text-amber-700">
                需审核
              </span>
            )}
            {tags.slice(0, 6).map((t) => (
              <span
                key={t}
                className="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-50 px-2.5 py-1.5 text-[12px] font-medium text-neutral-600"
              >
                #{t}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* ============================================================
          § 5 活动地址 — enriched only
          ============================================================ */}
      {isEnriched && (
        <section className="border-b border-neutral-200 px-5 py-5">
          <div className="mb-3 text-[13px] font-medium text-neutral-500">活动地址</div>
          <div className="flex items-start gap-2.5">
            <div className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-700">
              <IconPin className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              {isOnline ? (
                <div className="text-[14px] leading-[1.5] text-neutral-700">线上活动 · 报名后会收到直播链接</div>
              ) : extra.location_full ? (
                <div className="text-[14px] leading-[1.5] text-neutral-900">{extra.location_full}</div>
              ) : (
                <>
                  <div className="text-[14px] italic leading-[1.5] text-neutral-500">报名后可查看详细地址</div>
                  <div className="mt-1 text-[12px] text-neutral-400">主办方设定 · 通过审核后会通过短信和邮件下发</div>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {/* ============================================================
          § 6 票种 — enriched only
          ============================================================ */}
      {isEnriched && tickets.length > 0 && (
        <section className="border-b border-neutral-200 px-5 py-5">
          <div className="mb-3 flex items-baseline justify-between gap-2 text-[13px] font-medium">
            <span className="text-neutral-500">票种</span>
            <span className="text-[11px] tabular-nums text-neutral-400">{tickets.length} 档</span>
          </div>
          <div className="flex flex-col gap-2">
            {tickets.slice(0, 10).map((t, i) => (
              <div
                key={t.sn ?? i}
                className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3.5 py-3"
              >
                <div className="min-w-0">
                  <div className="break-words text-[14px] font-semibold leading-[1.3] text-neutral-900">{t.name || "票种"}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] tabular-nums text-neutral-500">
                    {typeof t.sold_number === "number" && <span>已申请 {t.sold_number}</span>}
                    {typeof t.quantity === "number" && t.quantity > 0 && (
                      <>
                        <span className="text-neutral-300">·</span>
                        <span>限 {t.quantity}</span>
                      </>
                    )}
                    {t.status_str && (
                      <>
                        <span className="text-neutral-300">·</span>
                        <span className={`font-medium ${ticketStatusClass(t.status_str)}`}>{t.status_str}</span>
                      </>
                    )}
                  </div>
                </div>
                <div
                  className={`shrink-0 text-[16px] font-bold tabular-nums tracking-tight ${
                    t.price === 0 || /免费/.test(t.price_str || "") ? "text-emerald-700" : "text-neutral-900"
                  }`}
                >
                  {t.price_str || (typeof t.price === "number" ? `¥${t.price}` : "—")}
                </div>
              </div>
            ))}
            {tickets.length > 10 && (
              <div className="mt-1 text-center text-[12px] text-neutral-400">
                还有 {tickets.length - 10} 档 — 完整票档请到活动行查看
              </div>
            )}
          </div>
        </section>
      )}

      {/* ============================================================
          § 7 嘉宾 — enriched only（有 empty state）
          ============================================================ */}
      {isEnriched && (
        <section className="border-b border-neutral-200 px-5 py-5">
          <div className="mb-3 flex items-baseline justify-between gap-2 text-[13px] font-medium">
            <span className="text-neutral-500">嘉宾</span>
            {guests.length > 0 && <span className="text-[11px] tabular-nums text-neutral-400">{guests.length} 位</span>}
          </div>
          {guests.length === 0 ? (
            <div className="flex items-center gap-2.5 rounded-lg border border-dashed border-neutral-200 bg-neutral-50 p-3.5 text-[13px] leading-[1.5] text-neutral-500">
              <IconUser className="h-4 w-4 text-neutral-400" />
              <div>
                <b className="font-medium text-neutral-900">嘉宾名单待主办方公布</b>
                <span className="mt-0.5 block text-[11.5px] text-neutral-400">
                  活动行嘉宾页常为主办方私密；峰会前 1–2 周一般会陆续放出
                </span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {guests.slice(0, 12).map((g, i) => (
                <div key={`${g.name}-${i}`} className="flex items-start gap-3">
                  <GuestAvatar guest={g} idx={i} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-neutral-900">{g.name}</div>
                    {(g.titles?.length || g.company) && (
                      <div className="mt-0.5 text-[12px] text-neutral-500">
                        {g.titles?.join(" · ")}
                        {g.titles?.length && g.company ? " @ " : ""}
                        {g.company}
                      </div>
                    )}
                    {g.description && (
                      <p className="mt-1 line-clamp-3 break-words text-[12.5px] leading-[1.5] text-neutral-600">{g.description}</p>
                    )}
                  </div>
                </div>
              ))}
              {guests.length > 12 && (
                <div className="text-center text-[12px] text-neutral-400">还有 {guests.length - 12} 位 — 详见活动行</div>
              )}
            </div>
          )}
        </section>
      )}

      {/* ============================================================
          § 8 主办方 — 始终显示（listing 阶段就有）
          ============================================================ */}
      <section className="border-b border-neutral-200 px-5 py-5">
        <div className="mb-3 text-[13px] font-medium text-neutral-500">主办方</div>
        <div className="grid grid-cols-[48px_1fr_auto] items-center gap-3">
          {organizer?.avatar_url ? (
            <img
              src={resolveAssetUrl(organizer.avatar_url)}
              alt={orgName}
              className="h-12 w-12 rounded-full border border-neutral-200 bg-neutral-100 object-cover"
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
          ) : (
            <span className="inline-flex h-12 w-12 items-center justify-center rounded-full border border-neutral-200 bg-gradient-to-br from-orange-50 to-orange-100 text-lg font-bold text-orange-700">
              {orgName.charAt(0) || "?"}
            </span>
          )}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[15px] font-bold text-neutral-900">{orgName}</span>
              {organizer?.is_certified_company && <IconCertCircle />}
              {organizer?.is_vip_gold && <IconVipCrown />}
            </div>
            <div className="mt-0.5 text-[12px] tabular-nums text-neutral-500">
              {formatOrganizerFans(metrics.organizer_fans ?? organizer?.fans) ?? "—"} 粉丝
              {extra.city && <span> · {extra.city}</span>}
            </div>
          </div>
          {organizer?.url && (
            <a
              href={organizer.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-[30px] items-center rounded-md border border-neutral-300 bg-white px-3 text-[12px] font-medium text-neutral-800 hover:bg-neutral-50"
            >
              主页 ↗
            </a>
          )}
        </div>
      </section>

      {/* ============================================================
          § 9 联系咨询 — enriched only
          ============================================================ */}
      {isEnriched && contact && (contact.org_phone || contact.org_email || contact.org_qr_code || contact.org_description) && (
        <section className="border-b border-neutral-200 px-5 py-5">
          <div className="mb-3 text-[13px] font-medium text-neutral-500">联系咨询</div>
          <div className={`grid items-start gap-3.5 ${contact.org_qr_code ? "grid-cols-[auto_1fr]" : "grid-cols-1"}`}>
            {contact.org_qr_code ? (
              <img
                src={resolveAssetUrl(contact.org_qr_code)}
                alt="客服二维码"
                className="h-[84px] w-[84px] rounded-lg border border-neutral-200 bg-white object-cover"
                onError={(e) => (e.currentTarget.style.visibility = "hidden")}
              />
            ) : null}
            <div className="space-y-1 text-[13px] leading-[1.6] text-neutral-700">
              {contact.org_phone && (
                <div className="flex items-center gap-2">
                  <IconPhone className="h-3 w-3 shrink-0 text-neutral-400" />
                  <a href={`tel:${contact.org_phone}`} className="text-sky-600 hover:underline">
                    {contact.org_phone}
                  </a>
                </div>
              )}
              {contact.org_email && (
                <div className="flex items-center gap-2">
                  <IconMail className="h-3 w-3 shrink-0 text-neutral-400" />
                  <a href={`mailto:${contact.org_email}`} className="break-all text-sky-600 hover:underline">
                    {contact.org_email}
                  </a>
                </div>
              )}
              {contact.org_description && (
                <div className="text-[12px] leading-[1.55] text-neutral-500">{contact.org_description}</div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
