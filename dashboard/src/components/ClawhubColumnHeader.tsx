// ClawHub 专属列头筛选器（替代全局 SortSelector 的「热度|时间」toggle）
// Per design doc § 5.2 + mockup：3 控件水平一行 — 排序 select / 分类 select / 隐藏可疑 toggle
// 隐藏可疑：worker 端默认已经过滤（phase 1 fetch 时 `nonSuspiciousOnly=true`），
// 所以这个 toggle 是 read-only 提示，不实际改 API 请求

export type ClawhubSort = "stars" | "downloads" | "installs" | "updated" | "name";
export type ClawhubCategory =
  | "all"
  | "mcp-tools"
  | "prompts"
  | "workflows"
  | "dev-tools"
  | "data"
  | "security"
  | "automation"
  | "other";

const SORT_OPTIONS: { value: ClawhubSort; label: string }[] = [
  { value: "stars", label: "星标数" },
  { value: "downloads", label: "下载量" },
  { value: "installs", label: "安装量" },
  { value: "updated", label: "最近更新" },
  { value: "name", label: "名称 A-Z" },
];

const CATEGORY_OPTIONS: { value: ClawhubCategory; label: string }[] = [
  { value: "all", label: "全部分类" },
  { value: "mcp-tools", label: "MCP 工具" },
  { value: "prompts", label: "Prompts" },
  { value: "workflows", label: "Workflows" },
  { value: "dev-tools", label: "Dev 工具" },
  { value: "data", label: "数据 & API" },
  { value: "security", label: "安全" },
  { value: "automation", label: "自动化" },
  { value: "other", label: "其他" },
];

interface Props {
  sort: ClawhubSort;
  category: ClawhubCategory;
  onSortChange: (s: ClawhubSort) => void;
  onCategoryChange: (c: ClawhubCategory) => void;
}

export function ClawhubColumnHeader({ sort, category, onSortChange, onCategoryChange }: Props) {
  return (
    <div className="flex items-center gap-1.5">
      {/* 排序 */}
      <div className="relative">
        <select
          value={sort}
          onChange={(e) => {
            e.stopPropagation();
            onSortChange(e.target.value as ClawhubSort);
          }}
          onClick={(e) => e.stopPropagation()}
          className="appearance-none rounded-md border border-neutral-300 bg-white pl-2 pr-6 py-1 text-[11px] text-neutral-700 cursor-pointer hover:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300"
          title="排序"
        >
          {SORT_OPTIONS.map((opt) => (
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
          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-neutral-400 pointer-events-none"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* 分类 */}
      <div className="relative">
        <select
          value={category}
          onChange={(e) => {
            e.stopPropagation();
            onCategoryChange(e.target.value as ClawhubCategory);
          }}
          onClick={(e) => e.stopPropagation()}
          className="appearance-none rounded-md border border-neutral-300 bg-white pl-2 pr-6 py-1 text-[11px] text-neutral-700 cursor-pointer hover:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-300"
          title="分类"
        >
          {CATEGORY_OPTIONS.map((opt) => (
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
          className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-neutral-400 pointer-events-none"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* 隐藏可疑（read-only 提示，worker 端已默认过滤） */}
      <span
        className="inline-flex items-center gap-1 text-[10px] text-neutral-500 px-1.5 py-1 rounded-md bg-neutral-50 border border-neutral-200 select-none"
        title="ClawHub 安全扫描标记为可疑的 skill 不显示（默认开启）"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3 h-3 text-neutral-500"
        >
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        </svg>
        已隐藏可疑
      </span>
    </div>
  );
}
