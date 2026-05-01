import { useEffect, useRef, useState } from "react";
import { useDrawer } from "../lib/drawer";
import { TweetCard } from "./TweetCard";
import { GithubDrawerBody } from "./GithubDrawerBody";
import { parseJsonField, cn } from "../lib/utils";
import { useIsNarrow } from "../lib/breakpoint";
import type { Item, ItemExtra } from "../types";

const SWIPE_EDGE_BUFFER = 24; // px from left edge — leave room for system back gesture
const SWIPE_COMMIT_PX = 80; // dx threshold to commit close
const SWIPE_ANIM_MS = 200;

export function TweetDrawer() {
  const { state, close } = useDrawer();
  const { item, siblings, loading, error } = state;
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
  const [dragX, setDragX] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
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

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
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

  // Mobile swipe-to-close: drag panel rightward to dismiss.
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
    const onMove = (e: TouchEvent) => {
      if (!dragStart.current) return;
      const t = e.touches[0];
      const dx = t.clientX - dragStart.current.x;
      const dy = t.clientY - dragStart.current.y;

      // Stay on the fence until the gesture has moved at least 10px in some
      // direction. Otherwise tiny horizontal jitter on a vertical swipe (e.g.
      // when scrolling at the README bottom and reversing direction) would
      // hit the dx > 0 branch and preventDefault, blocking native scroll.
      const moved = Math.max(Math.abs(dx), Math.abs(dy));
      if (moved < 10) return;

      // Decision: vertical wins → not a close gesture, abort drag.
      if (Math.abs(dy) >= Math.abs(dx)) {
        dragStart.current = null;
        setDrag(0);
        setIsDragging(false);
        return;
      }
      // Horizontal: only rightward swipe closes.
      if (dx <= 0) {
        dragStart.current = null;
        setDrag(0);
        setIsDragging(false);
        return;
      }
      if (e.cancelable) e.preventDefault();
      setIsDragging(true);
      setDrag(dx);
    };
    const onEnd = () => {
      if (!dragStart.current) return;
      if (dragXRef.current > SWIPE_COMMIT_PX) {
        // Commit: slide off-screen, then close after transition
        setIsDragging(false);
        setDrag(window.innerWidth);
        setTimeout(close, SWIPE_ANIM_MS);
      } else {
        // Spring back
        setIsDragging(false);
        setDrag(0);
      }
      dragStart.current = null;
    };

    aside.addEventListener("touchstart", onStart, { passive: true });
    aside.addEventListener("touchmove", onMove, { passive: false });
    aside.addEventListener("touchend", onEnd);
    aside.addEventListener("touchcancel", onEnd);
    return () => {
      aside.removeEventListener("touchstart", onStart);
      aside.removeEventListener("touchmove", onMove);
      aside.removeEventListener("touchend", onEnd);
      aside.removeEventListener("touchcancel", onEnd);
    };
  }, [open, isNarrow, close]);

  if (!open) return null;

  const isGithub = item?.source_type === "github";
  const threadMembers = item && !isGithub ? resolveThreadMembers(item, siblings) : [];
  const headerTitle = item
    ? isGithub
      ? "GitHub 项目详情"
      : threadMembers.length > 1
        ? `Thread · ${threadMembers.length} 条`
        : "推文详情"
    : loading
      ? "加载中…"
      : error === "not_found"
        ? "内容不存在"
        : "加载失败";
  const externalLinkLabel = isGithub ? "在 GitHub 打开 ↗" : "打开X原文 ↗";
  const externalLinkTitle = isGithub ? "在 GitHub 打开" : "在 x.com 打开";

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={close} />
      {/* Panel */}
      <aside
        ref={asideRef}
        className="absolute inset-y-0 right-0 flex w-full max-w-[600px] flex-col bg-white shadow-xl sm:w-[560px]"
        style={{
          transform: dragX > 0 ? `translateX(${dragX}px)` : undefined,
          transition: isDragging ? "none" : "transform 200ms ease-out",
        }}
      >
        <header className="grid grid-cols-3 items-center border-b border-neutral-200 bg-neutral-50 px-2 py-1.5 sm:px-3">
          <div className="justify-self-start">
            <button
              type="button"
              onClick={close}
              className="-ml-1 flex h-10 w-10 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-200 active:bg-neutral-300"
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
            {item?.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-200"
                title={externalLinkTitle}
              >
                {externalLinkLabel}
              </a>
            )}
          </div>
        </header>
        <div className="flex-1 overflow-y-auto overscroll-contain">
          {item ? (
            isGithub ? (
              <GithubDrawerBody item={item} />
            ) : (
              threadMembers.map((it) => {
                const isTarget = it.id === item.id && threadMembers.length > 1;
                return (
                  <div
                    key={it.id}
                    ref={isTarget ? targetRef : undefined}
                    className={cn(
                      isTarget &&
                        "border-l-2 border-sky-500 bg-sky-50/40",
                    )}
                  >
                    <TweetCard item={it} embedded hideThreadBanner />
                  </div>
                );
              })
            )
          ) : loading ? (
            <DrawerSkeleton />
          ) : (
            <DrawerError code={error} onClose={close} />
          )}
        </div>
      </aside>
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
