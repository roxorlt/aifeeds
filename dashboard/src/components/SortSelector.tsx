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
  const cls = (mode: SortMode) =>
    cn(
      "transition-colors",
      value === mode
        ? "font-semibold text-neutral-900"
        : "text-neutral-600 group-hover:text-neutral-800",
    );
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation(); // don't bubble to header tap-to-scroll
        onChange(value === "hot" ? "time" : "hot");
      }}
      className="group inline-flex items-center text-[11px]"
      aria-label={`排序方式：热度 / 时间（当前 ${LABELS[value]}）`}
    >
      <span className={cls("hot")}>{LABELS.hot}</span>
      <span className="text-neutral-500">|</span>
      <span className={cls("time")}>{LABELS.time}</span>
    </button>
  );
}
