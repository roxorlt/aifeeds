import { useEffect } from "react";
import { useDrawer } from "../lib/drawer";
import { TweetCard } from "./TweetCard";
import { parseJsonField } from "../lib/utils";
import type { Item, ItemExtra } from "../types";

export function TweetDrawer() {
  const { state, close } = useDrawer();
  const { item, siblings } = state;
  const open = Boolean(item);

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

  if (!item) return null;

  // If this tweet is part of a thread and we have siblings, show them in order.
  // Otherwise just show the single tweet.
  const threadMembers = resolveThreadMembers(item, siblings);

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        onClick={close}
      />
      {/* Panel */}
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-[600px] flex-col bg-white shadow-xl sm:w-[560px]">
        <header className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50 px-4 py-2.5">
          <div className="text-sm font-semibold text-neutral-900">
            {threadMembers.length > 1 ? `Thread · ${threadMembers.length} 条` : "推文详情"}
          </div>
          <div className="flex items-center gap-1">
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-200"
                title="在 x.com 打开"
              >
                ↗
              </a>
            )}
            <button
              type="button"
              onClick={close}
              className="rounded-md px-2 py-1 text-lg text-neutral-500 hover:bg-neutral-200"
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">
          {threadMembers.map((it) => (
            <TweetCard key={it.id} item={it} embedded hideThreadBanner />
          ))}
        </div>
      </aside>
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
