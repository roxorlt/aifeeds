// GH 语言色块（GitHub 各语言主题色，用于 lang 标签前的小圆点）。
// 抽出来便于 GithubCard / GithubDrawerBody 共用，避免 langDot 重复实现走偏。

const COLORS: Record<string, string> = {
  Python: "bg-blue-400",
  JavaScript: "bg-yellow-300",
  TypeScript: "bg-sky-500",
  Go: "bg-cyan-400",
  Rust: "bg-orange-500",
  C: "bg-neutral-400",
  "C++": "bg-pink-400",
  Java: "bg-red-500",
  Ruby: "bg-red-600",
  Shell: "bg-green-500",
  Swift: "bg-orange-400",
  Kotlin: "bg-purple-500",
  HTML: "bg-orange-300",
  CSS: "bg-blue-300",
  Vue: "bg-emerald-400",
};

export function langDotClass(lang: string | null | undefined): string {
  if (!lang) return "bg-neutral-300";
  return COLORS[lang] || "bg-neutral-300";
}
