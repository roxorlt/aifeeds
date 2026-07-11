import { useCallback, useEffect, useRef, useState } from "react";
import { useDrawer } from "../lib/drawerContext";
import { track, EVENTS } from "../lib/telemetry";
import { TweetCard } from "./TweetCard";
import { GithubDrawerBody } from "./GithubDrawerBody";
import { PhDrawerBody } from "./PhDrawerBody";
import { ClawhubDrawerBody } from "./ClawhubDrawerBody";
import { HuodongxingDrawerBody } from "./HuodongxingDrawerBody";
import { HfPaperDrawerBody } from "./HfPaperDrawerBody";
import { BlogDrawerBody } from "./BlogDrawerBody";
import { PodcastDrawerBody } from "./PodcastDrawerBody";
import { parseJsonField, cn } from "../lib/utils";
import { useIsNarrow } from "../lib/breakpoint";
import { smoothScrollToTop } from "../lib/scroll";
import { IconShare } from "./icons";
import { ShareDialog } from "./ShareDialog";
import { useAuthStore } from "../lib/authStore";
import { VideoColumnProvider } from "../lib/videoColumnContext";
import type { CreateShareResponse } from "../lib/share";
import type { Item, ItemExtra } from "../types";
import {
  DRAWER_EASE,
  drawerActivationMode,
  shouldCommitDismiss,
  shouldReduceMotion,
} from "../lib/motion";
import { activateModalFocus } from "../lib/modalFocus";

const SWIPE_EDGE_BUFFER = 24; // px from left edge — leave room for system back gesture
const DRAWER_ENTER_MS = 260;
const DRAWER_EXIT_MS = 200;

