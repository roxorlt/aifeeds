# Frontend Responsive Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 7 frontend issues + brand rename (xList → AI-Feeds) as one iteration on dashboard. Spec: `docs/superpowers/specs/2026-04-29-frontend-responsive-iteration-design.md`.

**Architecture:** Pure CSS breakpoint at `md: 768px` for layout split. New shared utilities `lib/scroll.ts` (300ms ease-out RAF) and `lib/breakpoint.ts` (matchMedia hook). New `SortSelector.tsx` component with bottom-sheet (mobile) / inline-dropdown (PC) variants. Existing `App.tsx` + `Feed.tsx` + `TweetCard.tsx` get targeted edits.

**Tech Stack:** React 19, Vite 8, Tailwind 4, TypeScript 6 (no test runner — verification = `npm run build` + manual browser smoke).

**Worktree:** `/Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-responsive-iteration` on branch `feat/responsive-iteration`.

**Project layout note:** All paths in this plan are relative to repo root unless specified. Dashboard subdir is `dashboard/`; tsc + vite invoked from there.

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `dashboard/src/lib/scroll.ts` | **new** | RAF-based scroll animation (300ms ease-out); `scrollFeedOrPage` breakpoint-aware helper |
| `dashboard/src/lib/breakpoint.ts` | **new** | `useIsNarrow()` React hook over `(max-width: 767px)` matchMedia |
| `dashboard/src/components/SortSelector.tsx` | **new** | Sort selector — mobile bottom sheet + PC inline dropdown |
| `dashboard/src/App.tsx` | modify | Title rename, responsive chips, PC layout container, top bar smart回顶 |
| `dashboard/src/components/Feed.tsx` | modify | Border removal on mobile, cell `max-h` on PC, sort component swap, header tap回顶 (PC), PRR listener migration |
| `dashboard/src/components/TweetCard.tsx` | modify | 4-slot metric rendering, pointer-down/click selection check |

---

## Task Sequence Rationale

Ordering ensures every commit is a working state:

1. **Tasks 1-2** add invisible utilities (no UI delta)
2. **Tasks 3-4** modify TweetCard in isolation (visible per-tweet, low risk)
3. **Task 5** swaps existing scroll-to-top calls to use shared utility (UI feel change)
4. **Tasks 6-7** introduce SortSelector (visible Feed header change)
5. **Task 8** title + chip responsive (top bar visible change)
6. **Task 9** PC max-w + cell max-h (PC visible change, no mobile impact)
7. **Task 10** mobile border removal + PRR migration (must ship together — PRR depends on scroll container shape)
8. **Task 11** top bar / 列 header回顶 wiring (last UX wiring)
9. **Task 12** all-up smoke test pass

---

### Task 1: Create scroll utilities (`lib/scroll.ts`)

**Files:**
- Create: `dashboard/src/lib/scroll.ts`

- [ ] **Step 1: Write the file**

Write `dashboard/src/lib/scroll.ts` with this exact content:

```ts
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const DEFAULT_DURATION = 300;
const NARROW_QUERY = "(max-width: 767px)";

function animate(
  getCur: () => number,
  setVal: (y: number) => void,
  target: number,
  duration: number,
): Promise<void> {
  const start = getCur();
  const dist = target - start;
  if (Math.abs(dist) < 0.5) return Promise.resolve();
  return new Promise((resolve) => {
    const t0 = performance.now();
    function step(now: number) {
      const t = Math.min(1, (now - t0) / duration);
      setVal(start + dist * easeOut(t));
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
}

export function smoothScrollToTop(
  el: HTMLElement | null,
  opts: { duration?: number } = {},
): Promise<void> {
  if (!el) return Promise.resolve();
  return animate(
    () => el.scrollTop,
    (y) => (el.scrollTop = y),
    0,
    opts.duration ?? DEFAULT_DURATION,
  );
}

export function smoothScrollWindowToTop(
  opts: { duration?: number } = {},
): Promise<void> {
  return animate(
    () => window.scrollY,
    (y) => window.scrollTo(0, y),
    0,
    opts.duration ?? DEFAULT_DURATION,
  );
}

// Breakpoint-aware: on mobile (single col, page-level scroll), scroll the page;
// on PC (multi-col, per-cell scroll), scroll the given feed body.
export function scrollFeedOrPage(
  feedBody: HTMLElement | null,
  opts: { duration?: number } = {},
): Promise<void> {
  const isNarrow =
    typeof window !== "undefined" &&
    window.matchMedia(NARROW_QUERY).matches;
  if (isNarrow || !feedBody) return smoothScrollWindowToTop(opts);
  return smoothScrollToTop(feedBody, opts);
}
```

