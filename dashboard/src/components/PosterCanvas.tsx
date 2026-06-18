// PR2 v3 c 端海报渲染:
// 把流内真实 Card (TweetCard/GithubCard/PhCard/HfPaperCard/ClawhubCard/HuodongxingCard)
// 直接渲染到 1080px 宽容器,然后 modern-screenshot 截图成 PNG.
// 字体复用 dashboard 已加载的 HarmonyOS Sans SC (来自 fonts.ai-feeds.com),
// 视觉 100% 跟流内一致,所见即所得.
//
// 设计:
// - Hero (顶部):AI-Feeds logo + 副标题 + source chip,绿紫渐变背景
// - Body (中部):透传给 Card 组件,白色 card-on-card 容器
// - Footer (底部):sharer avatar + nickname + QR (linkto share_url)
//
// 包装层 .poster-shell 上的 CSS 防止内层 hover/cursor 等交互态影响截图

import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { domToBlob } from "modern-screenshot";
import type { Item } from "../types";
import { TweetCard } from "./TweetCard";
import { GithubCard } from "./GithubCard";
import { PhCard } from "./PhCard";
import { HfPaperCard } from "./HfPaperCard";
import { ClawhubCard } from "./ClawhubCard";
import { HuodongxingCard } from "./HuodongxingCard";
import { BlogCard } from "./BlogCard";
import { PodcastCard } from "./PodcastCard";

