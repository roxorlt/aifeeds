import { useEffect, useRef, useState } from "react";
import { useDrawer } from "../lib/drawer";
import { track, EVENTS } from "../lib/telemetry";
import { TweetCard } from "./TweetCard";
import { GithubDrawerBody } from "./GithubDrawerBody";
import { PhDrawerBody } from "./PhDrawerBody";
import { ClawhubDrawerBody } from "./ClawhubDrawerBody";
import { HuodongxingDrawerBody } from "./HuodongxingDrawerBody";
import { HfPaperDrawerBody } from "./HfPaperDrawerBody";
import { parseJsonField, cn } from "../lib/utils";
import { useIsNarrow } from "../lib/breakpoint";
import { smoothScrollToTop } from "../lib/scroll";
import { IconShare } from "./icons";
import { ShareDialog } from "./ShareDialog";
import { useAuthStore } from "../lib/authStore";
import { VideoColumnProvider } from "../lib/videoColumnContext";
import type { CreateShareResponse } from "../lib/share";
import type { Item, ItemExtra } from "../types";

const SWIPE_EDGE_BUFFER = 24; // px from left edge — leave room for system back gesture
const SWIPE_COMMIT_PX = 80; // dx threshold to commit close
const SWIPE_ANIM_MS = 200;

export function TweetDrawer() {
  const { state, close } = useDrawer();
  const { item, siblings, siblings_has_more, loading, error } = state;
  const open = Boolean(item) || loading || Boolean(error);
  const isNarrow = useIsNarrow();
  const targetRef = useRef<HTMLDivElement | null>(null);

  // Scroll the URL-targeted tweet into view when opening into a thread where
  // the target isn't the root. X-style behavior for shared replies.
  useEffect(() => {
    if (!item) return;
    const node = targetRef.current;
    if (!node) return;
    requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: "auto", block: "start" });
    });
  }, [item?.id]);

  const asideRef = useRef<HTMLElement | null>(null);
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  // Tracks whether the in-body title (owner/repo for GH, etc.) has scrolled
  // above the visible area — when true, the header surfaces it as a
  // "sticky" replacement title.
  const [titleHidden, setTitleHidden] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // 同 itemId 不重复 createShare：缓存最近一次为该 item 创建的 token
  const [shareCache, setShareCache] = useState<Record<string, CreateShareResponse>>({});
  const user = useAuthStore((s) => s.user);
  const openLoginModal = useAuthStore((s) => s.openLoginModal);

  const onClickShare = () => {
    if (!user) {
      // 未登录 → 弹登录 modal，登录成功后 retry 自动打开 ShareDialog
      openLoginModal("manual", () => setShareOpen(true));
      return;
    }
    setShareOpen(true);
  };
  const dragXRef = useRef(0);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const setDrag = (x: number) => {
    dragXRef.current = x;
    setDragX(x);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  // Lock body scroll while open — iOS-safe pattern.
  // Plain `overflow:hidden` doesn't fully prevent iOS Safari from rubber-banding
  // the underlying page when an inner scroller hits its boundary, which traps
  // gestures inside the drawer body. The fix is to take the body out of flow
  // (position:fixed, top:-scrollY), then restore on close.
  useEffect(() => {
    if (!open) return;
    const scrollY = window.scrollY;
    const prev = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      top: document.body.style.top,
      width: document.body.style.width,
      left: document.body.style.left,
      right: document.body.style.right,
    };
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.top = `-${scrollY}px`;
    document.body.style.left = "0";
    document.body.style.right = "0";
    document.body.style.width = "100%";
    return () => {
      document.body.style.overflow = prev.overflow;
      document.body.style.position = prev.position;
      document.body.style.top = prev.top;
      document.body.style.width = prev.width;
      document.body.style.left = prev.left;
      document.body.style.right = prev.right;
      // Restore the previous scroll position (lost when we set position:fixed)
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  // Reset drag state when drawer (re)opens
  useEffect(() => {
    if (open) {
      dragXRef.current = 0;
      setDragX(0);
      setIsDragging(false);
    }
  }, [open]);

  // Telemetry: open/close/dwell
  const openTimeRef = useRef<number>(0);
  useEffect(() => {
    if (!open || !item) return;
    openTimeRef.current = Date.now();
    track(EVENTS.ITEM_OPEN_DRAWER, {
      item_id: item.id,
      source: item.source_type,
    });
    const startedAt = openTimeRef.current;
    const itemId = item.id;
    return () => {
      track(EVENTS.ITEM_CLOSE_DRAWER, {
        item_id: itemId,
        dwell_ms: Date.now() - startedAt,
      });
    };
  }, [open, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mobile swipe-to-close: rightward swipe → close.
  //
  // Decision is made entirely on `touchend` from the start/end position delta,
  // so we never attach a `touchmove` listener (no `preventDefault` ever fires
  // on the aside). That guarantees native scroll has zero interference,
  // including the iOS scroll-trap at the README bottom.
  //
  // Visual: aside slides off via existing CSS transition on close. We don't
  // follow the finger during the swipe (small UX trade-off for a reliable
  // body scroll).
  useEffect(() => {
    if (!open || !isNarrow) return;
    const aside = asideRef.current;
    if (!aside) return;

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      // Skip if touch starts inside the system edge zone — let OS gesture win
      if (t.clientX < SWIPE_EDGE_BUFFER) {
        dragStart.current = null;
        return;
      }
      dragStart.current = { x: t.clientX, y: t.clientY };
    };
    const onEnd = (e: TouchEvent) => {
      if (!dragStart.current) return;
      const t = e.changedTouches[0];
      if (!t) {
        dragStart.current = null;
        return;
      }
      const dx = t.clientX - dragStart.current.x;
      const dy = t.clientY - dragStart.current.y;
      // Commit close only on a clearly horizontal-rightward gesture: dx past
      // threshold AND horizontal motion at least 1.5× vertical.
      if (dx > SWIPE_COMMIT_PX && Math.abs(dx) > Math.abs(dy) * 1.5) {
        // Visual cue: snap aside off-screen then close after transition
        setIsDragging(false);
        setDrag(window.innerWidth);
        setTimeout(close, SWIPE_ANIM_MS);
      }
      // For other gestures (vertical scroll, leftward, etc.) just clear
      // start state — let the user-agent handle the rest natively.
      dragStart.current = null;
    };

    // Both listeners are passive: we never call preventDefault, so the
    // browser commits to native scroll immediately on touchmove.
    aside.addEventListener("touchstart", onStart, { passive: true });
    aside.addEventListener("touchend", onEnd, { passive: true });
    aside.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      aside.removeEventListener("touchstart", onStart);
      aside.removeEventListener("touchend", onEnd);
      aside.removeEventListener("touchcancel", onEnd);
    };
  }, [open, isNarrow, close]);

  // iOS Safari boundary scroll-trap workaround.
  //
  // When an inner overflow:scroll container has scrollTop === 0 OR scrollTop
  // pinned at scrollHeight - clientHeight, iOS Safari sometimes refuses to
  // recognise the next reverse-direction touch — the gesture is silently
  // discarded as "we're at the edge, nothing to do here", and the user has
  // to lift the finger and re-touch to get a response. Worst case it bubbles
  // out to the (locked) body and just freezes.
  //
  // The proven fix (used by body-scroll-lock, Vaul, Stripe, etc.): on every
  // touchstart, nudge scrollTop 1px off the boundary so the container always
  // appears scrollable in both directions. The 1px is invisible and momentum
  // scroll is unaffected.
  useEffect(() => {
    if (!open || !isNarrow) return;
    const el = bodyScrollRef.current;
    if (!el) return;

    const nudgeOffBoundary = () => {
      if (el.scrollTop <= 0) {
        el.scrollTop = 1;
      } else if (
        el.scrollTop + el.clientHeight >= el.scrollHeight
      ) {
        el.scrollTop = el.scrollHeight - el.clientHeight - 1;
      }
    };

    el.addEventListener("touchstart", nudgeOffBoundary, { passive: true });
    return () => el.removeEventListener("touchstart", nudgeOffBoundary);
  }, [open, isNarrow]);

  // Watch when the in-body anchor title scrolls past the top of the
  // drawer body — flip `titleHidden` so the header surfaces a fallback
  // title (owner/repo for GH). Resets to false on each item change.
  useEffect(() => {
    setTitleHidden(false);
    if (!open || !item) return;
    const el = bodyScrollRef.current;
    if (!el) return;
    const anchor = el.querySelector<HTMLElement>("[data-drawer-title-anchor]");
    if (!anchor) return;

    const onScroll = () => {
      // Title is "above the screen" once the bottom of the anchor element
      // is above the scroller's visible top.
      const threshold = anchor.offsetTop + anchor.offsetHeight;
      setTitleHidden(el.scrollTop > threshold);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [open, item?.id]);

  if (!open) return null;

  const isGithub = item?.source_type === "github";
  const isPh = item?.source_type === "product_hunt";
  const isClawhub = item?.source_type === "clawhub";
  const isHdx = item?.source_type === "huodongxing";
  const isHfPaper = item?.source_type === "hf_paper";
  const threadMembers =
    item && !isGithub && !isPh && !isClawhub && !isHdx && !isHfPaper
      ? resolveThreadMembers(item, siblings)
      : [];
  const githubOwnerRepo = isGithub ? (item?.title || item?.source_id || "") : "";
  const phName = isPh ? (item?.title || "") : "";
  const clawhubName = isClawhub ? (item?.title || item?.source_id || "") : "";
  const hdxName = isHdx ? (item?.title || "") : "";
  // HF Paper：title_zh > 英文 title fallback。drawer header 滚动后 reveal 中译。
  const hfExtra = isHfPaper
    ? (parseJsonField<{ title_zh?: string }>(item?.extra) as { title_zh?: string } | null)
    : null;
  const hfTitle = isHfPaper ? (hfExtra?.title_zh || item?.title || "") : "";
  // Default title is generic ("项目详情" / "推文详情" / etc.). Once the body's
  // own title element scrolls past the top, the header takes over and
  // displays the actual identifier (owner/repo for GH, name for PH).
  const defaultGithubTitle = "项目详情";
  const defaultPhTitle = "产品详情";
  const defaultClawhubTitle = "Skill 详情";
  const defaultHdxTitle = "活动详情";
  const defaultHfTitle = "论文拆解";
  const headerTitle = item
    ? isGithub
      ? titleHidden
        ? githubOwnerRepo || defaultGithubTitle
        : defaultGithubTitle
      : isPh
        ? titleHidden
          ? phName || defaultPhTitle
          : defaultPhTitle
        : isClawhub
          ? titleHidden
            ? clawhubName || defaultClawhubTitle
            : defaultClawhubTitle
          : isHdx
            ? titleHidden
              ? hdxName || defaultHdxTitle
              : defaultHdxTitle
            : isHfPaper
              ? titleHidden
                ? hfTitle || defaultHfTitle
                : defaultHfTitle
              : threadMembers.length > 1
                ? `Thread · ${threadMembers.length} 条`
                : "推文详情"
    : loading
      ? "加载中…"
      : error === "not_found"
        ? "内容不存在"
        : "加载失败";
  const externalLinkLabel = isGithub
    ? "在 GitHub 打开 ↗"
    : isPh
      ? "在 PH 打开 ↗"
      : isClawhub
        ? "在 ClawHub 打开 ↗"
        : isHdx
          ? "在活动行查看完整详情 ↗"
          : isHfPaper
            ? "在 HF 打开 ↗"
            : "打开X原文 ↗";
  const externalLinkTitle = isGithub
    ? "在 GitHub 打开"
    : isPh
      ? "在 Product Hunt 打开"
      : isClawhub
        ? "在 ClawHub 打开"
        : isHdx
          ? "在活动行打开"
          : isHfPaper
            ? "在 HuggingFace 打开"
            : "在 x.com 打开";

  // Double-tap on the title bar (excluding the back / external-link buttons)
  // scrolls the drawer body to top via 300ms ease-out (smoothScrollToTop).
  // Native `scrollTo({behavior:'smooth'})` duration varies across browsers
  // and feels inconsistent — fixed-duration animation is predictable.
  const onHeaderDoubleClick = (e: React.MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button, a")) return;
    smoothScrollToTop(bodyScrollRef.current);
  };

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      {/* Panel */}
      <aside
        ref={asideRef}
        // overflow-x-hidden + min-w-0 防御：
        //   - PC trackpad 双指横滑 / drawer 内某宽元素（长 URL、未处理的富文本图）
        //     会撑出 panel 宽 + 触发 horizontal scroll，视觉上 drawer 被拖偏。
        //   - 加 overflow-x-hidden 横向 clip 杜绝 panel 自身被横滑。
        //   - min-w-0 在 panel 作为 flex item 嵌套时防被子内容撑大（这里 absolute
        //     不是 flex item，但保留无害且一致性更好）。
        className="absolute inset-y-0 right-0 flex w-full max-w-[600px] min-w-0 flex-col overflow-x-hidden bg-white shadow-xl sm:w-[560px]"
        style={{
          transform: dragX > 0 ? `translateX(${dragX}px)` : undefined,
          transition: isDragging ? "none" : "transform 200ms ease-out",
        }}
      >
        <header
          className="grid grid-cols-3 items-center border-b border-neutral-200 px-2 py-1.5 sm:px-3"
          onDoubleClick={onHeaderDoubleClick}
        >
          <div className="justify-self-start">
            <button
              type="button"
              onClick={close}
              className="-ml-1 flex h-10 w-10 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 active:bg-neutral-200"
              aria-label={isNarrow ? "返回" : "关闭"}
            >
              {isNarrow ? (
                <span className="text-2xl leading-none">‹</span>
              ) : (
                <span className="text-base leading-none">✕</span>
              )}
            </button>
          </div>
          <div className="justify-self-center truncate text-sm font-semibold text-neutral-900">
            {headerTitle}
          </div>
          <div className="justify-self-end">
            {item && (
              <button
                type="button"
                onClick={onClickShare}
                className="-mr-1 flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 active:bg-neutral-200"
                aria-label="分享"
                title="分享"
              >
                <IconShare className="h-4 w-4" />
                <span>分享</span>
              </button>
            )}
          </div>
        </header>
        <div
          ref={bodyScrollRef}
          // overflow-x-hidden：drawer body 内任何宽过 panel 的内容（评论富文本里的
          // 长 URL、原文 wide pre block、宽截图等）都被横向 clip 而不是让 body 横滑。
          // 配合 panel 自身的 overflow-x-hidden 双保险。
          className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden overscroll-none touch-pan-y"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {/* 抽屉内所有 video 自动归 columnId='drawer'，scroll root = 抽屉 body */}
          <VideoColumnProvider columnId="drawer" scrollRoot={bodyScrollRef} hotZoneRatio={0.6}>
          {item ? (
            <>
              {isGithub ? (
                <GithubDrawerBody item={item} />
              ) : isPh ? (
                <PhDrawerBody item={item} />
              ) : isClawhub ? (
                <ClawhubDrawerBody item={item} />
              ) : isHdx ? (
                <HuodongxingDrawerBody item={item} />
              ) : isHfPaper ? (
                <HfPaperDrawerBody item={item} />
              ) : (
                <>
                  {threadMembers.map((it, idx) => {
                    const isTarget = it.id === item.id && threadMembers.length > 1;
                    const isFirst = idx === 0;
                    const isLast = idx === threadMembers.length - 1;
                    // 截断时最后一条 thread 仍画 connector below，连到截断提示
                    const truncationFollows = isLast && Boolean(siblings_has_more) && threadMembers.length > 1;
                    return (
                      <div
                        key={it.id}
                        ref={isTarget ? targetRef : undefined}
                        // B3+3.1: 蓝色目标高亮用 inset box-shadow 不占布局空间，
                        // 避免 border-l-2 把 TweetCard 整体向右挤 2px 导致
                        // connector line 错位（用户验收 issue 3.1）
                        className={cn(
                          "relative",
                          isTarget && "shadow-[inset_2px_0_0_#0ea5e9] bg-sky-50/40",
                        )}
                      >
                        <TweetCard
                          item={it}
                          embedded
                          hideThreadBanner
                          hasThreadAbove={threadMembers.length > 1 && !isFirst}
                          hasThreadBelow={threadMembers.length > 1 && (!isLast || truncationFollows)}
                        />
                      </div>
                    );
                  })}
                  {siblings_has_more && threadMembers.length > 1 && (
                    <div className="border-b border-neutral-200 px-4 py-3 text-[13px] text-neutral-500">
                      <span className="ml-[52px]">
                        以下推文已截断（仅显示前 {threadMembers.length} 条）
                      </span>
                    </div>
                  )}
                </>
              )}
              {item.url && (
                <div className="flex justify-center border-t border-neutral-100 px-4 py-5">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => {
                      let host = "x.com";
                      try { host = new URL(item.url!).host; } catch {}
                      track(EVENTS.EXTERNAL_LINK_CLICK, {
                        item_id: item.id,
                        target_url_host: host,
                      });
                    }}
                    className="inline-flex items-center justify-center rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
                    title={externalLinkTitle}
                  >
                    {externalLinkLabel}
                  </a>
                </div>
              )}
            </>
          ) : loading ? (
            <DrawerSkeleton />
          ) : (
            <DrawerError code={error} onClose={close} />
          )}
          </VideoColumnProvider>
        </div>
      </aside>
      {item && (
        <ShareDialog
          open={shareOpen}
          itemId={item.id}
          cachedShare={shareCache[item.id] ?? null}
          onShareCreated={(id, share) => setShareCache((prev) => ({ ...prev, [id]: share }))}
          onClose={() => setShareOpen(false)}
        />
      )}
    </div>
  );
}

function DrawerSkeleton() {
  return (
    <div className="animate-pulse space-y-3 p-4">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-full bg-neutral-200" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-1/3 rounded bg-neutral-200" />
          <div className="h-3 w-1/4 rounded bg-neutral-200" />
        </div>
      </div>
      <div className="space-y-2">
        <div className="h-3 w-full rounded bg-neutral-200" />
        <div className="h-3 w-11/12 rounded bg-neutral-200" />
        <div className="h-3 w-3/4 rounded bg-neutral-200" />
      </div>
    </div>
  );
}

function DrawerError({
  code,
  onClose,
}: {
  code: "not_found" | "network" | null;
  onClose: () => void;
}) {
  const message =
    code === "not_found"
      ? "这条推文不存在或已被删除。"
      : "加载失败，请检查网络后重试。";
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm text-neutral-600">{message}</p>
      <button
        type="button"
        onClick={onClose}
        className="rounded-md border border-neutral-200 bg-white px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
      >
        返回首页
      </button>
    </div>
  );
}

// If item has thread_root_id and siblings contains thread members,
// return them sorted chronologically. Otherwise return just [item].
function resolveThreadMembers(item: Item, siblings: Item[]): Item[] {
  const extra = parseJsonField<ItemExtra>(item.extra);
  const rootId = extra?.thread_root_id;
  if (!rootId) return [item];
  const group = siblings.filter((s) => {
    const e = parseJsonField<ItemExtra>(s.extra);
    return e?.thread_root_id === rootId;
  });
  // Include the clicked item if missing from siblings
  if (!group.find((s) => s.id === item.id)) group.push(item);
  if (group.length < 2) return [item];
  return [...group].sort((a, b) => {
    const ta = a.published_at || a.scraped_at;
    const tb = b.published_at || b.scraped_at;
    const timeCmp = ta.localeCompare(tb);
    if (timeCmp !== 0) return timeCmp;
    return a.source_id.localeCompare(b.source_id);
  });
}