- [ ] **Step 2: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built in <100ms`, no tsc errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/lib/scroll.ts
git commit -m "feat(scroll): add RAF-based smoothScrollToTop utility (300ms ease-out)"
```

---

### Task 2: Create useIsNarrow hook (`lib/breakpoint.ts`)

**Files:**
- Create: `dashboard/src/lib/breakpoint.ts`

- [ ] **Step 1: Write the file**

Write `dashboard/src/lib/breakpoint.ts` with this exact content:

```ts
import { useEffect, useState } from "react";

const NARROW_QUERY = "(max-width: 767px)";

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia(NARROW_QUERY).matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return narrow;
}
```

- [ ] **Step 2: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/lib/breakpoint.ts
git commit -m "feat(breakpoint): add useIsNarrow hook (md: 768px boundary)"
```

---

### Task 3: TweetCard 4-slot metric rendering (Q6)

**Files:**
- Modify: `dashboard/src/components/TweetCard.tsx:83-125` (MetricButton component)

- [ ] **Step 1: Replace MetricButton implementation**

Locate the current `MetricButton` function (lines 83-125). Replace its body with:

```tsx
function MetricButton({
  icon,
  label,
  count,
  hoverColor,
}: {
  icon: ReactNode;
  label: string;
  count: number | null | undefined;
  hoverColor: "sky" | "green" | "pink" | "neutral";
}) {
  const isMissing = count === undefined || count === null;
  const display = isMissing ? "—" : formatNumber(count);
  const colorClasses: Record<typeof hoverColor, string> = {
    sky: "group-hover/metric:bg-sky-50 group-hover/metric:text-sky-500",
    green: "group-hover/metric:bg-emerald-50 group-hover/metric:text-emerald-500",
    pink: "group-hover/metric:bg-pink-50 group-hover/metric:text-pink-500",
    neutral: "group-hover/metric:bg-neutral-100 group-hover/metric:text-neutral-700",
  };
  const textColor: Record<typeof hoverColor, string> = {
    sky: "group-hover/metric:text-sky-500",
    green: "group-hover/metric:text-emerald-500",
    pink: "group-hover/metric:text-pink-500",
    neutral: "group-hover/metric:text-neutral-700",
  };
  return (
    <span
      aria-label={label}
      className="group/metric flex items-center gap-1 text-neutral-500 transition-colors"
    >
      <span
        className={cn(
          "flex h-7 w-7 items-center justify-center rounded-full transition-colors",
          isMissing ? "text-neutral-300" : "",
          colorClasses[hoverColor],
        )}
      >
        {icon}
      </span>
      <span
        className={cn(
          "text-[12px] tabular-nums transition-colors",
          isMissing ? "text-neutral-300" : "",
          textColor[hoverColor],
        )}
      >
        {display}
      </span>
    </span>
  );
}
```

Key changes vs current:
- Removed `if (count === undefined || count === null) return null;` early return
- Added `isMissing` flag → renders "—" with `text-neutral-300` muted styling

- [ ] **Step 2: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no errors.

- [ ] **Step 3: Manual smoke test**

Start dev server:

```bash
cd dashboard && npm run dev
```

Open http://localhost:5173 in browser. Look at any tweet card. Expected:
- All 4 metric icons render (reply / retweet / heart / eye)
- Tweets with full data: numbers shown
- Tweets missing some metrics: missing slots show "—" in light gray
- Hover halos still work on all 4

Stop dev server (Ctrl-C).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/TweetCard.tsx
git commit -m "fix(card): always render 4 metric slots, missing → \"—\""
```

---

### Task 4: TweetCard pointer-down + click selection check (Q7)

**Files:**
- Modify: `dashboard/src/components/TweetCard.tsx:198-203` (handleCardClick), and `:222-229` (article element)

- [ ] **Step 1: Add pointer ref + replace click handler**

In `TweetCard.tsx`, find this block (around line 198-203):

```tsx
  const handleCardClick = (e: React.MouseEvent) => {
    if (embedded) return;
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a")) return;
    openTweet(item, siblings || []);
  };
```

Replace with:

```tsx
  const downPos = useRef<{ x: number; y: number } | null>(null);

  const handlePointerDown = (e: React.PointerEvent) => {
    downPos.current = { x: e.clientX, y: e.clientY };
  };

  const handleCardClick = (e: React.MouseEvent) => {
    if (embedded) return;
    const start = downPos.current;
    if (start) {
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > 5 || dy > 5) return; // drag → not a click
    }
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return; // text selected
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a")) return;
    openTweet(item, siblings || []);
  };
```

- [ ] **Step 2: Wire pointer-down to article element**

Find the `<article>` opener (around line 222):