// AI-Feeds logo (square_bw_night 同款 — 跟 worker svg-template.ts 的
// AI_FEEDS_LOGO_DATA_URL 完全一致,保证 og:image fallback 跟 c 端海报视觉对齐)
const AI_FEEDS_LOGO_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNTYiIGhlaWdodD0iMjU2IiB2aWV3Qm94PSIwIDAgNTEyIDUxMiI+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNNTQgMzQwIEw0MDUgOTQiIHN0cm9rZT0iI0YzRjRGNiIgc3Ryb2tlLXdpZHRoPSIxOCIvPjxwYXRoIGQ9Ik03MCAzMzEgTDM5NCAxMDQiIHN0cm9rZT0iIzBCMEYxNCIgc3Ryb2tlLXdpZHRoPSI1IiBvcGFjaXR5PSIwLjkyIi8+PGVsbGlwc2UgY3g9IjU1IiBjeT0iMzQwIiByeD0iOS41IiByeT0iMTIuNSIgdHJhbnNmb3JtPSJyb3RhdGUoLTU1IDU1IDM0MCkiIGZpbGw9IiMwQjBGMTQiIHN0cm9rZT0iI0YzRjRGNiIgc3Ryb2tlLXdpZHRoPSI2Ii8+PHBhdGggZD0iTTE1MCAyNzYgQzE1NCAyNjcgMTYzIDI2NyAxNjYgMjc0IiBzdHJva2U9IiNGM0Y0RjYiIHN0cm9rZS13aWR0aD0iNSIvPjxwYXRoIGQ9Ik0yNzYgMTg4IEMyODEgMTc4IDI5MSAxODAgMjkyIDE4OCIgc3Ryb2tlPSIjRjNGNEY2IiBzdHJva2Utd2lkdGg9IjUiLz48L2c+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRjNGNEY2IiBzdHJva2Utd2lkdGg9IjUuNSIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMzk4IDEwMCBDMzg2IDg4IDM5MCA3NiA0MDMgODMgQzQxNCA5MCA0MTEgMTAyIDM5OCAxMDBaIi8+PHBhdGggZD0iTTQwNSA5OSBDNDIzIDgzIDQzNiA4NCA0MzcgOTMgQzQzOCAxMDMgNDIwIDEwNiA0MDUgOTlaIi8+PHBhdGggZD0iTTQwNCAxMDAgQzM5MiAxMTMgMzgzIDEyMCAzNzcgMTE1Ii8+PHBhdGggZD0iTTQwNyAxMDIgQzQyMCAxMTUgNDI5IDEyMiA0MzUgMTE2Ii8+PC9nPjxwYXRoIGQ9Ik00MDUgMTAzIEw0MDUgMjQxIiBmaWxsPSJub25lIiBzdHJva2U9IiNGM0Y0RjYiIHN0cm9rZS13aWR0aD0iNS41IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48ZyBmaWxsPSJub25lIiBzdHJva2U9IiM4REREM0QiIHN0cm9rZS13aWR0aD0iNi41IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik00MDUgMjQ2IEw0MDUgMTc4Ii8+PHBhdGggZD0iTTQwNSAyMTQgTDM4NCAxOTMiLz48cGF0aCBkPSJNNDA1IDIxMCBMNDMwIDE4NyIvPjxwYXRoIGQ9Ik00MDYgMjI5IEwzNzEgMjE4Ii8+PHBhdGggZD0iTTQwNyAyMjUgTDQ0NCAyMTgiLz48cGF0aCBkPSJNNDAxIDIzMyBMMzgyIDI0NiIvPjxwYXRoIGQ9Ik00MTAgMjM1IEw0MzcgMjQ4Ii8+PHBhdGggZD0iTTQwNSAxOTAgTDM5NCAxNzkiLz48cGF0aCBkPSJNNDA1IDE5OCBMNDE4IDE4NCIvPjxwYXRoIGQ9Ik0zODQgMTkzIEwzNzAgMTkwIi8+PHBhdGggZD0iTTM4NCAxOTMgTDM4MSAxNzkiLz48cGF0aCBkPSJNNDMwIDE4NyBMNDQzIDE4NCIvPjxwYXRoIGQ9Ik00MzAgMTg3IEw0MzIgMTcyIi8+PHBhdGggZD0iTTM3MSAyMTggTDM1OCAyMTUiLz48cGF0aCBkPSJNMzcxIDIxOCBMMzY1IDIwNSIvPjxwYXRoIGQ9Ik00NDQgMjE4IEw0NTggMjE4Ii8+PHBhdGggZD0iTTQ0NCAyMTggTDQ1MiAyMDUiLz48L2c+PGcgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMzgyIDI0OSBDMzY1IDI4MSAzNjUgMzUzIDM5MCA0NDQgQzM5MiA0NTIgNDAxIDQ1MiA0MDQgNDQ0IEM0MzEgMzUzIDQyOSAyODAgNDEzIDI0OSBDNDA1IDIzNyAzOTAgMjM3IDM4MiAyNDlaIiBmaWxsPSIjRkY5QTFBIiBzdHJva2U9IiNGM0Y0RjYiIHN0cm9rZS13aWR0aD0iOCIvPjxwYXRoIGQ9Ik0zODEgMjkxIEMzOTQgMjk5IDQwNyAzMDAgNDIxIDI5NCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRkZEMDhBIiBzdHJva2Utd2lkdGg9IjQuNSIgb3BhY2l0eT0iMC45Ii8+PHBhdGggZD0iTTM3NiAzMzEgQzM5MSAzMzkgNDA1IDM0MCA0MjMgMzMzIiBmaWxsPSJub25lIiBzdHJva2U9IiNGRkQwOEEiIHN0cm9rZS13aWR0aD0iNC41IiBvcGFjaXR5PSIwLjkiLz48cGF0aCBkPSJNMzg0IDM3OCBDMzk3IDM4NCA0MTAgMzg0IDQyMCAzNzkiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0ZGRDA4QSIgc3Ryb2tlLXdpZHRoPSI0LjUiIG9wYWNpdHk9IjAuOSIvPjxwYXRoIGQ9Ik0zOTAgNDE0IEMzOTggNDE5IDQwNyA0MTkgNDE0IDQxNSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRkZEMDhBIiBzdHJva2Utd2lkdGg9IjQuNSIgb3BhY2l0eT0iMC45Ii8+PC9nPjxnIGZpbGw9Im5vbmUiIHN0cm9rZT0iI0YzRjRGNiIgc3Ryb2tlLXdpZHRoPSI2IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik00MDQgMjQ3IEMzODUgMjI2IDM1OSAyMzEgMzY5IDI1MCBDMzc4IDI2OCAzOTIgMjYwIDQwNCAyNDdaIi8+PHBhdGggZD0iTTQwNiAyNDcgQzQyOCAyMjQgNDUyIDIzMiA0NDIgMjUxIEM0MzIgMjY4IDQxOCAyNjEgNDA2IDI0N1oiLz48cGF0aCBkPSJNNDA0IDI0OCBDMzk4IDI1OSAzOTIgMjY3IDM4NSAyNzMiLz48cGF0aCBkPSJNNDA3IDI0OCBDNDE1IDI2MCA0MjEgMjY4IDQyOSAyNzMiLz48L2c+PC9zdmc+";

// 各 source 显示中文 + chip 主色 (跟 worker svg-template hero source chip 对齐)
const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  x_list: { label: "X · 推文", color: "#1d9bf0" },
  github: { label: "GitHub · 项目", color: "#2da44e" },
  product_hunt: { label: "Product Hunt", color: "#da552f" },
  hf_paper: { label: "HF · 每日论文", color: "#ff9d00" },
  clawhub: { label: "ClawHub · 技能", color: "#7c3aed" },
  huodongxing: { label: "活动行 · 活动", color: "#ef4444" },
  // 新闻&播客合并频道:blog/podcast 各自的源 chip(此前缺条目 → 回退英文 source_type)。
  // 单 blog 海报显「新闻」、单 podcast 显「播客」(频道名「新闻&播客」由两者组成)。
  blog: { label: "新闻", color: "#475569" },
  podcast: { label: "播客", color: "#8b5cf6" },
};

