// Blog (官方新闻 / 厂商博客) drawer body — 阅读路径，对照设计文档 §10.3 +
// mockup docs/plans/_mockups/2026-06-09-feeds-drawer-blog.html。
//
// 区段顺序「是什么 → 读正文」:
//   1. publisher 头（logo/monogram + 公司名 + 分类 chip + 时间 + 约 N 分钟阅读，无 metrics 行）
//   2. 标题中译（外文源加英文原标题）
//   3. ELI25 摘要 lead
//   4. 封面（满宽 16:9，可点 → Lightbox）
//   5. 正文 markdown 全文 + 译/原 toggle + 内联图 Lightbox
//      （headless 抓不全正文时降级：只留摘要 + 封面，正文段省略，靠 TweetDrawer
//       footer「在 XX 博客打开」回原文）
//
// 「去原文」外链不在本组件 —— 由 TweetDrawer 的 footer（externalLinkLabel 分支，
// fe-integration 接线）统一渲染，与 GithubDrawerBody / PhDrawerBody 一致，避免重复。
//
// markdown 渲染：复用 GithubDrawerBody 的同款 Tailwind 标签样式（像素一致）+
// 按渲染序收集图喂 Lightbox，但**换简化 resolver**:`/r/` 走 resolveAssetUrl、
// http(s) 透传 —— 不抄 GH 绑死 owner/repo/branch 的相对 URL 重写（相对 URL 已在
// BE step3 按各 feed base 域解析成绝对，见 §9.2）。

import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import type { Components } from "react-markdown";
import type { Item, ItemExtra, MediaItem } from "../types";
import { cn, parseJsonField, timeAgo } from "../lib/utils";
import { resolveAssetUrl } from "../lib/asset";
import { Lightbox } from "./Lightbox";
import { IconClock } from "./icons";

// 简化版 resolver：博客正文相对 URL 已在 BE step3 解析成绝对（§9.2），FE 只需
// 处理 `/r/`（worker R2 反代 → 拼 worker base）与 http(s)/data（透传）。
// resolveAssetUrl 已覆盖这两类，直接复用。
const resolveBlogAsset = resolveAssetUrl;

// 按渲染序收集正文图片（markdown ![]() + HTML <img>），resolve 成绝对喂 Lightbox。
// 逻辑同 GithubDrawerBody.extractReadmeImages，只换 resolver。
function extractBlogImages(markdown: string): MediaItem[] {
  const out: MediaItem[] = [];
  const seen = new Set<string>();
  const push = (rawSrc: string) => {
    const resolved = resolveBlogAsset(rawSrc);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    out.push({ type: "image", url: resolved });
  };
  const mdRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdRe.exec(markdown)) !== null) push(m[1]);
  const htmlRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((m = htmlRe.exec(markdown)) !== null) push(m[1]);
  return out;
}

// markdown 标签样式对齐 GithubDrawerBody.makeMarkdownComponents（像素一致），
// 只把相对 URL 重写换成简化 resolver。onImageClick 点内联图回调 → 父级映射
// 到 Lightbox index 打开。
// 只解构需要的 props（不展开 rest / 不碰 node）—— 对齐 HfPaperDrawerBody 的
// lint-clean 风格，className 全硬编码（与 GithubDrawerBody 同款 token，像素一致）。
function makeBlogMarkdownComponents(
  onImageClick?: (resolvedSrc: string) => void,
): Components {
  return {
    h1: ({ children }) => <h1 className="mt-5 mb-2 text-[18px] font-bold text-neutral-900">{children}</h1>,
    h2: ({ children }) => <h2 className="mt-4 mb-2 text-[16px] font-bold text-neutral-900">{children}</h2>,
    h3: ({ children }) => <h3 className="mt-3 mb-1.5 text-[14px] font-bold text-neutral-900">{children}</h3>,
    h4: ({ children }) => <h4 className="mt-3 mb-1 text-[13px] font-semibold text-neutral-900">{children}</h4>,
    p: ({ children }) => <p className="my-2 leading-relaxed text-neutral-700">{children}</p>,
    a: ({ href, children }) => (
      <a
        href={href ? resolveBlogAsset(href) : undefined}
        target="_blank"
        rel="noopener noreferrer"
        className="text-sky-600 hover:underline break-all"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </a>
    ),
    ul: ({ children }) => <ul className="my-2 list-disc pl-5 space-y-1 text-neutral-700">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal pl-5 space-y-1 text-neutral-700">{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    code: ({ className, children }) => {
      // fenced/inline code 一律保持原文（译/原 两态都不译，BE 已保证）
      const isInline = !className?.includes("language-");
      if (isInline) {
        return (
          <code className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[12px] text-neutral-800">
            {children}
          </code>
        );
      }
      return <code className={cn("font-mono text-[12px]", className)}>{children}</code>;
    },
    pre: ({ children }) => (
      <pre className="my-3 overflow-x-auto rounded-lg bg-neutral-50 p-3 ring-1 ring-neutral-200">{children}</pre>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-3 border-l-2 border-neutral-300 pl-3 italic text-neutral-600">{children}</blockquote>
    ),
    hr: () => <hr className="my-4 border-neutral-200" />,
    img: ({ src, alt }) => {
      const resolved = resolveBlogAsset(typeof src === "string" ? src : undefined);
      return (
        <img
          src={resolved}
          alt={alt || ""}
          className="my-2 max-w-full cursor-zoom-in rounded-md border border-neutral-200"
          loading="lazy"
          onClick={(e) => {
            // 防 [![](src)](url) 图片包链接点击冒泡触发 anchor 导航
            e.preventDefault();
            e.stopPropagation();
            if (resolved && onImageClick) onImageClick(resolved);
          }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      );
    },
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto">
        <table className="min-w-full border-collapse text-[12px]">{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className="border border-neutral-200 bg-neutral-50 px-2 py-1 text-left font-semibold">{children}</th>
    ),
    td: ({ children }) => <td className="border border-neutral-200 px-2 py-1">{children}</td>,
  };
}