```tsx
    <article
      onClick={handleCardClick}
      className={cn(
```

Replace with:

```tsx
    <article
      onPointerDown={handlePointerDown}
      onClick={handleCardClick}
      className={cn(
```

- [ ] **Step 3: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no errors. (`useRef` is already imported per existing imports at line 1.)

- [ ] **Step 4: Manual smoke test**

```bash
cd dashboard && npm run dev
```

Open http://localhost:5173. Test cases:

1. Click on empty card area (no text drag) → drawer opens ✓
2. Click and drag across tweet text to select → drawer does **not** open; selection persists in browser
3. Long-press text on mobile (DevTools device toggle) → system selection menu appears, drawer doesn't open
4. Click on the @username link → opens X profile (drawer doesn't open)
5. Click on a hashtag → no nav (just styled), drawer doesn't open

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/TweetCard.tsx
git commit -m "fix(card): distinguish text selection drag from click via pointerdown + getSelection"
```

---

### Task 5: Replace existing scroll-to-top with shared utility

**Files:**
- Modify: `dashboard/src/components/Feed.tsx:332` (showPending hot path) and `:342` (showPending non-hot path)

- [ ] **Step 1: Add scroll import**

At the top of `Feed.tsx` (after the existing `import type { ItemExtra } from "../types";` line ~18), add:

```ts
import { scrollFeedOrPage } from "../lib/scroll";
```

- [ ] **Step 2: Replace hot-path scroll**

In `Feed.tsx`, find this line (around line 332):

```tsx
          feedBodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
```

Replace with:

```tsx
          scrollFeedOrPage(feedBodyRef.current);
```

- [ ] **Step 3: Replace non-hot scroll**

Same file, find line ~342:

```tsx
    feedBodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
```

Replace with:

```tsx
    scrollFeedOrPage(feedBodyRef.current);
```

- [ ] **Step 4: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no errors.

- [ ] **Step 5: Manual smoke test**

```bash
cd dashboard && npm run dev
```

Open http://localhost:5173. Wait until polling shows "N 条新推文" banner (or trigger by editing localStorage; or skip this test for now and verify after later tasks). When banner appears, click it. Expected:
- Smooth回顶 in ~300ms (visibly snappier than before)
- Easing curve: starts immediate, decelerates at end (ease-out)

Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/Feed.tsx
git commit -m "feat(feed): unify scroll-to-top with shared 300ms ease-out utility"
```

---

### Task 6: Create SortSelector component

**Files:**
- Create: `dashboard/src/components/SortSelector.tsx`

- [ ] **Step 1: Write the file**

Write `dashboard/src/components/SortSelector.tsx` with this exact content:

```tsx
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
```

- [ ] **Step 2: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no errors.

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/SortSelector.tsx
git commit -m "feat(sort): add SortSelector — bottom sheet (mobile) + inline dropdown (PC)"
```

---

### Task 7: Wire SortSelector into Feed.tsx

**Files:**
- Modify: `dashboard/src/components/Feed.tsx:18-21` (imports), `:20` (SortMode type), `:411-456` (header sort buttons)

- [ ] **Step 1: Update imports + remove inline SortMode**

Near top of `Feed.tsx` (line ~18 after `import type { ItemExtra } from "../types";`), add:

```ts
import { SortSelector, type SortMode } from "./SortSelector";
import { useIsNarrow } from "../lib/breakpoint";
```

Then remove the inline `type SortMode = "time" | "hot";` line (current line 20).

- [ ] **Step 2: Add `isNarrow` inside Feed component**

In the `Feed` function body, near the existing `const isHot = sortMode === "hot";` line (~111), add:

```tsx
  const isNarrow = useIsNarrow();
```

(Place immediately above `isHot` declaration.)

- [ ] **Step 3: Replace header sort buttons with SortSelector**

In `Feed.tsx`, find this block (lines 422-455 — the entire `<div className="flex shrink-0 items-center gap-2">` containing the inline 热门/时间 buttons):

```tsx
        <div className="flex shrink-0 items-center gap-2">
          {!placeholder && (
            <div className="inline-flex items-center gap-1.5 text-[11px]">
              <button
                type="button"
                onClick={() => setSortMode("hot")}
                className={cn(
                  "transition-colors",
                  sortMode === "hot"
                    ? "font-semibold text-neutral-900"
                    : "text-neutral-400 hover:text-neutral-700",
                )}
              >
                热门
              </button>
              <span className="text-neutral-300">·</span>
              <button
                type="button"
                onClick={() => setSortMode("time")}
                className={cn(
                  "transition-colors",
                  sortMode === "time"
                    ? "font-semibold text-neutral-900"
                    : "text-neutral-400 hover:text-neutral-700",
                )}
              >
                时间
              </button>
            </div>
          )}
          <div className="text-[11px] text-neutral-500">
            {placeholder ? "规划中" : ""}
          </div>
        </div>
```

Replace with:

```tsx
        <div className="flex shrink-0 items-center gap-2">
          {!placeholder && (
            <SortSelector
              value={sortMode}
              onChange={setSortMode}
              isNarrow={isNarrow}
            />
          )}
          <div className="text-[11px] text-neutral-500">
            {placeholder ? "规划中" : ""}
          </div>
        </div>
```

- [ ] **Step 4: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no errors.

- [ ] **Step 5: Manual smoke test**

```bash
cd dashboard && npm run dev
```

Open http://localhost:5173:

1. **PC**: each Feed column header has「热度 ▾」at right. Click → small inline dropdown shows 热度 ✓ / 时间. Click other place on page → dropdown closes. Click 时间 → switches to time sort + dropdown closes.
2. **Mobile** (DevTools toggle to mobile width <768px): in each Feed header, 「热度 ▾」shows. Click → bottom sheet slides up with title「排序方式」+ 热度 ✓ / 时间 / 取消. Tap 时间 → switches sort, sheet dismisses. Tap backdrop or 取消 → sheet dismisses without change.

Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/Feed.tsx
git commit -m "feat(feed): replace inline sort toggle with SortSelector component"
```

---

### Task 8: Title rename + chips响应式 (Q1.3 + Q1.1 + Q2)

**Files:**
- Modify: `dashboard/src/App.tsx:25-35` (FILTER_CHIPS), `:37-67` (App body / state), `:73-117` (header), `:120-134` (main grid)

- [ ] **Step 1: Update title + add useIsNarrow + responsive chip filtering**

In `App.tsx`, near top, after the existing `import { cn, timeAgo } from "./lib/utils";` line (~7), add:

```ts
import { useIsNarrow } from "./lib/breakpoint";
import { scrollFeedOrPage } from "./lib/scroll";
```

In the `App` function (line ~37), after `const [refreshTick, setRefreshTick] = useState(0);` (line 41), add:

```tsx
  const isNarrow = useIsNarrow();
```

After the existing `useEffect` (line 46), add a separate effect to coerce `filter` when crossing breakpoint:

```tsx
  // When narrow, "all" is invalid — drop to x_list
  useEffect(() => {
    if (isNarrow && filter === "all") setFilter("x_list");
  }, [isNarrow, filter]);
```

Also change `FilterKey` initial state default to be sensible regardless of breakpoint. Find line 40:

```tsx
  const [filter, setFilter] = useState<FilterKey>("all");
```

Replace with:

```tsx
  const [filter, setFilter] = useState<FilterKey>(() =>
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 767px)").matches
      ? "x_list"
      : "all",
  );
```

- [ ] **Step 2: Update title**

In `App.tsx` find lines 75-82 (the `<div className="flex items-baseline gap-3">` block):

```tsx
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-bold tracking-tight text-neutral-900 sm:text-xl">
              xList
            </h1>
            <span className="hidden text-xs text-neutral-500 sm:inline">
              AI 信息聚合看板
            </span>
          </div>
```

Replace with:

```tsx
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-bold tracking-tight text-neutral-900 sm:text-xl">
              AI-Feeds
            </h1>
            {/* Subtitle slogan TBD; intentionally empty for now */}
          </div>
```

- [ ] **Step 3: Filter chips responsive — exclude "all" on narrow + tap-active回顶**

In `App.tsx` find the chip-rendering block (lines 84-106):

```tsx
          <nav className="chips-rail flex min-w-0 items-center gap-1 overflow-x-auto">
            {FILTER_CHIPS.map(({ key, label }) => {
              const isActive = filter === key;
              const hasData = key === "all" || liveSourceTypes.has(key as SourceType);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setFilter(key)}
                  className={cn(
                    "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-neutral-900 text-white"
                      : "text-neutral-600 hover:bg-neutral-100",
                    !hasData && !isActive && "opacity-40",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </nav>
```

Replace with:

```tsx
          {isNarrow && (
            <nav className="chips-rail flex min-w-0 items-center gap-1 overflow-x-auto">
              {FILTER_CHIPS.filter((c) => c.key !== "all").map(({ key, label }) => {
                const isActive = filter === key;
                const hasData = liveSourceTypes.has(key as SourceType);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      if (isActive) {
                        // Tap active chip → scroll current Feed to top
                        scrollFeedOrPage(null);
                      } else {
                        setFilter(key);
                      }
                    }}
                    className={cn(
                      "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                      isActive
                        ? "bg-neutral-900 text-white"
                        : "text-neutral-600 hover:bg-neutral-100",
                      !hasData && !isActive && "opacity-40",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </nav>
          )}
```

- [ ] **Step 4: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no errors.

- [ ] **Step 5: Manual smoke test**

```bash
cd dashboard && npm run dev
```

Open http://localhost:5173:

1. **PC** (≥768px): Title shows「AI-Feeds」. No chips (entire nav hidden). All 6 columns visible.
2. **Mobile** (<768px, DevTools toggle): Chips visible without「全部」(only X / YouTube / GitHub / Podcast / PH / arXiv). Default active = X. Single-column layout (existing `grid-cols-1`).
3. **Resize from PC to mobile** (drag DevTools narrower): chips appear, filter coerces to X.
4. **Resize back to PC**: chips disappear, all columns visible again.
5. **Tap active X chip on mobile**: doesn't switch filter, but scrolls page to top. Scroll down first to verify (long Feed needed).

Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/App.tsx
git commit -m "feat(app): rename xList→AI-Feeds; responsive chips (hide on PC, drop \"all\" on mobile, active-tap回顶)"
```

---

### Task 9: PC layout — max-w + cell max-h

**Files:**
- Modify: `dashboard/src/App.tsx:120` (main container), `dashboard/src/components/Feed.tsx:410` (Feed wrapper)

- [ ] **Step 1: Reduce max-width and increase side padding (PC)**

In `App.tsx` find line 120:

```tsx
      <main className="mx-auto max-w-[1400px] px-3 py-3 sm:px-6 sm:py-6">
```

Replace with:

```tsx
      <main className="mx-auto max-w-[1280px] px-3 py-3 sm:px-8 sm:py-6 lg:px-16">
```

Also update the same `max-w-[1400px]` on the header inner div (line 74):

```tsx
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-2 px-3 py-2 sm:gap-4 sm:px-6 sm:py-3">
```

Replace with:

```tsx
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-2 px-3 py-2 sm:gap-4 sm:px-8 sm:py-3 lg:px-16">
```

- [ ] **Step 2: Cell max-height on PC**

In `Feed.tsx` find line 410 (the outer Feed wrapper):

```tsx
    <div className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
```

Replace with:

```tsx
    <div className="flex flex-col overflow-hidden bg-white md:max-h-[70vh] md:rounded-lg md:border md:border-neutral-200 md:shadow-sm">
```

This:
- Removes border/rounded/shadow on mobile (under md)
- Adds `md:max-h-[70vh]` for PC cell scroll constraint
- Mobile keeps `flex flex-col bg-white` (no border, no max-h)

- [ ] **Step 3: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no errors.

- [ ] **Step 4: Manual smoke test**

```bash
cd dashboard && npm run dev
```

Open http://localhost:5173:

1. **PC**: layout has visible left/right empty gutters (≈64px each side at lg). Each Feed cell is ~70vh tall, scrolls internally when content overflows. Mouse wheel inside cell → scrolls cell. Mouse wheel in gutter → scrolls page (currently no rows below, but no error).
2. **Mobile** (<768px): Feed cells have no border, no rounded corners, no shadow. Cell content edge-to-edge with page padding. (Pull-to-refresh might be broken at this stage — that's Task 10.)

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/App.tsx dashboard/src/components/Feed.tsx
git commit -m "feat(layout): PC max-w 1280 + lg:px-16 gutters; cell md:max-h-[70vh]; mobile no border"
```

---

### Task 10: Mobile feed-body overflow + pull-to-refresh listener migration

**Files:**
- Modify: `dashboard/src/components/Feed.tsx:206-262` (PRR effect), `:474-477` (feed-body div)

This task **must ship together** because mobile cell `overflow-y-visible` and PRR listener target are interdependent.

- [ ] **Step 1: Update feed-body overflow class**

In `Feed.tsx` find the feed-body element (line 474-477):

```tsx
      <div
        ref={feedBodyRef}
        className="flex-1 overflow-y-auto feed-body"
        style={{ overscrollBehavior: "contain", touchAction: "pan-y" }}
      >
```

Replace with:

```tsx
      <div
        ref={feedBodyRef}
        className="feed-body md:flex-1 md:overflow-y-auto"
        style={{ overscrollBehavior: "contain", touchAction: "pan-y" }}
      >
```

This makes mobile `feed-body` use natural document flow (no internal scroll); PC still has bounded scroll.

- [ ] **Step 2: Migrate PRR listener to window**

In `Feed.tsx` find the existing PRR `useEffect` block (lines 206-262):

```tsx
  useEffect(() => {
    if (placeholder) return;
    const el = feedBodyRef.current;
    if (!el) return;

    const onStart = (e: TouchEvent) => {
      if (el.scrollTop <= 0) {
        pullStartY.current = e.touches[0].clientY;
        isDraggingRef.current = false;
      } else {
        pullStartY.current = null;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pullStartY.current === null) return;
      if (el.scrollTop > 0) {
        pullStartY.current = null;
        pullYRef.current = 0;
        isDraggingRef.current = false;
        setPullY(0);
        return;
      }
      const dy = e.touches[0].clientY - pullStartY.current;
      if (dy > 0) {
        if (e.cancelable) e.preventDefault();
        isDraggingRef.current = true;
        const next = Math.min(dy / PULL_RESISTANCE, PULL_MAX);
        pullYRef.current = next;
        setPullY(next);
      }
    };
    const onEnd = () => {
      const shouldRefresh =
        pullStartY.current !== null &&
        pullYRef.current > PULL_THRESHOLD &&
        !loadingRef.current;
      if (shouldRefresh) {
        setIsRefreshingPull(true);
        setRetryTick((t) => t + 1);
      }
      pullYRef.current = 0;
      isDraggingRef.current = false;
      setPullY(0);
      pullStartY.current = null;
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, [placeholder]);
```

Replace with:

```tsx
  useEffect(() => {
    if (placeholder) return;
    // Only activate PRR on mobile — PC uses bounded cell scroll, no pull gesture
    if (!window.matchMedia("(max-width: 767px)").matches) return;

    const isAtTop = () => window.scrollY <= 0;

    const onStart = (e: TouchEvent) => {
      if (isAtTop()) {
        pullStartY.current = e.touches[0].clientY;
        isDraggingRef.current = false;
      } else {
        pullStartY.current = null;
      }
    };
    const onMove = (e: TouchEvent) => {
      if (pullStartY.current === null) return;
      if (!isAtTop()) {
        pullStartY.current = null;
        pullYRef.current = 0;
        isDraggingRef.current = false;
        setPullY(0);
        return;
      }
      const dy = e.touches[0].clientY - pullStartY.current;
      if (dy > 0) {
        if (e.cancelable) e.preventDefault();
        isDraggingRef.current = true;
        const next = Math.min(dy / PULL_RESISTANCE, PULL_MAX);
        pullYRef.current = next;
        setPullY(next);
      }
    };
    const onEnd = () => {
      const shouldRefresh =
        pullStartY.current !== null &&
        pullYRef.current > PULL_THRESHOLD &&
        !loadingRef.current;
      if (shouldRefresh) {
        setIsRefreshingPull(true);
        setRetryTick((t) => t + 1);
      }
      pullYRef.current = 0;
      isDraggingRef.current = false;
      setPullY(0);
      pullStartY.current = null;
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: false });
    window.addEventListener("touchend", onEnd);
    window.addEventListener("touchcancel", onEnd);
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [placeholder]);
```

Key changes:
- Listener target `el` (feedBodyRef) → `window`
- `el.scrollTop <= 0` → `window.scrollY <= 0` (via `isAtTop()`)
- Early return on PC (`!matchMedia("(max-width: 767px)")`)
- Removed local `el` ref binding

- [ ] **Step 3: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no errors.

- [ ] **Step 4: Manual smoke test (mobile only)**

```bash
cd dashboard && npm run dev
```

Open http://localhost:5173, switch DevTools to mobile width + touch emulation. Test:

1. Page is at top: pull down (touch + drag down) → "下拉刷新" → "松手刷新" indicator → release → "正在刷新" spinner → fresh fetch
2. Scroll page down a bit → pull down → indicator does **not** appear (PRR correctly disabled when not at page top)
3. Wait for auto-poll to detect new tweet → "N 条新推文" banner appears → tap → scrolls to top with 300ms ease-out
4. PC mode: pull-down does nothing (correctly inactive)

Stop dev server.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/Feed.tsx
git commit -m "feat(feed): mobile feed-body overflow visible; migrate PRR listener to window"
```

---

### Task 11: Top bar smart两段回顶 + 列 header回顶 (Q5)

**Files:**
- Modify: `dashboard/src/App.tsx:73-117` (header element + feedRefs lift), `dashboard/src/components/Feed.tsx:412-456` (header tap handler)

This task adds回顶 hit-zones. Feed needs to expose its `feedBodyRef` to App; we'll use `useImperativeHandle` via `forwardRef`.

- [ ] **Step 1: Add forwardRef wrapper to Feed**

In `Feed.tsx` near top:

Find:
```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
```

Replace with:
```tsx
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
```

Then change the `Feed` declaration. Find line ~91:

```tsx
export function Feed({ sourceType, title, placeholder, refreshTick }: Props) {
```

Replace with:

```tsx
export interface FeedHandle {
  scrollToTop: () => void;
}

export const Feed = forwardRef<FeedHandle, Props>(function Feed(
  { sourceType, title, placeholder, refreshTick },
  ref,
) {
```

At the very end of the component body (before the closing `}`), but inside the function — add:

Find the existing return statement (line 409):

```tsx
  return (
    <div className="flex flex-col overflow-hidden ...
```

Just **before** `return (`, insert:

```tsx
  useImperativeHandle(ref, () => ({
    scrollToTop: () => smoothScrollToTop(feedBodyRef.current),
  }));

```

Then at the very end of the file (after the JSX `return (...)`), add the closing `);` for the `forwardRef` call. Currently the file ends with:

```tsx
    </div>
  );
}
```

Change to:

```tsx
    </div>
  );
});
```

(Note: the `}` becomes `});` to close the forwardRef.)

Also update `Props` to allow undefined `refreshTick` is unchanged. Add the `smoothScrollToTop` import — find the existing scroll import line you added in Task 5:

```ts
import { scrollFeedOrPage } from "../lib/scroll";
```

Replace with:

```ts
import { scrollFeedOrPage, smoothScrollToTop, smoothScrollWindowToTop } from "../lib/scroll";
```

- [ ] **Step 2: Add header tap handler in Feed**

In `Feed.tsx` find the `<header>` opener (around line 412):

```tsx
      <header className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