/**
 * Body wrapper:把流内 Card 用 transform scale 放大,让 1080 海报里
 * 字号视觉跟卡片尺寸成正比.外层容器 overflow:hidden + height 跟随
 * 内层 layout 高度 × scale (用 ResizeObserver 测量),避免内容被裁切.
 *
 * 为什么不用 css zoom:zoom 在 modern-screenshot 跨浏览器序列化不一致;
 * transform + 测量更可靠.
 */
function PosterBody({ item, scale, flatTop }: { item: Item; scale: number; flatTop?: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    const wrap = wrapRef.current;
    if (!inner || !wrap) return;
    const update = () => {
      // 用 scrollHeight 兜底 (offsetHeight 在某些 flex 容器下 ≠ 实际内容)
      const h = Math.max(inner.offsetHeight, inner.scrollHeight);
      wrap.style.height = `${h * scale}px`;
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(inner);
    // 内部图片异步加载完后高度会变,再 update 一次
    const imgs = inner.querySelectorAll("img");
    imgs.forEach((img) => {
      if (!img.complete) {
        img.addEventListener("load", update, { once: true });
        img.addEventListener("error", update, { once: true });
      }
    });
    return () => ro.disconnect();
  }, [item, scale]);

  return (
    <div
      ref={wrapRef}
      style={{
        width: "100%",
        overflow: "hidden",
        backgroundColor: "#ffffff",
        // flatTop: 顶部接 hero 内白弧形,无需 border / radius 重复装饰
        borderTop: flatTop ? "none" : "1px solid #e2e8f0",
        borderLeft: "1px solid #e2e8f0",
        borderRight: "1px solid #e2e8f0",
        borderBottom: "1px solid #e2e8f0",
        borderTopLeftRadius: flatTop ? 0 : 18,
        borderTopRightRadius: flatTop ? 0 : 18,
        borderBottomLeftRadius: 18,
        borderBottomRightRadius: 18,
        boxShadow: "0 8px 24px -12px rgba(15,23,42,0.16)",
      }}
    >
      <div
        ref={innerRef}
        style={{
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          width: `${(100 / scale).toFixed(4)}%`,
        }}
      >
        <CardForItem item={item} />
      </div>
    </div>
  );
}

function CardForItem({ item }: { item: Item }) {
  switch (item.source_type) {
    case "x_list":
      return <TweetCard item={item} embedded hideThreadBanner posterMode />;
    case "github":
      return <GithubCard item={item} />;
    case "product_hunt":
      return <PhCard item={item} />;
    case "hf_paper":
      return <HfPaperCard item={item} />;
    case "clawhub":
      return <ClawhubCard item={item} />;
    case "huodongxing":
      return <HuodongxingCard item={item} />;
    case "blog":
      return <BlogCard item={item} eager posterMode />;
    case "podcast":
      return <PodcastCard item={item} eager posterMode />;
    default:
      return (
        <div className="p-6 text-center text-sm text-neutral-500">
          暂不支持该来源的海报渲染
        </div>
      );
  }
}

interface PosterCanvasHandle {
  /** 把当前 DOM 截图为 PNG blob (modern-screenshot 内部 await 字体/图片加载) */
  capture: () => Promise<Blob>;
}

interface Props {
  item: Item;
  shareUrl: string;
  sharerName: string;
  sharerAvatarUrl?: string;
}

/**
 * 隐藏式渲染容器:浏览器需要真实 layout 才能截图,所以放 fixed 屏幕外但
 * 不要 display:none / visibility:hidden,否则 getBoundingClientRect 拿到 0.
 * pointer-events:none 防止误触发内部组件的 click/hover.
 */
