import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/utils";

export type SortMode = "hot" | "time";

interface Props {
  value: SortMode;
  onChange: (mode: SortMode) => void;
  isNarrow: boolean;
}

const LABELS: Record<SortMode, string> = {
  hot: "热度",
  time: "时间",
};

export function SortSelector({ value, onChange, isNarrow }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // PC: close on outside click
  useEffect(() => {
    if (!open || isNarrow) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open, isNarrow]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      onClick={(e) => {
        e.stopPropagation(); // don't bubble to header tap-to-scroll
        setOpen((v) => !v);
      }}
      className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-neutral-700 hover:text-neutral-900"
    >
      {LABELS[value]}
      <span className="text-[9px] text-neutral-400">▾</span>
    </button>
  );

  if (!isNarrow) {
    // PC: inline popover anchored under trigger
    return (
      <span className="relative inline-block">
        {trigger}
        {open && (
          <div
            ref={popoverRef}
            className="absolute right-0 top-full z-20 mt-1 w-24 rounded-md border border-neutral-200 bg-white py-1 shadow-md"
          >
            {(["hot", "time"] as SortMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(mode);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-1.5 text-[12px] text-left",
                  value === mode
                    ? "font-semibold text-sky-600"
                    : "text-neutral-700 hover:bg-neutral-50",
                )}
              >
                <span>{LABELS[mode]}</span>
                {value === mode && <span className="text-[10px]">✓</span>}
              </button>
            ))}
          </div>
        )}
      </span>
    );
  }

  // Mobile: bottom sheet
  return (
    <>
      {trigger}
      {open && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end bg-black/30"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(false);
          }}
        >
          <div
            className="rounded-t-2xl bg-white pb-2 pt-2 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2 text-center text-[12px] text-neutral-500">
              排序方式
            </div>
            {(["hot", "time"] as SortMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  onChange(mode);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between border-t border-neutral-100 px-5 py-3.5 text-[15px]",
                  value === mode
                    ? "font-semibold text-sky-600"
                    : "text-neutral-900",
                )}
              >
                <span>{LABELS[mode]}</span>
                {value === mode && <span className="text-sky-600">✓</span>}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="mt-2 flex w-full items-center justify-center border-t-8 border-neutral-100 py-3.5 text-[15px] font-medium text-neutral-900"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </>
  );
}