```

Replace with:

```tsx
      <header
        className="flex items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2 md:cursor-pointer"
        onClick={(e) => {
          // Mobile: chip rail handles回顶 via active-tap; skip header tap
          if (window.matchMedia("(max-width: 767px)").matches) return;
          // Skip when click bubbled from a button (sort selector, refresh)
          if ((e.target as HTMLElement).closest("button")) return;
          smoothScrollToTop(feedBodyRef.current);
        }}
      >
```

- [ ] **Step 3: Lift feedRefs in App + add top bar smart handler**

In `App.tsx`, after the existing `import { scrollFeedOrPage } from "./lib/scroll";` (added in Task 8), update to also import what we need:

Replace:

```ts
import { scrollFeedOrPage } from "./lib/scroll";
```

with:

```ts
import { scrollFeedOrPage, smoothScrollToTop, smoothScrollWindowToTop } from "./lib/scroll";
```

Also update the Feed import to grab `FeedHandle`:

```ts
import { Feed } from "./components/Feed";
```

Replace with:

```ts
import { Feed, type FeedHandle } from "./components/Feed";
```

Add `useRef` to React imports if not present. Find line 1:

```tsx
import { useEffect, useState } from "react";
```

Replace with:

```tsx
import { useEffect, useRef, useState } from "react";
```

In the App body, after `const isNarrow = useIsNarrow();` (added in Task 8), add:

```tsx
  const feedRefs = useRef<Map<string, FeedHandle | null>>(new Map());
