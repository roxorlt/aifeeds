// ClawHub drawer body — sections per design doc:
// docs/plans/2026-05-06-clawhub-source-design.md § 5.4
//
// Order (post-brainstorm lock):
//   ① Header (avatar + title + meta + category chip)
//   ② Stats 2×3
//   ③ 简介 (translated, listing API summary，非真 README — README 全文需 ZIP 流水线 v1)
//   ④ Safety (conditional)
//   ⑤ Install
//   ⑥ Trends 30d (collapsible, v2)
//   ⑦ Files (collapsible, v1 — empty until ZIP pipeline lands)
//   ⑧ SKILL.md original (collapsible, v1 — empty until ZIP pipeline lands)
//   ⑨ Footer

import { useState, useEffect } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Item } from "../types";
import { fetchItem } from "../api";
import { cn, formatCompact, parseJsonField } from "../lib/utils";

// Markdown 渲染样式 — 跟 GithubDrawerBody 同款 token，保证 README 翻译后排版还原。
// 各元素显式 className 而不是依赖 prose（项目没装 @tailwindcss/typography）。
const CLAWHUB_MARKDOWN_COMPONENTS: Components = {
  h1: ({ node: _node, ...props }) => (
    <h1 className="mt-5 mb-2 text-[18px] font-bold text-neutral-900" {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 className="mt-4 mb-2 text-[16px] font-bold text-neutral-900" {...props} />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 className="mt-3 mb-1.5 text-[14px] font-bold text-neutral-900" {...props} />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4 className="mt-3 mb-1 text-[13px] font-semibold text-neutral-900" {...props} />
  ),
  p: ({ node: _node, ...props }) => (
    <p className="my-2 leading-relaxed text-neutral-700" {...props} />
  ),
  a: ({ node: _node, href, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-sky-600 hover:underline break-all"
      onClick={(e) => e.stopPropagation()}
      {...props}
    />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul className="my-2 list-disc pl-5 space-y-1 text-neutral-700" {...props} />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol className="my-2 list-decimal pl-5 space-y-1 text-neutral-700" {...props} />
  ),
  li: ({ node: _node, ...props }) => <li {...props} />,
  code: ({ node: _node, className, children, ...props }) => {
    const isInline = !className?.includes("language-");
    if (isInline) {
      return (
        <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12px] text-neutral-800" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={cn("font-mono text-[12px]", className)} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ node: _node, ...props }) => (
    <pre className="my-3 overflow-x-auto rounded-lg bg-neutral-50 p-3 ring-1 ring-neutral-200" {...props} />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-3 border-l-2 border-neutral-300 pl-3 italic text-neutral-600" {...props} />
  ),
  hr: ({ node: _node, ...props }) => (
    <hr className="my-4 border-neutral-200" {...props} />
  ),
  img: ({ node: _node, src, alt, ...props }) => (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt}
      className="my-2 max-w-full rounded-md border border-neutral-200"
      loading="lazy"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-3 overflow-x-auto">
      <table className="min-w-full border-collapse text-[12px]" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th className="border border-neutral-200 bg-neutral-50 px-2 py-1 text-left font-semibold" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border border-neutral-200 px-2 py-1" {...props} />
  ),
};
import {
  IconStarFill,
  IconDownload,
  IconPackage,
  IconTag,
  IconClock,
  IconShield,
  IconCopy,
} from "./icons";

const CATEGORY_STYLE: Record<string, string> = {
  workflows: "bg-violet-100 text-violet-700",
  "mcp-tools": "bg-blue-100 text-blue-700",
  prompts: "bg-violet-100 text-violet-700",
  "dev-tools": "bg-neutral-100 text-neutral-700",
  data: "bg-teal-100 text-teal-700",
  security: "bg-rose-100 text-rose-700",
  automation: "bg-emerald-100 text-emerald-700",
  other: "bg-neutral-100 text-neutral-700",
};

const CATEGORY_LABEL: Record<string, string> = {
  workflows: "Workflow",
  "mcp-tools": "MCP",
  prompts: "Prompt",
  "dev-tools": "Dev",
  data: "Data",
  security: "Security",
  automation: "自动化",
  other: "其他",
};

// capability_tags 中文翻译表（来自设计文档 § 3.4）
const CAPABILITY_LABEL: Record<string, string> = {
  crypto: "涉及加密资产",
  "requires-wallet": "需要加密钱包",
  "can-make-purchases": "可发起付款",
  "can-sign-transactions": "可签署链上交易",
  "requires-oauth-token": "需要 OAuth 令牌",
  "requires-sensitive-credentials": "需要敏感凭证",
  "posts-externally": "可对外发布",
};

const SEVERITY_LABEL: Record<string, string> = {
  low: "低度",
  medium: "中度",
  high: "高度",
};

const SEVERITY_STYLE: Record<string, string> = {
  low: "bg-neutral-100 text-neutral-700 ring-neutral-200",
  medium: "bg-amber-50 text-amber-700 ring-amber-200",
  high: "bg-rose-100 text-rose-700 ring-rose-200",
};

interface ClawhubMetrics {
  stars?: number;
  downloads?: number;
  installsCurrent?: number;
  installsAllTime?: number;
  comments?: number;
  versions?: number;
}

interface InstallEntry {
  id?: string;
  kind?: string;
  formula?: string;
  label?: string;
  bins?: string[];
}

interface LlmFinding {
  categoryId?: string;
  categoryLabel?: string;
  severity?: string;
  confidence?: string;
  evidence?: { explanation?: string; path?: string; snippet?: string };
  recommendation?: string;
  riskBucket?: string;
}

interface ClawhubExtra {
  slug?: string;
  latest_version?: string;
  versions_count?: number;
  updated_at?: number;
  license?: string;
  install?: InstallEntry[];
  capability_tags?: string[];
  llm_analysis?: { findings?: LlmFinding[] };
  category?: string;
  owner_image?: string;
  owner_github_url?: string;
  summary_en?: string;
  summary_translated?: string;
  ch_pending?: boolean;
  // v1 ZIP 流水线产出
  skill_md?: string;
  files_manifest?: Array<{ path: string; size: number }>;
}

function relativeFromMs(ms: number | undefined): string {
  if (!ms) return "—";
  const diffSec = Math.max(1, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec} 秒前`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  if (diffSec < 30 * 86400) return `${Math.floor(diffSec / 86400)} 天前`;
  if (diffSec < 365 * 86400) return `${Math.floor(diffSec / (30 * 86400))} 月前`;
  return `${Math.floor(diffSec / (365 * 86400))} 年前`;
}

function buildInstallCommand(entry: InstallEntry, slug: string): string {
  if (entry.kind === "brew" && entry.formula) {
    return `brew install ${entry.formula}`;
  }
  if (entry.kind === "npm" && entry.formula) {
    return `npm install -g ${entry.formula}`;
  }
  // 默认走 claw cli
  return `claw install ${slug}`;
}

interface Props {
  item: Item;
}

// 趋势模块阈值：每天 phase 1 cron 跑 2 次（BJT 04:00 + 16:00）→ 2 行/天 ×
// 7 天 = 14 行。低于这个量级 sparkline 抖动剧烈、信息量低，不展示。
const TRENDS_MIN_DATA_POINTS = 14;

export function ClawhubDrawerBody({ item }: Props) {
  const extra = parseJsonField<ClawhubExtra>(item.extra) ?? ({} as ClawhubExtra);
  const metrics = parseJsonField<ClawhubMetrics>(item.metrics) ?? ({} as ClawhubMetrics);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [historyCount, setHistoryCount] = useState<number>(0);

  // 拉 metrics_history 决定是否展示 30 天趋势区段（< 14 个采样点不展示）
  useEffect(() => {
    let cancelled = false;
    fetchItem(item.id).then((resp) => {
      if (cancelled) return;
      const hist = resp.metrics_history;
      if (hist) setHistoryCount(hist.length);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [item.id]);

  const showTrends = historyCount >= TRENDS_MIN_DATA_POINTS;

  const slug = extra.slug || item.source_id;
  const displayName = item.title || slug;
  const handle = item.handle || "";
  const avatar = extra.owner_image || (handle ? `https://avatars.githubusercontent.com/${handle}` : "");
  const license = extra.license || "";
  const version = extra.latest_version || "";
  const versionsCount = extra.versions_count ?? metrics.versions ?? 0;
  const updatedRel = relativeFromMs(extra.updated_at);

  const category = extra.category || "other";
  const categoryStyle = CATEGORY_STYLE[category] || CATEGORY_STYLE.other;
  const categoryLabel = CATEGORY_LABEL[category] || category;

  // v2: content_translated 是 ClawHub 渲染的 README/SKILL.md 中文译文（getReadme action 拿到的）
  // 用 readme_file 字段告诉前端 ClawHub 选了哪个文件
  const readme = item.content_translated || item.content || "";
  const summaryEn = extra.summary_en || "";
  const summaryZh = extra.summary_translated || "";
  // readme_file 暴露在 extra 但当前 UI 未直接展示，预留给未来「依据 SKILL.md 渲染」之类的提示
  const _readmeFile = (extra as any).readme_file as string | undefined;
  void _readmeFile;
  // 双门槛：> 200 字 + 跟 summary 不同 → 是真 README/SKILL.md 内容；否则按 summary 兜底
  const isReadme = readme.length > 200
    && readme !== summaryEn
    && readme !== summaryZh;
  const fallbackSummary = summaryZh || summaryEn;

  const capabilityTags = extra.capability_tags || [];
  const llmFindings = extra.llm_analysis?.findings || [];
  const hasSafety = capabilityTags.length > 0 || llmFindings.length > 0;

  const installList: InstallEntry[] = [...(extra.install || [])];
  // 始终把 claw install 放第一（如果 install 列表里没有 claw 项）
  const hasClaw = installList.some((it) => it.id === "claw" || it.kind === "claw");
  if (!hasClaw) {
    installList.unshift({ id: "claw", kind: "claw", label: "Install via claw" });
  }

  const phUrl = item.url || (slug ? `https://clawhub.ai/skills/${slug}` : "");
  const githubUrl = extra.owner_github_url || (handle ? `https://github.com/${handle}` : "");

  async function copyCommand(cmd: string, idx: number) {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx(null), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <>
      {/* ① Header */}
      <div className="border-b border-neutral-200 p-5">
        <div className="flex items-start gap-3">
          {avatar ? (
            <img
              src={avatar}
              alt={handle}
              className="h-14 w-14 shrink-0 rounded-2xl bg-neutral-200 object-cover"
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
          ) : (
            <div className="h-14 w-14 shrink-0 rounded-2xl bg-neutral-200" />
          )}
          <div className="min-w-0 flex-1">
            <div className="text-[18px] font-bold leading-tight text-neutral-900 break-words">
              {displayName}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-neutral-500">
              <span>by</span>
              {handle && (
                <a
                  href={githubUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-neutral-700 hover:text-sky-600 hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  @{handle}
                </a>
              )}
              {version && (
                <>
                  <span className="text-neutral-400">·</span>
                  <span className="tabular-nums">v{version}</span>
                </>
              )}
              {license && (
                <>
                  <span className="text-neutral-400">·</span>
                  <span title="开源协议">{license}</span>
                </>
              )}
            </div>
            {/* category chip 跟 title 左对齐（在 title 列内，不在 avatar 左缘对齐） */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
                  categoryStyle,
                )}
              >
                {categoryLabel}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* ② Stats 2x3 */}
      <div className="border-b border-neutral-200 px-5 py-3">
        <div className="grid grid-cols-3 gap-3 text-center">
          <Stat icon={<IconStarFill className="h-3.5 w-3.5 text-amber-500" />} value={formatCompact(metrics.stars ?? 0)} label="星标数" />
          <Stat icon={<IconDownload className="h-3.5 w-3.5 text-neutral-500" />} value={formatCompact(metrics.downloads ?? 0)} label="下载量" />
          <Stat icon={<IconTag className="h-3.5 w-3.5 text-neutral-500" />} value={String(versionsCount)} label="版本数" />
          <Stat icon={<IconPackage className="h-3.5 w-3.5 text-neutral-500" />} value={formatCompact(metrics.installsCurrent ?? 0)} label="当前安装" />
          <Stat icon={<IconPackage className="h-3.5 w-3.5 text-neutral-500" />} value={formatCompact(metrics.installsAllTime ?? 0)} label="累计安装" />
          <Stat icon={<IconClock className="h-3.5 w-3.5 text-neutral-500" />} value={updatedRel} label="最近更新" />
        </div>
      </div>

      {/* ③ README / 简介 — v1 ZIP 流水线后：有 README.md 就 markdown 渲染中文译文；
            无 README 时回退展示 listing summary（短描述）。两种内容用不同标签区分 */}
      {(isReadme || fallbackSummary) && (
        <div className="border-b border-neutral-200 p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
            {isReadme ? "README" : "简介"}
          </div>
          {isReadme ? (
            <div className="text-[14px] break-words">
              <Markdown remarkPlugins={[remarkGfm]} components={CLAWHUB_MARKDOWN_COMPONENTS}>
                {readme}
              </Markdown>
            </div>
          ) : (
            <p className="text-[14px] leading-relaxed text-neutral-800 whitespace-pre-wrap break-words">
              {fallbackSummary}
            </p>
          )}
          {extra.ch_pending && (
            <p className="mt-2 text-[11px] text-neutral-400 italic">
              翻译进行中，稍后刷新可看完整中文译文
            </p>
          )}
        </div>
      )}

      {/* ④ Safety (conditional) */}
      {hasSafety && (
        <div className="border-b border-neutral-200 p-5">
          <div className="flex items-center gap-2 mb-3">
            <IconShield className="h-3.5 w-3.5 text-neutral-500" />
            <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
              安全审查
            </div>
          </div>

          {capabilityTags.length > 0 && (
            <p className="mb-3 text-[12px] text-amber-700 leading-relaxed">
              {capabilityTags.map((t, i) => (
                <span key={t}>
                  {i > 0 && <span className="text-neutral-400 mx-1">·</span>}
                  {CAPABILITY_LABEL[t] || t}
                </span>
              ))}
            </p>
          )}

          {llmFindings.length > 0 && (
            <div className="space-y-2">
              {llmFindings.map((f, i) => {
                const sev = f.severity?.toLowerCase() || "low";
                const sevStyle = SEVERITY_STYLE[sev] || SEVERITY_STYLE.low;
                const sevLabel = SEVERITY_LABEL[sev] || sev;
                const isHigh = sev === "high";
                return (
                  <details
                    key={i}
                    className={cn(
                      "rounded-md bg-white ring-1 p-3",
                      isHigh ? "ring-2 ring-rose-300" : "ring-neutral-200",
                    )}
                  >
                    <summary className="cursor-pointer text-[12px] flex items-start gap-2">
                      <span
                        className={cn(
                          "shrink-0 inline-flex items-center justify-center rounded ring-1 text-[10px] font-mono px-1.5 py-0.5",
                          sevStyle,
                          isHigh && "font-semibold",
                        )}
                      >
                        {sevLabel}
                      </span>
                      <div className="flex-1">
                        <span className="font-semibold text-neutral-900">
                          {f.categoryLabel || f.categoryId || "风险"}
                        </span>
                        {f.categoryId && f.categoryLabel && (
                          <span className="ml-1 text-[11px] text-neutral-400">（{f.categoryId}）</span>
                        )}
                      </div>
                    </summary>
                    {(f.evidence?.explanation || f.recommendation || f.evidence?.snippet) && (
                      <div
                        className={cn(
                          "mt-2 pt-2 border-t space-y-2 text-[12px] text-neutral-700",
                          isHigh ? "border-rose-100" : "border-neutral-100",
                        )}
                      >
                        {f.evidence?.snippet && (
                          <div>
                            <span className="text-[10px] font-semibold uppercase text-neutral-400">
                              证据{f.evidence.path ? ` · ${f.evidence.path}` : ""}
                            </span>
                            <p className="mt-0.5 italic text-neutral-600 break-words">"{f.evidence.snippet}"</p>
                          </div>
                        )}
                        {f.evidence?.explanation && (
                          <p className="text-neutral-700 break-words">{f.evidence.explanation}</p>
                        )}
                        {f.recommendation && (
                          <div>
                            <span className="text-[10px] font-semibold uppercase text-neutral-400">建议</span>
                            <p className="mt-0.5 break-words">{f.recommendation}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </details>
                );
              })}
            </div>
          )}

          <div className="mt-3 flex items-center gap-3 text-[10px] text-neutral-500">
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-neutral-300" />低度
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400" />中度
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-rose-500" />高度
            </span>
            <span className="ml-auto text-neutral-400">来源：ClawHub 安全扫描</span>
          </div>
        </div>
      )}

      {/* ⑤ Install commands */}
      {installList.length > 0 && (
        <div className="border-b border-neutral-200 p-5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500 mb-2">
            安装
          </div>
          <div className="space-y-2">
            {installList.map((entry, i) => {
              const cmd = buildInstallCommand(entry, slug);
              const isPrimary = i === 0;
              return (
                <div
                  key={i}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 font-mono text-[12px]",
                    isPrimary
                      ? "bg-neutral-900 text-neutral-100"
                      : "bg-neutral-50 ring-1 ring-neutral-200 text-neutral-700",
                  )}
                >
                  <span className={isPrimary ? "text-neutral-500" : "text-neutral-400"}>$</span>
                  <span className="flex-1 truncate">{cmd}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void copyCommand(cmd, i);
                    }}
                    className={cn(
                      "shrink-0 inline-flex items-center gap-1 text-[11px]",
                      isPrimary ? "text-neutral-400 hover:text-white" : "text-neutral-400 hover:text-neutral-700",
                    )}
                    title="复制到剪贴板"
                  >
                    <IconCopy className="h-3 w-3" />
                    {copiedIdx === i ? "已复制" : "复制"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ⑥ Trends 30d — 数据点 ≥ 14 才展示（每天 2 个采样点 × 7 天 = 14） */}
      {showTrends && (
        <details className="border-b border-neutral-200 group">
          <summary className="cursor-pointer p-5 text-[12px] font-semibold text-neutral-700 flex items-center gap-2 hover:bg-neutral-50">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-neutral-400 group-open:rotate-180 transition-transform">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            30 天趋势
            <span className="ml-auto text-[10px] text-neutral-400 font-normal">{historyCount} 个采样点</span>
          </summary>
          <div className="px-5 pb-5">
            <div className="rounded-md bg-gradient-to-b from-emerald-50 to-white ring-1 ring-emerald-200 p-4 h-32 flex items-center justify-center text-[12px] text-emerald-700">
              ★ stars 走势 sparkline（v2 渲染中…当前仅展示采样点数）
            </div>
          </div>
        </details>
      )}

      {/* ⑦ Files manifest — v1 ZIP 抓回的真实文件清单（目录树 ASCII 渲染）*/}
      {(extra.files_manifest && extra.files_manifest.length > 0) && (
        <details className="border-b border-neutral-200 group">
          <summary className="cursor-pointer p-5 text-[12px] font-semibold text-neutral-700 flex items-center gap-2 hover:bg-neutral-50">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-neutral-400 group-open:rotate-180 transition-transform">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            文件清单
            <span className="ml-auto text-[10px] text-neutral-400 font-normal tabular-nums">
              {extra.files_manifest.length} 个文件
            </span>
          </summary>
          <div className="px-5 pb-5">
            <pre className="rounded-md bg-neutral-50 ring-1 ring-neutral-200 p-3 text-[11px] font-mono text-neutral-700 leading-relaxed overflow-x-auto whitespace-pre">
              {renderFileTree(extra.files_manifest)}
            </pre>
          </div>
        </details>
      )}

      {/* ⑧ SKILL.md 原文 — v1 ZIP 抓回，永不翻译（给 Claude 读的指令文档）*/}
      {extra.skill_md && extra.skill_md.length > 0 && (
        <details className="border-b border-neutral-200 group">
          <summary className="cursor-pointer p-5 text-[12px] font-semibold text-neutral-700 flex items-center gap-2 hover:bg-neutral-50">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3 h-3 text-neutral-400 group-open:rotate-180 transition-transform">
              <polyline points="6 9 12 15 18 9" />
            </svg>
            SKILL.md 原文
            <span className="ml-auto text-[10px] text-neutral-400 font-normal tabular-nums">
              {(extra.skill_md.length / 1024).toFixed(1)} KB
            </span>
          </summary>
          <div className="px-5 pb-5">
            <pre className="rounded-md bg-neutral-50 ring-1 ring-neutral-200 p-3 text-[11px] font-mono text-neutral-700 leading-relaxed overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
              {extra.skill_md}
            </pre>
          </div>
        </details>
      )}

      {/* ⑨ Footer */}
      <div className="p-5">
        <div className="flex flex-col gap-2">
          {phUrl && (
            <a
              href={phUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center justify-between rounded-md ring-1 ring-neutral-200 px-3 py-2 text-[13px] text-neutral-700 hover:bg-neutral-50"
            >
              <span>在 ClawHub 打开</span>
              <span className="text-neutral-400">↗</span>
            </a>
          )}
          {githubUrl && handle && (
            <a
              href={githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center justify-between rounded-md ring-1 ring-neutral-200 px-3 py-2 text-[13px] text-neutral-700 hover:bg-neutral-50"
            >
              <span>查看作者 GitHub @{handle}</span>
              <span className="text-neutral-400">↗</span>
            </a>
          )}
        </div>
      </div>
    </>
  );
}

// 把 [{path, size}] 渲染成 ASCII 目录树。按路径分组，递归出 ├── └── │   缩进。
function renderFileTree(files: Array<{ path: string; size: number }>): string {
  // sort 路径自然顺序
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  // 按目录分组
  const tree: Record<string, Array<{ name: string; size: number; isDir: boolean }>> = {};
  for (const f of sorted) {
    const parts = f.path.split("/");
    const fileName = parts[parts.length - 1];
    const dirPath = parts.slice(0, -1).join("/");
    if (!tree[dirPath]) tree[dirPath] = [];
    tree[dirPath].push({ name: fileName, size: f.size, isDir: false });
  }

  function fmtSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // 简化版：按目录分组打印（不做完整递归 tree）
  const lines: string[] = [];
  const dirs = Object.keys(tree).sort();
  for (const dir of dirs) {
    if (dir) lines.push(`${dir}/`);
    const items = tree[dir];
    items.forEach((item, i) => {
      const isLast = i === items.length - 1;
      const prefix = dir ? "  " : "";
      const branch = isLast ? "└── " : "├── ";
      const padding = " ".repeat(Math.max(1, 36 - (prefix + branch + item.name).length));
      lines.push(`${prefix}${branch}${item.name}${padding}${fmtSize(item.size)}`);
    });
  }
  return lines.join("\n");
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div>
      <div className="flex items-center justify-center gap-1 text-[15px] font-bold text-neutral-900 tabular-nums">
        {icon}
        {value}
      </div>
      <div className="text-[10px] text-neutral-500 mt-0.5">{label}</div>
    </div>
  );
}
