import { useEffect } from "react";
import { useDrawer } from "../lib/drawer";
import { TweetCard } from "./TweetCard";
import { parseJsonField } from "../lib/utils";
import { useIsNarrow } from "../lib/breakpoint";
import type { Item, ItemExtra } from "../types";

export function TweetDrawer() {
  const { state, close } = useDrawer();
  const { item, siblings, loading, error } = state;
  const open = Boolean(item) || loading || Boolean(error);
  const isNarrow = useIsNarrow();

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

  if (!open) return null;

  const threadMembers = item ? resolveThreadMembers(item, siblings) : [];
  const headerTitle = item
    ? threadMembers.length > 1
      ? `Thread · ${threadMembers.length} 条`
      : "推文详情"
    : loading
      ? "加载中…"
      : error === "not_found"
        ? "推文不存在"
        : "加载失败";

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={close}
      />
      {/* Panel */}
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[600px] flex-col bg-white shadow-xl sm:w-[560px]">
        <header className="grid grid-cols-3 items-center border-b border-neutral-200 bg-neutral-50 px-2 py-2 sm:px-3">
          <div className="justify-self-start">
            <button
              type="button"
              onClick={close}
              className="rounded-md px-2 py-1 text-neutral-600 hover:bg-neutral-200"
              aria-label={isNarrow ? "返回" : "关闭"}
            >
              {isNarrow ? (
                <span className="text-xl leading-none">‹</span>
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
                title="在 x.com 打开"
              >
                原文
              </a>
            )}
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          {item ? (
            threadMembers.map((it) => (
              <TweetCard key={it.id} item={it} embedded hideThreadBanner />
            ))
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