```

Define top-bar click handler before the `return`:

```tsx
  async function onTopBarClick() {
    if (isNarrow) {
      return smoothScrollWindowToTop();
    }
    const pageAtTop = window.scrollY <= 1;
    if (!pageAtTop) {
      return smoothScrollWindowToTop();
    }
    // Already at page top → scroll all PC columns to top
    feedRefs.current.forEach((handle) => handle?.scrollToTop());
  }
```

- [ ] **Step 4: Wire top bar click + Feed refs**

In `App.tsx` find the `<header>` element opener (line 73):

```tsx
      <header className="sticky top-0 z-10 border-b border-neutral-200 bg-white/80 backdrop-blur">
```

Replace with:

```tsx
      <header
        className="sticky top-0 z-10 cursor-pointer border-b border-neutral-200 bg-white/80 backdrop-blur"
        onClick={(e) => {
          // Skip when click is on chips, refresh button, etc.
          if ((e.target as HTMLElement).closest("button")) return;
          if ((e.target as HTMLElement).closest("nav")) return;
          onTopBarClick();
        }}
      >
```

Then in the `Feed` rendering (around line 124):

```tsx
              <Feed
                key={col.source_type}
                sourceType={col.source_type}
                title={getTitleForColumn(col)}
                placeholder={isPlaceholder}
                refreshTick={refreshTick}
              />
