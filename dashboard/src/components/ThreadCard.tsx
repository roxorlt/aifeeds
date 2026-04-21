import { useState } from "react";
import type { Item } from "../types";
import { TweetCard } from "./TweetCard";

interface Props {
  items: Item[]; // sorted by published_at ascending (root first)
}

export function ThreadCard({ items }: Props) {
  const [open, setOpen] = useState(false);
  const [root, ...rest] = items;
  const replyCount = rest.length;
  const hasReplies = replyCount > 0;

  return (
    <div className="border-b border-neutral-200">
      <TweetCard
        item={root}
        hideThreadBanner
        inThread
        siblings={items}
        hasThreadBelow={hasReplies}
      />
      {hasReplies && open &&
        rest.map((it, idx) => (
          <TweetCard
            key={it.id}
            item={it}
            hideThreadBanner
            inThread
            siblings={items}
            hasThreadAbove
            hasThreadBelow={idx < rest.length - 1}
          />
        ))}
      {hasReplies && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="relative block w-full px-4 py-2 pl-[68px] text-left text-[14px] text-sky-600 hover:bg-neutral-50/60 hover:underline"
        >
          {!open && (
            <span className="pointer-events-none absolute left-[35px] top-0 bottom-1/2 w-[2px] bg-gradient-to-b from-neutral-200 to-transparent" />
          )}
          {open ? "收起Thread" : `展开Thread ${replyCount}条`}
        </button>
      )}
    </div>
  );
}