// blog ai_category → 中文 chip 文案（neutral chip，不上彩色，对齐 mockup +
// frontend-ux-guidelines）。未知值不出 chip。
const BLOG_CATEGORY_LABEL: Record<string, string> = {
  "model-release": "模型发布",
  research: "研究",
  product: "产品",
  engineering: "工程实践",
  safety: "安全",
  company: "公司动态",
};

// 译/原 toggle —— lucide languages 图标（icons.tsx 暂无，本地内联；零 emoji）
function IconTranslate({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m5 8 6 6" />
      <path d="m4 14 6-6 2-3" />
      <path d="M2 5h12" />
      <path d="M7 2h1" />
      <path d="m22 22-5-10-5 10" />
      <path d="M14 18h6" />
    </svg>
  );
}

// 放大角标（lucide zoom-in）
function IconZoom({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
      <path d="M11 8v6" />
      <path d="M8 11h6" />
    </svg>
  );
}

// 译/原 pill 段控（对齐 mockup .lang-seg：rounded-full border，active = neutral-900 黑底）
function LangToggle({
  value,
  onChange,
}: {
  value: "zh" | "orig";
  onChange: (v: "zh" | "orig") => void;
}) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded-full border border-neutral-200 p-0.5 text-[12px]">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onChange("zh");
        }}
        className={cn(
          "inline-flex items-center gap-1 rounded-full px-2.5 py-1",
          value === "zh" ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-50",
        )}
      >
        <IconTranslate className="h-3.5 w-3.5" />
        译文
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onChange("orig");
        }}
        className={cn(
          "rounded-full px-2.5 py-1",
          value === "orig" ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-50",
        )}
      >
        原文
      </button>
    </div>
  );
}

interface Props {
  item: Item;
}