export const PosterCanvas = forwardRef<PosterCanvasHandle, Props>(function PosterCanvas(
  { item, shareUrl, sharerName, sharerAvatarUrl },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  // PM 2026-05-25 反馈:有时 user.avatar_url 是 R2 URL 但加载失败 (CORS / 404),
  // 当前三元条件 `sharerAvatarUrl ? <img/> : <fallback/>` 不切回 fallback.
  // 加 state + onError 切到首字母圆 fallback.
  const [avatarFailed, setAvatarFailed] = useState(false);

  const source = SOURCE_LABELS[item.source_type] || {
    label: item.source_type,
    color: "#737373",
  };

  // 生成 QR (固定 200×200 PNG data URL — 显示出来 168 还能保持清晰)
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(shareUrl, {
      width: 200,
      margin: 1,
      color: { dark: "#0f172a", light: "#ffffff" },
      errorCorrectionLevel: "M",
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl("");
      });
    return () => {
      cancelled = true;
    };
  }, [shareUrl]);

  useImperativeHandle(ref, () => ({
    capture: async () => {
      const node = containerRef.current;
      if (!node) throw new Error("poster container missing");
      // 字体已通过 dashboard 加载;但首次保险等一下 fonts.ready,
      // 防止首次保存时字体子集还在异步切片
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
      // 等所有 <img> 加载完 — modern-screenshot 内部也会等,但显式 await
      // 一遍可以兜底 lazy-load / decode 延迟
      const imgs = Array.from(node.querySelectorAll("img"));
      await Promise.all(
        imgs.map(
          (img) =>
            new Promise<void>((resolve) => {
              if (img.complete && img.naturalWidth > 0) return resolve();
              img.addEventListener("load", () => resolve(), { once: true });
              img.addEventListener("error", () => resolve(), { once: true });
              // 兜底 3s 超时,防 hang
              setTimeout(resolve, 3000);
            }),
        ),
      );
      return await domToBlob(node, {
        scale: 2, // 2x for retina (1080 → 2160 实际像素)
        type: "image/png",
        quality: 1,
        backgroundColor: "#ffffff",
        // 兜底:modern-screenshot 默认 timeout 30s — 单张图 fetch 慢 / video 元素
        // 等 loadeddata 时会卡满 30s,体感"一直转圈"。压到 8s,超时的图走库内置
        // placeholder(透明占位)继续出图,海报不再因某张媒体取不到而长时间 hang。
        // (X 视频已在 posterMode 下渲染成 poster <img> 而非 <video>,这里是二道防线:
        //  覆盖 link_card video / PH 视频 poster / GH README 图等任意慢媒体)
        timeout: 8000,
      });
    },
  }));

  const initial = (sharerName || "?").charAt(0).toUpperCase();
  const seed = (sharerName || "x").charCodeAt(0) % 360;

  return (
    <div
      ref={containerRef}
      className="poster-shell"
      style={{
        width: 1080,
        backgroundColor: "#ffffff",
        fontFamily:
          '"HarmonyOS Sans SC", "HarmonyOS_Sans_SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        color: "#0f172a",
        // 隔离内部 hover/cursor 等交互态影响最终截图
        pointerEvents: "none",
      }}
    >
      {/* HERO — PM 2026-05-25 反馈:body 上沿应该跟弧形顶部齐高,hero
          区域不要那么高的空白.总高 260 → 180,svg 占底部 60,body 直接接 */}
      <div
        style={{
          position: "relative",
          width: "100%",
          height: 180,
          background:
            "linear-gradient(135deg, #0b1626 0%, #1a2745 45%, #322152 100%)",
          overflow: "hidden",
        }}
      >
        {/* 紫色泛光 */}
        <div
          style={{
            position: "absolute",
            top: -120,
            right: -80,
            width: 460,
            height: 460,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(141,221,61,0.18) 0%, rgba(141,221,61,0) 70%)",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "absolute",
            bottom: -160,
            left: -60,
            width: 380,
            height: 380,
            borderRadius: "50%",
            background:
              "radial-gradient(circle, rgba(124,58,237,0.28) 0%, rgba(124,58,237,0) 70%)",
            pointerEvents: "none",
          }}
        />
        <div
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            padding: "30px 60px 0",
            gap: 22,
            zIndex: 1,
          }}
        >
          <img
            src={AI_FEEDS_LOGO_DATA_URL}
            alt=""
            style={{
              width: 76,
              height: 76,
              flexShrink: 0,
              display: "block",
            }}
          />
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 46,
                fontWeight: 900,
                color: "#fff",
                letterSpacing: -1.5,
                lineHeight: 1.05,
              }}
            >
              AI-Feeds
            </div>
            <div
              style={{
                marginTop: 4,
                fontSize: 18,
                fontWeight: 600,
                color: "rgba(255,255,255,0.72)",
                letterSpacing: 0.4,
              }}
            >
              专注 AI 领域资讯聚合
            </div>
          </div>
          {/* Source chip 右上 */}
          <div
            style={{
              flexShrink: 0,
              padding: "8px 18px",
              borderRadius: 999,
              backgroundColor: "rgba(255,255,255,0.12)",
              border: "1px solid rgba(255,255,255,0.18)",
              backdropFilter: "blur(6px)",
              color: "#fff",
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: 0.4,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                backgroundColor: source.color,
                display: "inline-block",
              }}
            />
            {source.label}
          </div>
        </div>

        {/* Hero 底部 $\cup$ 弧形 (中间向上凹陷,fill body 灰) — PM 2026-05-25 R6:
            恢复 R3 弧线方向 (R5 改 $\cap$ 是误解,PM 想要 $\cup$).
            white card 用 negative marginTop 上移覆盖 弧形装饰下半,弧形上半仍 visible. */}
        <svg
          viewBox="0 0 1080 60"
          width="1080"
          height="60"
          preserveAspectRatio="none"
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            display: "block",
            pointerEvents: "none",
          }}
        >
          <path d="M 0 60 Q 540 0 1080 60 Z" fill="#f8fafc" />
        </svg>
      </div>

      {/* BODY: white card 上移 30px 覆盖 hero 内弧形装饰下半,
          弧形上半 (中间凹陷顶点 visible 在 white card 之上) — 视觉上
          "白框压在弧线上方". flatTop 让顶部 radius 0 防硬切. */}
      <div
        style={{
          padding: "0 4px 16px",
          backgroundColor: "#f8fafc",
          marginTop: -30,
        }}
      >
        <PosterBody item={item} scale={2.5} flatTop />
      </div>

      {/* FOOTER: sharer + QR */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 28,
          padding: "24px 64px 48px",
          backgroundColor: "#ffffff",
          borderTop: "1px solid #f1f5f9",
        }}
      >
        {/* Sharer 左 */}
        <div style={{ display: "flex", alignItems: "center", gap: 18, flex: 1, minWidth: 0 }}>
          {sharerAvatarUrl && !avatarFailed ? (
            // PM 2026-05-25:之前加 crossOrigin="anonymous" 在 R2 头像
            // 无 ACAO 时会让浏览器拒载;modern-screenshot 内部会处理跨域,
            // 不需要在 <img> 上手动加这个 attr.直接用默认行为兜底.
            // onError → avatarFailed=true 切到首字母圆 fallback.
            <img
              src={sharerAvatarUrl}
              alt=""
              onError={() => setAvatarFailed(true)}
              style={{
                width: 88,
                height: 88,
                borderRadius: "50%",
                backgroundColor: "#e2e8f0",
                objectFit: "cover",
                flexShrink: 0,
              }}
            />
          ) : (
            <div
              style={{
                width: 88,
                height: 88,
                borderRadius: "50%",
                backgroundColor: `hsl(${seed}, 60%, 70%)`,
                color: "#fff",
                fontSize: 36,
                fontWeight: 700,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              {initial}
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: "#0f172a",
                lineHeight: 1.2,
              }}
            >
              {sharerName}
            </div>
          </div>
        </div>

        {/* QR 右 */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 144,
              height: 144,
              backgroundColor: "#fff",
              border: "1px solid rgba(15,23,42,0.08)",
              borderRadius: 14,
              padding: 6,
              boxSizing: "border-box",
            }}
          >
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="QR"
                style={{ width: "100%", height: "100%", display: "block" }}
              />
            ) : (
              <div
                style={{
                  width: "100%",
                  height: "100%",
                  backgroundColor: "#f8fafc",
                }}
              />
            )}
          </div>
          <div
            style={{
              fontSize: 14,
              color: "#94a3b8",
              letterSpacing: 0.4,
            }}
          >
            扫码查看完整内容
          </div>
        </div>
      </div>
    </div>
  );
});

// 把所有 props 整合的便利方法 — 用户身份从 authStore 拿,share_url 从 cachedShare 拿
export interface RenderPosterArgs {
  item: Item;
  shareUrl: string;
  sharerName: string;
  sharerAvatarUrl?: string;
}

export type { PosterCanvasHandle };

/**
 * 调用方拿到 blob 后自己决定下载 / Web Share / preview.
 * 内部:挂载 PosterCanvas 到一个临时 div(屏幕外),capture 后清理.
 *
 * 注意:必须在 React tree 内运行(因为 Card 用了 useDrawer 等 context).
 * 推荐用法是把 <PosterCanvas ref={...}/> 放进 ShareDialog 里持久挂载,
 * 然后调 ref.capture() — 这个函数仅作 fallback (off-tree 场景较少用到).
 */
export async function capturePosterFromRef(
  ref: React.RefObject<PosterCanvasHandle | null>,
): Promise<Blob> {
  if (!ref.current) throw new Error("PosterCanvas not mounted");
  return ref.current.capture();
}