export function TweetDrawer() {
  const { state, close, depth } = useDrawer();
  const { item, siblings, siblings_has_more, metrics_history, loading, error } = state;
  const open = Boolean(item) || loading || Boolean(error);
  const activeItemId = item?.id ?? null;
  const isNarrow = useIsNarrow();
  // 顶栏左上：抽屉内下钻（depth>0，如点进 PH「同类产品」）→ 显示「←」返回上一条；
  // 否则保持原行为（窄屏「‹」返回流内、宽屏「✕」关闭）。
  const showBack = isNarrow || depth > 0;
  const targetRef = useRef<HTMLDivElement | null>(null);

  // Scroll the URL-targeted tweet into view when opening into a thread where
  // the target isn't the root. X-style behavior for shared replies.
  useEffect(() => {
    if (!activeItemId) return;
    const node = targetRef.current;
    if (!node) return;
    requestAnimationFrame(() => {
      node.scrollIntoView({ behavior: "auto", block: "start" });
    });
  }, [activeItemId]);

  const asideRef = useRef<HTMLElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const closingRef = useRef(false);
  const closeTimerRef = useRef<number | null>(null);
  const drawerWasOpenRef = useRef(false);

  const applyDrawerPosition = useCallback((x: number, duration: number) => {
    const aside = asideRef.current;
    if (!aside) return;
    const width = Math.max(window.innerWidth, 1);
    const ratio = Math.min(Math.max(x / width, 0), 1);
    const transition = duration > 0
      ? `transform ${duration}ms ${DRAWER_EASE}`
      : "none";
    aside.style.transition = transition;
    aside.style.transform = `translateX(${Math.max(x, 0)}px)`;
    if (backdropRef.current) {
      backdropRef.current.style.transition = duration > 0
        ? `opacity ${duration}ms ${DRAWER_EASE}`
        : "none";
      backdropRef.current.style.opacity = String(0.4 * (1 - ratio));
    }
  }, []);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    if (shouldReduceMotion()) {
      close();
      return;
    }
    closingRef.current = true;
    applyDrawerPosition(window.innerWidth, DRAWER_EXIT_MS);
    closeTimerRef.current = window.setTimeout(close, DRAWER_EXIT_MS);
  }, [applyDrawerPosition, close]);

  useEffect(() => {
    const clearCloseTimer = () => {
      if (closeTimerRef.current === null) return;
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    };
    const activation = drawerActivationMode(drawerWasOpenRef.current, open);
    drawerWasOpenRef.current = open;
    closingRef.current = false;
    clearCloseTimer();

    if (activation === "closed") return clearCloseTimer;
    if (activation === "restore" || shouldReduceMotion()) {
      applyDrawerPosition(0, 0);
      return clearCloseTimer;
    }

    applyDrawerPosition(window.innerWidth, 0);
    const raf = requestAnimationFrame(() => {
      applyDrawerPosition(0, DRAWER_ENTER_MS);
    });
    return () => {
      cancelAnimationFrame(raf);
      clearCloseTimer();
    };
  }, [open, item?.id, depth, applyDrawerPosition]);
  // Tracks whether the in-body title (owner/repo for GH, etc.) has scrolled
  // above the visible area — when true, the header surfaces it as a
  // "sticky" replacement title.
  const [titleVisibility, setTitleVisibility] = useState<{
    itemId: string;
    hidden: boolean;
  } | null>(null);
  const titleHidden = titleVisibility?.itemId === activeItemId
    ? titleVisibility.hidden
    : false;
  const [shareOpen, setShareOpen] = useState(false);
  const user = useAuthStore((s) => s.user);
  const openLoginModal = useAuthStore((s) => s.openLoginModal);
  const activeUserId = user?.id ?? null;
  // 同一账号 + itemId 不重复 createShare。账号键属于状态本身，因此换号时
  // 新 render 直接看见空 cache，不需要 effect 再触发一次清空 render。
  const [shareCacheState, setShareCacheState] = useState<{
    userId: string | null;
    entries: Record<string, CreateShareResponse>;
  }>({ userId: null, entries: {} });
  const shareCache = shareCacheState.userId === activeUserId
    ? shareCacheState.entries
    : {};

  // PM 2026-05-22 反馈:换账号点同一 feed 分享时不应复用上一账号的 token
  // (token 跟 from_uid 绑定, 海报 footer 含分享人 name + avatar + token QR,
  // user2 拿 user1 token 等于把 user1 信息分发出去)。

  const onClickShare = () => {
    if (!user) {
      // 未登录 → 弹登录 modal，登录成功后 retry 自动打开 ShareDialog
      openLoginModal("manual", () => setShareOpen(true));
      return;
    }
    setShareOpen(true);
  };
  const dragStart = useRef<{ x: number; y: number; at: number; identifier: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  useEffect(() => {
    if (!open) return;
    const aside = asideRef.current;
    if (!aside) return;
    return activateModalFocus(aside);
  }, [open]);

  // R21: 架构改造 mobile body 永久 fixed, scroll context 转到 #root.
  // drawer 打开 lock #root scroll (不是 body), 关闭 restore.
  // PC 仍走 body lock 老路径.
  useEffect(() => {
    if (!open) return;
    const isNarrow = window.matchMedia("(max-width: 767px)").matches;
    const root = document.getElementById("root");
    if (isNarrow && root) {
      // mobile: lock #root
      const sy = root.scrollTop;
      const prev = {
        overflow: root.style.overflow,
        position: root.style.position,
      };
      root.style.overflow = "hidden";
      // 保 scroll position: #root 已经 overflow:auto, 直接 fix scrollTop 即可
      // (内容长 + position relative 不动)
      return () => {
        root.style.overflow = prev.overflow;
        root.style.position = prev.position;
        root.scrollTop = sy;
      };
    }
    // PC: body lock 老路径
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
      window.scrollTo(0, scrollY);
    };
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
  // touchmove 阶段直接写 transform/backdrop opacity 让抽屉跟手。
  // 早期方向锁定避开 native vertical scroll：touchmove 必须非 passive，
  // 只在横向锁定后 preventDefault；纵向锁定则 allow native vertical scroll。
  // direction='horizontal' 且 dx > 0 才接管；多指和系统返回边缘均不接管。
  useEffect(() => {
    if (!open || !isNarrow) return;
    const aside = asideRef.current;
    if (!aside) return;

    let direction: 'unknown' | 'horizontal' | 'vertical' = 'unknown';

    const findTouch = (touches: TouchList) => {
      const identifier = dragStart.current?.identifier;
      return Array.from(touches).find((touch) => touch.identifier === identifier);
    };

    const resetGesture = (snapBack = true) => {
      dragStart.current = null;
      direction = 'unknown';
      if (snapBack && !closingRef.current) applyDrawerPosition(0, DRAWER_EXIT_MS);
    };

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        resetGesture();
        return;
      }
      const t = e.touches[0];
      if (t.clientX < SWIPE_EDGE_BUFFER) {
        resetGesture(false);
        return;
      }
      dragStart.current = {
        x: t.clientX,
        y: t.clientY,
        at: performance.now(),
        identifier: t.identifier,
      };
      direction = 'unknown';
    };

    const onMove = (e: TouchEvent) => {
      if (!dragStart.current) return;
      if (e.touches.length !== 1) {
        resetGesture();
        return;
      }
      const t = findTouch(e.touches);
      if (!t) return;
      const dx = t.clientX - dragStart.current.x;
      const dy = t.clientY - dragStart.current.y;
      const absDx = Math.abs(dx), absDy = Math.abs(dy);
      if (direction === 'unknown') {
        if (absDx < 10 && absDy < 10) return;
        if (absDx > absDy * 2) {
          direction = 'horizontal';
        } else if (absDy > absDx * 2) {
          // Vertical lock: abort and allow native vertical scroll.
          direction = 'vertical';
          dragStart.current = null;
          return;
        } else {
          return;
        }
      }
      if (direction === 'horizontal') {
        if (e.cancelable) e.preventDefault();
        applyDrawerPosition(dx > 0 ? dx : 0, 0);
      }
    };

    const onEnd = (e: TouchEvent) => {
      const start = dragStart.current;
      if (!start) return;
      const t = findTouch(e.changedTouches);
      if (!t) {
        resetGesture();
        return;
      }
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const elapsedMs = Math.max(performance.now() - start.at, 1);
      const shouldClose = direction === 'horizontal' && shouldCommitDismiss({
        distance: dx,
        crossAxis: dy,
        elapsedMs,
        viewport: window.innerWidth,
      });
      if (shouldClose) {
        requestClose();
      } else {
        applyDrawerPosition(0, DRAWER_EXIT_MS);
      }
      resetGesture(false);
    };

    const onCancel = () => resetGesture();

    aside.addEventListener("touchstart", onStart, { passive: true });
    aside.addEventListener("touchmove", onMove, { passive: false });
    aside.addEventListener("touchend", onEnd, { passive: true });
    aside.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      aside.removeEventListener("touchstart", onStart);
      aside.removeEventListener("touchmove", onMove);
      aside.removeEventListener("touchend", onEnd);
      aside.removeEventListener("touchcancel", onCancel);
    };
  }, [open, isNarrow, applyDrawerPosition, requestClose]);

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
  // title (owner/repo for GH). State carries its item id, so a new item is
  // false immediately without a synchronous reset effect.
  useEffect(() => {
    if (!open || !activeItemId) return;
    const el = bodyScrollRef.current;
    if (!el) return;
    const anchor = el.querySelector<HTMLElement>("[data-drawer-title-anchor]");
    if (!anchor) return;

    const onScroll = () => {
      // Title is "above the screen" once the bottom of the anchor element
      // is above the scroller's visible top.
      const threshold = anchor.offsetTop + anchor.offsetHeight;
      setTitleVisibility({
        itemId: activeItemId,
        hidden: el.scrollTop > threshold,
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener("scroll", onScroll);
  }, [open, activeItemId]);

  if (!open) return null;

  const isGithub = item?.source_type === "github";
  const isPh = item?.source_type === "product_hunt";
  const isClawhub = item?.source_type === "clawhub";
  const isHdx = item?.source_type === "huodongxing";
  const isHfPaper = item?.source_type === "hf_paper";
  const isBlog = item?.source_type === "blog";
  const isPodcast = item?.source_type === "podcast";
  const threadMembers =
    item && !isGithub && !isPh && !isClawhub && !isHdx && !isHfPaper && !isBlog && !isPodcast
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
  // blog/podcast：item.title 已是中译标题,drawer header 滚动后 reveal。
  const blogName = isBlog ? (item?.title || "") : "";
  const podcastName = isPodcast ? (item?.title || "") : "";
  // Default title is generic ("项目详情" / "推文详情" / etc.). Once the body's
  // own title element scrolls past the top, the header takes over and
  // displays the actual identifier (owner/repo for GH, name for PH).
  const defaultGithubTitle = "项目详情";
  const defaultPhTitle = "产品详情";
  const defaultClawhubTitle = "Skill 详情";
  const defaultHdxTitle = "活动详情";
  const defaultHfTitle = "论文详情";
  const defaultBlogTitle = "博客详情";
  const defaultPodcastTitle = "播客详情";
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
              : isBlog
                ? titleHidden
                  ? blogName || defaultBlogTitle
                  : defaultBlogTitle
                : isPodcast
                  ? titleHidden
                    ? podcastName || defaultPodcastTitle
                    : defaultPodcastTitle
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
            : isBlog
              ? "阅读原文 ↗"
              : isPodcast
                ? "在原平台收听 ↗"
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
            : isBlog
              ? "在原博客打开"
              : isPodcast
                ? "在播客平台打开"
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
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tweet-drawer-title"
    >
      {/* Backdrop — opacity 跟 drag 联动让底层频道流自然透出, 配 aside slide */}
      <div
        ref={backdropRef}
        className="absolute inset-0 bg-black"
        onClick={requestClose}
        style={{
          opacity: 0,
          transition: `opacity ${DRAWER_ENTER_MS}ms ${DRAWER_EASE}`,
        }}
      />
      {/* Panel */}
      <aside
        ref={asideRef}
        tabIndex={-1}
        // overflow-x-hidden + min-w-0 防御：
        //   - PC trackpad 双指横滑 / drawer 内某宽元素（长 URL、未处理的富文本图）
        //     会撑出 panel 宽 + 触发 horizontal scroll，视觉上 drawer 被拖偏。
        //   - 加 overflow-x-hidden 横向 clip 杜绝 panel 自身被横滑。
        //   - min-w-0 在 panel 作为 flex item 嵌套时防被子内容撑大（这里 absolute
        //     不是 flex item，但保留无害且一致性更好）。
        className="absolute inset-y-0 right-0 flex w-full max-w-[600px] min-w-0 flex-col overflow-x-hidden bg-white shadow-xl sm:w-[560px]"
        style={{
          transform: "translateX(100%)",
          transition: `transform ${DRAWER_ENTER_MS}ms ${DRAWER_EASE}`,
        }}
      >
        {/* PM 2026-05-19: mobile 长 title 跟「分享」按钮 overlap。
            原 grid-cols-3 三列等宽,middle cell 在 360 屏 ≈ 120px 装不下长 title,
            justify-self-center + truncate 在窄 cell 内仍 by-content 撑出。
            改 grid-cols-[auto_1fr_auto]:左右 button by-content,中间 1fr 占剩余 +
            min-w-0 让 truncate 真正生效。配合 px-2 内边距防 ellipsis 紧贴按钮 */}
        <header
          className="grid grid-cols-[auto_1fr_auto] items-center border-b border-neutral-200 px-2 py-1.5 sm:px-3"
          onDoubleClick={onHeaderDoubleClick}
        >
          <div className="justify-self-start">
            <button
              type="button"
              onClick={depth > 0 ? close : requestClose}
              data-modal-initial-focus
              className="-ml-1 flex h-10 w-10 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 active:bg-neutral-200"
              aria-label={showBack ? "返回" : "关闭"}
            >
              {showBack ? (
                <span className="text-2xl leading-none">‹</span>
              ) : (
                <span className="text-base leading-none">✕</span>
              )}
            </button>
          </div>
          {/* PM 2026-05-20: title 上推后 standin 居中不准 — cell h-10 跟左右
              button 等高 + flex items-center 让文字精确 cross-axis 居中,
              避免依赖 grid items-center 时 text line-box 默认 leading 偏移 */}
          <div className="flex h-10 min-w-0 items-center justify-center px-2">
            <span
              id="tweet-drawer-title"
              className="truncate text-sm font-semibold text-neutral-900"
            >
              {headerTitle}
            </span>
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
          className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden overscroll-none"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {/* 抽屉内所有 video 自动归 columnId='drawer'，scroll root = 抽屉 body */}
          <VideoColumnProvider columnId="drawer" scrollRoot={bodyScrollRef} hotZoneRatio={0.6}>
          {item ? (
            <>
              {isGithub ? (
                <GithubDrawerBody item={item} metricsHistory={metrics_history} />
              ) : isPh ? (
                <PhDrawerBody item={item} />
              ) : isClawhub ? (
                <ClawhubDrawerBody item={item} metricsHistory={metrics_history} />
              ) : isHdx ? (
                <HuodongxingDrawerBody item={item} />
              ) : isHfPaper ? (
                <HfPaperDrawerBody item={item} />
              ) : isBlog ? (
                <BlogDrawerBody item={item} />
              ) : isPodcast ? (
                <PodcastDrawerBody item={item} />
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
              {/* PM v5: HF paper 抽屉 body 内已有「外部链接」3 chip(arxiv/GH/项目主页),
                  drawer 框架 footer 的「在 HF 打开」按钮跟那里重复了,砍掉。其他源保留。 */}
              {item.url && !isHfPaper && (
                <div className="flex justify-center border-t border-neutral-100 px-4 py-5">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => {
                      let host = "x.com";
                      try { host = new URL(item.url!).host; } catch {
                        // 非法 URL 仍按默认 x.com host 上报，外链本身保持可点击。
                      }
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
            <DrawerError code={error} onClose={requestClose} />
          )}
          </VideoColumnProvider>
        </div>
      </aside>
      {item && (
        <ShareDialog
          open={shareOpen}
          item={item}
          cachedShare={shareCache[item.id] ?? null}
          onShareCreated={(id, share) => setShareCacheState((prev) => ({
            userId: activeUserId,
            entries: {
              ...(prev.userId === activeUserId ? prev.entries : {}),
              [id]: share,
            },
          }))}
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