```

Replace with:

```tsx
              <Feed
                key={col.source_type}
                ref={(h) => {
                  if (h) feedRefs.current.set(col.source_type, h);
                  else feedRefs.current.delete(col.source_type);
                }}
                sourceType={col.source_type}
                title={getTitleForColumn(col)}
                placeholder={isPlaceholder}
                refreshTick={refreshTick}
              />
```

- [ ] **Step 5: Verify build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no errors.

- [ ] **Step 6: Manual smoke test**

```bash
cd dashboard && npm run dev
```

Open http://localhost:5173. Tests:

**PC (≥768px):**
1. Scroll a single column down (mouse wheel inside it) → click that column's header → that column scrolls to top with 300ms ease-out (sibling columns unchanged)
2. Scroll page down (mouse wheel in left/right gutter — currently no rows beyond the first, so this may be no-op; alternatively use keyboard PageDown after focusing page body) → click top bar (anywhere on AI-Feeds bar) → page scrolls to top with 300ms ease-out
3. With page already at top → click top bar again → all 3 visible columns scroll to top simultaneously (single 300ms animation each)
4. Click on chip rail in top bar → no回顶 happens (currently no nav present on PC — n/a but the guard is there)
5. Click sort selector「热度 ▾」inside column header → only sort dropdown opens, column does not scroll (stopPropagation working)

**Mobile (<768px):**
1. Scroll page down → tap top bar → page scrolls to top
2. Tap active chip → page scrolls to top (Task 8 functionality preserved)
3. Tap column header → no scroll happens (header tap is PC-only)

Stop dev server.

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/App.tsx dashboard/src/components/Feed.tsx
git commit -m "feat(scroll): top bar smart 2-stage回顶 (page→cells); column header回顶 PC only"
```

