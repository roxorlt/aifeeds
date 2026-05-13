// 活动行专属列头筛选器：城市 popover + 时段 select + 形式 select
// 跟 ClawhubColumnHeader 共用视觉规范（22px 高度、SELECT_CLASS / WRAPPER_CLASS 同款），
// 行为按 worker/src/index.ts handleHuodongxingFeed 的 query param 协议：
//   - ?city=<city>   24 城市之一（HUODONGXING_CITIES）
//   - ?when=this|weekend|month
//   - ?form=online|offline
// 空字符串 = 不传 = 不过滤
//
// 城市列表与 worker/src/scrapers/huodongxing/cities.ts 保持一致；改这边时也要改那边。

import { useEffect, useMemo, useRef, useState } from "react";

export type HdxCity = string; // 24 城市之一，空字符串 = 全部
export type HdxWhen = "" | "this" | "weekend" | "month";
export type HdxForm = "" | "online" | "offline";

// source-of-truth: worker/src/scrapers/huodongxing/cities.ts
const PRIMARY_CITIES = ["北京", "上海", "广州", "深圳", "杭州", "成都"] as const;
const SECONDARY_CITIES = [
  "长沙", "南京", "重庆", "苏州", "西安", "郑州",
  "厦门", "天津", "宁波", "青岛", "东莞", "佛山",
  "济南", "珠海", "合肥", "福州", "石家庄", "昆明",
] as const;

const WHEN_OPTIONS: { value: HdxWhen; label: string }[] = [
  { value: "", label: "全部时段" },
  { value: "this", label: "本周" },
  { value: "weekend", label: "本周末" },
  { value: "month", label: "30 天内" },
];

const FORM_OPTIONS: { value: HdxForm; label: string }[] = [
  { value: "", label: "全部形式" },
  { value: "offline", label: "线下" },
  { value: "online", label: "线上" },
];

interface Props {
  city: HdxCity;
  when: HdxWhen;
  form: HdxForm;
  onCityChange: (c: HdxCity) => void;
  onWhenChange: (w: HdxWhen) => void;
  onFormChange: (f: HdxForm) => void;
}

// 跟 ClawhubColumnHeader 完全同款（行高对齐、视觉一致）
const SELECT_CLASS =
  "h-full appearance-none rounded border border-neutral-300 bg-white pl-1.5 pr-4 box-border text-[10.5px] leading-none text-neutral-700 cursor-pointer hover:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300";
const CHEVRON_CLASS =
  "absolute right-1 top-1/2 -translate-y-1/2 w-2.5 h-2.5 text-neutral-400 pointer-events-none";
const WRAPPER_CLASS = "relative inline-flex h-[22px] items-center";

// 城市 button：与 select 视觉一致；选中态时加深背景
const CITY_BTN_BASE =
  "h-full inline-flex items-center rounded border box-border pl-1.5 pr-4 text-[10.5px] leading-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-neutral-300 relative";
const CITY_BTN_IDLE =
  "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400";
const CITY_BTN_ACTIVE =
  "border-neutral-700 bg-neutral-900 text-white hover:bg-neutral-800";

// popover 内 chip
const CHIP_BASE =
  "inline-flex items-center justify-center rounded-full border px-2 py-[3px] text-[11px] leading-none cursor-pointer transition-colors whitespace-nowrap";
const CHIP_IDLE =
  "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-50";
const CHIP_ACTIVE =
  "border-neutral-900 bg-neutral-900 text-white hover:bg-neutral-800";

export function HuodongxingColumnHeader({
  city,
  when,
  form,
  onCityChange,
  onWhenChange,
  onFormChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  // 选中次级城市时，自动把 "更多" 区展开（否则用户看不到当前选中态）
  const isSecondary = useMemo(
    () => SECONDARY_CITIES.includes(city as (typeof SECONDARY_CITIES)[number]),
    [city],
  );
  useEffect(() => {
    if (isSecondary) setShowMore(true);
  }, [isSecondary, open]);

  // outside click / Esc 关 popover
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const cityLabel = city || "全部城市";
  const cityActive = !!city;

  return (
    // root container 自身 relative，让 popover 锚到整组控件而不是按钮 wrapper —
    // 否则 24-城 popover 会顺着按钮位置向右溢出 column 边界
    <div className="relative flex items-center gap-1" ref={popRef}>
      {/* 城市 — button + popover */}
      <div className={WRAPPER_CLASS}>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          className={`${CITY_BTN_BASE} ${cityActive ? CITY_BTN_ACTIVE : CITY_BTN_IDLE}`}
          title="城市筛选"
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <span className="max-w-[5em] truncate">{cityLabel}</span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={CHEVRON_CLASS}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      </div>

      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          // right-0 锚到根容器右边（= column header 右 padding），向左展开
          // max-w 兜底，避免列宽极窄时（移动端单列）继续溢出
          className="absolute right-0 top-full z-40 mt-1 w-max max-w-[min(20rem,calc(100vw-1.5rem))] rounded-lg border border-neutral-200 bg-white p-2 shadow-lg"
          role="dialog"
          aria-label="选择城市"
        >
            {/* 全部 / 主城 6 chip */}
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onCityChange("");
                  setOpen(false);
                }}
                className={`${CHIP_BASE} ${!city ? CHIP_ACTIVE : CHIP_IDLE}`}
              >
                全部
              </button>
              {PRIMARY_CITIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    onCityChange(c);
                    setOpen(false);
                  }}
                  className={`${CHIP_BASE} ${city === c ? CHIP_ACTIVE : CHIP_IDLE}`}
                >
                  {c}
                </button>
              ))}
            </div>

            {/* 更多 18 城（折叠） */}
            <div className="mt-2 border-t border-neutral-100 pt-2">
              {!showMore ? (
                <button
                  type="button"
                  onClick={() => setShowMore(true)}
                  className="text-[11px] text-neutral-500 hover:text-neutral-700"
                >
                  更多 18 城 ↓
                </button>
              ) : (
                <div className="flex flex-wrap items-center gap-1">
                  {SECONDARY_CITIES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        onCityChange(c);
                        setOpen(false);
                      }}
                      className={`${CHIP_BASE} ${city === c ? CHIP_ACTIVE : CHIP_IDLE}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

      {/* 时段 */}
      <div className={WRAPPER_CLASS}>
        <select
          value={when}
          onChange={(e) => {
            e.stopPropagation();
            onWhenChange(e.target.value as HdxWhen);
          }}
          onClick={(e) => e.stopPropagation()}
          className={SELECT_CLASS}
          title="时段"
        >
          {WHEN_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={CHEVRON_CLASS}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* 形式 */}
      <div className={WRAPPER_CLASS}>
        <select
          value={form}
          onChange={(e) => {
            e.stopPropagation();
            onFormChange(e.target.value as HdxForm);
          }}
          onClick={(e) => e.stopPropagation()}
          className={SELECT_CLASS}
          title="形式"
        >
          {FORM_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={CHEVRON_CLASS}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
    </div>
  );
}
