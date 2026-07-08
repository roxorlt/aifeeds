/* eslint-disable react-refresh/only-export-components */
// 搜索命中高亮：Context 注入方案。
//
// 设计要点（feed 零影响是硬约束）：
// - ItemCard 是 feed 与搜索共用组件。feed 不包 HighlightProvider → context
//   默认 `[]` → `<HL>` / highlightNodes 直接返回原始 string，DOM 与改前完全一致。
// - 只有搜索结果页（SearchGroups / SearchSourceList）用 <HighlightProvider>
//   包裹结果卡片区域，terms 非空时才做高亮。
// - 高亮样式 `text-rose-600 font-medium`（rose 常规仅错误态，此处破例作搜索命中，
//   见 docs/frontend-ux-guidelines.md）。bg-transparent 消除 <mark> 默认黄底。
// - 纯 string 操作 + React 元素（不用 dangerouslySetInnerHTML）→ 天然防 XSS。
//
// 本文件同时导出组件（HighlightProvider / HL）与纯函数（extractHighlightTerms /
// highlightNodes / useHighlightTerms），react-refresh/only-export-components 会
// 报错，故文件级 disable —— 这些 API 语义上同属「高亮」一族，放一起可读性 > 拆分。

import { createContext, useContext, type ReactNode } from "react";

// ── 高亮词提取 ────────────────────────────────────────────────────────────
// 从原始 query（不是 bigram）提取展示用高亮词：
// - NFKC 归一 + 转小写
// - 拉丁/数字连续段 [a-z0-9]+（长度 ≥ 2）
// - CJK 连续段整段保留（长度 ≥ 1，如「大模型」整段一个词，避免逐字乱标）
// - 去重；按长度降序（长词先匹配，防短词先占位）；上限 12 个
const LATIN_RUN = /[a-z0-9]+/g;
// CJK 统一表意 + 扩展 A + 日文平/片假名（与卡片正文可能出现的 CJK 覆盖一致）
const CJK_RUN = /[一-鿿㐀-䶿぀-ヿ]+/g;

export function extractHighlightTerms(q: string): string[] {
  if (!q) return [];
  const norm = q.normalize("NFKC").toLowerCase();
  const terms: string[] = [];
  for (const w of norm.match(LATIN_RUN) ?? []) {
    if (w.length >= 2) terms.push(w);
  }
  for (const w of norm.match(CJK_RUN) ?? []) {
    if (w.length >= 1) terms.push(w);
  }
  const uniq = Array.from(new Set(terms));
  uniq.sort((a, b) => b.length - a.length);
  return uniq.slice(0, 12);
}

// ── 命中区间扫描 ──────────────────────────────────────────────────────────
// 大小写不敏感、非重叠、左到右扫描。terms 已按长度降序 → 每个位置优先命中最长词，
// 天然防重叠。text 用 toLowerCase 比较（长度稳定，偏移量对齐原文），命中片段回取
// 原文 slice 保留原始大小写。
function findRanges(text: string, terms: string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < lower.length) {
    let hit = 0;
    for (const t of terms) {
      if (t.length > 0 && lower.startsWith(t, i)) {
        hit = t.length;
        break;
      }
    }
    if (hit > 0) {
      ranges.push([i, i + hit]);
      i += hit;
    } else {
      i++;
    }
  }
  return ranges;
}

// ── 纯函数：text + terms → ReactNode ─────────────────────────────────────
// terms 为空或无命中 → 直接返回原始 string（零包裹，feed 与非命中场景 DOM 不变）。
// 有命中 → 命中片段包 <mark>，其余原样，返回 ReactNode[]（<mark> 带 key）。
// 供 TweetCard 富文本复用（在其切出的纯文本段上叠加）。
export function highlightNodes(text: string, terms: string[]): ReactNode {
  if (!text || terms.length === 0) return text;
  const ranges = findRanges(text, terms);
  if (ranges.length === 0) return text;
  const parts: ReactNode[] = [];
  let last = 0;
  ranges.forEach(([start, end], i) => {
    if (start > last) parts.push(text.slice(last, start));
    parts.push(
      <mark key={i} className="bg-transparent text-rose-600 font-medium">
        {text.slice(start, end)}
      </mark>,
    );
    last = end;
  });
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// ── Context / Provider / Hook ─────────────────────────────────────────────
const HighlightContext = createContext<string[]>([]);

export function useHighlightTerms(): string[] {
  return useContext(HighlightContext);
}

export function HighlightProvider({
  terms,
  children,
}: {
  terms: string[];
  children: ReactNode;
}) {
  return (
    <HighlightContext.Provider value={terms}>{children}</HighlightContext.Provider>
  );
}

// ── 展示组件 ──────────────────────────────────────────────────────────────
// 卡片主文本字段接入点。context terms 空 → 返回原始 string（feed 零 DOM 变化）。
export function HL({ text }: { text: string }): ReactNode {
  const terms = useHighlightTerms();
  return highlightNodes(text, terms);
}