---

### Task 12: All-up smoke + final cleanup

**Files:** None (verification only)

- [ ] **Step 1: Final build**

```bash
cd dashboard && npm run build
```

Expected: `✓ built`, no warnings, no errors.

- [ ] **Step 2: Final lint**

```bash
cd dashboard && npm run lint
```

Expected: 0 errors. Warnings on unrelated files OK; new files (lib/, SortSelector) should have 0 warnings.

- [ ] **Step 3: All-up manual verification (per spec section 7)**

```bash
cd dashboard && npm run dev
```

Run through each row of spec section 7「验证」table:

- [ ] Q1: DevTools resize窗口跨 768px → chips appear/disappear correctly
- [ ] Q2: 移动端 → 点 X chip 到顶；滚下后再点 X chip → 平滑回顶
- [ ] Q3 移动: 点「热度 ▾」→ bottom sheet；蒙层 / 取消 / 选项都正确关闭
- [ ] Q3 PC: 点列「热度 ▾」→ 内联下拉；外点关闭；选项立即切换排序
- [ ] Q4: 点「N 条新推文」回顶约 300ms（Performance panel可测）
- [ ] Q5 PC: 三列 + 大留白；wheel 在列内滚列 / 在列外滚 page；top bar两段回顶；列 header 单列回顶
- [ ] Q5 移动: 点 top bar = page 回顶；点 active chip = page 回顶；列 header 不响应
- [ ] Q6: 找 1 条 metric 不全的 tweet（用 DevTools Network 看 metrics JSON null 字段）→ 4 个槽位都渲染，缺的显示「—」
- [ ] Q7: PC 拖拽选文 → 复制 OK，drawer 不弹；单击空白 → drawer 弹；移动端长按 → 系统菜单出现，drawer 不弹

