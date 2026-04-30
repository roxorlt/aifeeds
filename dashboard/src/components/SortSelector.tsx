import { cn } from "../lib/utils";

export type SortMode = "hot" | "time";

interface Props {
  value: SortMode;
  onChange: (mode: SortMode) => void;
}

const LABELS: Record<SortMode, string> = {
  hot: "热度",
  time: "时间",
};

export function SortSelector({ value, onChange }: Props) {
  const handle = (mode: SortMode) => (e: React.MouseEvent) => {
    e.stopPropagation(); // don't bubble to header tap-to-scroll
    if (mode !== value) onChange(mode);
  };
  const cls = (mode: SortMode) =>
    cn(
      "transition-colors",
      value === mode
        ? "font-semibold text-neutral-900"
        : "text-neutral-400 hover:text-neutral-700",
    );
  return (
    <div className="inline-flex items-center gap-1.5 text-[11px]">
      <button type="button" onClick={handle("hot")} className={cls("hot")}>
        {LABELS.hot}
      </button>
      <span className="text-neutral-300">·</span>
      <button type="button" onClick={handle("time")} className={cls("time")}>
        {LABELS.time}
      </button>
    </div>
  );
}