export function BlogDrawerBody({ item }: Props) {
  const extra = parseJsonField<ItemExtra>(item.extra) ?? ({} as ItemExtra);

  // publisher 头
  const pub = extra.publisher;
  const pubName = pub?.name || extra.source_company || extra.blog_name || item.author || "";
  const pubIcon = pub?.icon_r2 ? resolveAssetUrl(pub.icon_r2) : "";
  const monogram = (pubName || "?").trim().charAt(0).toUpperCase() || "?";

  // 分类 chip
  const category = (extra.ai_category as string | null | undefined) || "";
  const categoryLabel = category ? BLOG_CATEGORY_LABEL[category] : "";

  // 时间 + 阅读时长（无 metrics 行，RSS 无互动数）
  const publishedAt = item.published_at || item.scraped_at;
  const readingMinutes = extra.reading_minutes;

  // 标题：中译为主，外文源补英文原标题
  const titleZh = extra.title_zh || item.title || "";
  const titleOriginal = item.title || "";
  const isForeign = (item.lang || "") !== "zh";
  const showOriginalTitle = isForeign && !!titleOriginal && titleOriginal !== titleZh;

  // ELI25 摘要 lead（概览）
  const summary = extra.ai_summary_zh || extra.excerpt_zh || extra.excerpt || "";

  // 封面
  const coverSrc = extra.cover_image ? resolveAssetUrl(extra.cover_image) : "";

  // 正文 markdown（译/原）
  const bodyRaw = extra.body_markdown || "";
  const bodyZh = extra.body_markdown_zh || "";
  const hasBody = !!(bodyRaw || bodyZh);
  const showTabs = isForeign; // 外文源出译/原 toggle；中文源不出
  const [tab, setTab] = useState<"zh" | "orig">(
    isForeign && bodyZh ? "zh" : "orig",
  );
  const bodyToShow = tab === "zh" ? bodyZh || bodyRaw : bodyRaw;

  // Lightbox：封面（idx 0）+ 正文内联图，按序收集。React Compiler 自动 memo，
  // 不手写 useMemo（react-hooks/preserve-manual-memoization 会拦截无法保留的手动 memo）。
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const bodyImages = extractBlogImages(bodyToShow || "");
  const lightboxMedia: MediaItem[] = coverSrc
    ? [{ type: "image", url: coverSrc }, ...bodyImages]
    : bodyImages;
  const markdownComponents = makeBlogMarkdownComponents((resolvedSrc) => {
    const idx = lightboxMedia.findIndex((mm) => mm.url === resolvedSrc);
    if (idx >= 0) setLightboxIndex(idx);
  });

  return (
    <div className="text-neutral-900">
      {/* ① 是什么：publisher 头 + 标题中译 + 英文原标题 */}
      <div className="border-b border-neutral-100 p-5" data-drawer-title-anchor>
        <div className="flex items-start gap-3">
          {pubIcon ? (
            <img
              src={pubIcon}
              alt={pubName}
              className="h-11 w-11 shrink-0 rounded-xl bg-neutral-100 object-cover"
              onError={(e) => (e.currentTarget.style.visibility = "hidden")}
            />
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-neutral-200 text-[18px] font-bold text-neutral-600">
              {monogram}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[15px] font-semibold text-neutral-800">
                {pubName}
              </span>
              {categoryLabel && (
                <span className="ml-auto shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">
                  {categoryLabel}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-neutral-500">
              {publishedAt && <span>{timeAgo(publishedAt)}</span>}
              {publishedAt && readingMinutes ? <span className="text-neutral-400">·</span> : null}
              {readingMinutes ? (
                <span className="inline-flex items-center gap-1">
                  <IconClock className="h-3.5 w-3.5" />约 {readingMinutes} 分钟阅读
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <h2 className="mt-3 text-[18px] font-bold leading-snug text-neutral-900 break-words">
          {titleZh}
        </h2>
        {showOriginalTitle && (
          <div className="mt-1 text-[13px] leading-snug text-neutral-500 break-words">
            {titleOriginal}
          </div>
        )}
      </div>

      {/* ① ELI25 摘要 lead（标 "概览"，避免向终端用户暴露 ELI25 内部代号） */}
      {summary && (
        <div className="border-b border-neutral-100 p-5">
          <div className="mb-1.5 text-[11px] font-medium tracking-wide text-neutral-400">
            概览
          </div>
          <p className="text-[15px] leading-relaxed text-neutral-700">{summary}</p>
        </div>
      )}

      {/* ① 封面 og:image（满宽 16:9，可点 → Lightbox idx 0；BE 已做质量门控 + R2 缓存） */}
      {coverSrc && (
        <div className="px-5 pt-5">
          <div className="overflow-hidden rounded-xl border border-neutral-200">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setLightboxIndex(0);
              }}
              className="group relative block w-full cursor-zoom-in"
              aria-label="放大封面"
            >
              <img
                src={coverSrc}
                alt={titleZh}
                className="block aspect-[16/9] w-full bg-neutral-100 object-cover"
                loading="eager"
                onError={(e) => (e.currentTarget.style.display = "none")}
              />
              <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/45 px-2 py-1 text-[10px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                <IconZoom className="h-3 w-3" />放大
              </span>
            </button>
          </div>
        </div>
      )}

      {/* ② 读正文：正文 header（译/原 toggle）+ markdown 全文。headless 抓不全
          正文时（hasBody=false）整段省略，靠上方摘要 + footer 外链回原文 */}
      {hasBody && (
        <div>
          <div className="mt-4 flex items-center justify-between border-y border-neutral-100 px-5 py-2.5">
            <h3 className="text-[13px] font-semibold text-neutral-900">正文</h3>
            {showTabs && <LangToggle value={tab} onChange={setTab} />}
          </div>
          <div className="max-w-none break-words p-5 pt-3 text-[13px]">
            {showTabs && tab === "zh" && !bodyZh ? (
              <p className="text-neutral-400">译文还没准备好，稍后再看</p>
            ) : (
              <Markdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeRaw]}
                components={markdownComponents}
              >
                {bodyToShow || bodyRaw}
              </Markdown>
            )}
          </div>
        </div>
      )}

      {/* Lightbox：封面 + 正文内联图（复用 X TweetCard 同款组件） */}
      {lightboxIndex !== null && lightboxMedia.length > 0 && (
        <Lightbox
          media={lightboxMedia}
          startIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}