- [ ] **Step 4: Smoke summary commit (no code changes — empty commit allowed if all green)**

If everything passes, no commit needed. If you found small fixes during smoke, commit them with descriptive messages.

- [ ] **Step 5: Push branch + report status**

```bash
git push -u origin feat/responsive-iteration
```

(If no remote configured, skip and report local branch only.)

Report final state:
- Branch: `feat/responsive-iteration`
- Commits added: 11 (Tasks 1-11)
- Build: passing
- All 7 Qs verified manually
- Ready for: PR review → merge to main → deploy

---

## Open Questions / Future Work

- **Slogan 副标题**: still empty (`AI-Feeds` standalone). Per spec section 8 out of scope.
- **Metrics 后端覆盖率**: tracked in `TODO.md` (line 14 area) — out of scope for this PR.
- **微信 UA 检测**: future分享功能再处理 — out of scope.

---

## Risk Mitigation Notes

- **Task 10 is the most regression-prone**: PRR listener migration touches mobile-only behavior. If PRR breaks after Task 10, revert that single commit, debug isolation, then retry. Don't proceed to Task 11 until PRR works on mobile.
- **Task 11 forwardRef change** could break HMR in dev. If you see "Component has no proper key" warnings in dev console, restart `npm run dev`.
- **Cell `md:max-h-[70vh]` in Task 9** depends on viewport being tall enough for the value to mean anything. On <600px-tall PC viewports the cell may feel cramped — that's by design (consistency over edge-case ergonomics).
