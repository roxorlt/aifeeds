import { useEffect, useRef, useState } from "react";
import type { MediaItem } from "../types";
import { proxyImg } from "../lib/utils";
import { track, EVENTS } from "../lib/telemetry";
import { useScrollLock, useTouchScrollGuard } from "../lib/useScrollLock";
import { useMotionDismiss } from "../lib/motionLayer";
import { activateModalFocus } from "../lib/modalFocus";

interface Props {
  media: MediaItem[];
  startIndex: number;
  onClose: () => void;
}

export function Lightbox({ media, startIndex, onClose }: Props) {
  const [index, setIndex] = useState(startIndex);
  const overlayRef = useRef<HTMLDivElement>(null);
  const { layerClassName, requestClose } = useMotionDismiss(onClose, "lightbox");
  const current = media[index];
  const modalOpen = Boolean(current);
  const escapeCloseRef = useRef(onClose);

  useEffect(() => {
    escapeCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!modalOpen) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    return activateModalFocus(overlay, {
      onEscape: () => escapeCloseRef.current(),
    });
  }, [modalOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight")
        setIndex((i) => Math.min(media.length - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [media.length]);

  // Lock page scroll + stop touch bleed while open.
  //
  // The old code only set `document.body.style.overflow = "hidden"`, which is a
  // no-op on mobile (≤767px): the app makes <body> permanently overflow:hidden
  // and scrolls via #root, so swipes on the lightbox scrolled the page / drawer
  // body underneath (scroll penetration on iOS WKWebView + WeChat X5).
  //   - useScrollLock locks the real scroller (#root on mobile, <body> on PC).
  //   - useTouchScrollGuard kills the residual touch bleed that iOS/X5 still
  //     let through, while leaving the <video> controls draggable.
  useScrollLock();
  useTouchScrollGuard(overlayRef);

  // Telemetry: lightbox open (mount once)
  useEffect(() => {
    track(EVENTS.IMAGE_LIGHTBOX_OPEN, {
      image_index: startIndex,
      images_count: media.length,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!current) return null;

  const go = (delta: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setIndex((i) => Math.max(0, Math.min(media.length - 1, i + delta)));
  };

  // 蒙层 / 关闭按钮的 click + pointer/mouse down 全部 stopPropagation +
  // preventDefault。Lightbox 渲染在 TweetCard <article> 子树内，未阻断
  // 冒泡会触发 article 的 onPointerDown 记录 downPos 并被 click handler
  // 当成卡片点击，弹出抽屉穿透 bug。
  const stopBubble = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  const onOverlayClick = (e: React.MouseEvent) => {
    stopBubble(e);
    requestClose();
  };

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      className={`${layerClassName} fixed inset-0 z-50 flex items-center justify-center bg-black/90`}
      role="dialog"
      aria-modal="true"
      aria-label="媒体预览"
      onClick={onOverlayClick}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        onClick={onOverlayClick}
        data-modal-initial-focus
        className="absolute right-4 top-4 text-2xl text-white/70 hover:text-white"
        aria-label="关闭"
      >
        ✕
      </button>

      {media.length > 1 && (
        <>
          <button
            type="button"
            onClick={go(-1)}
            disabled={index === 0}
            className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 px-3 py-2 text-2xl text-white/80 hover:bg-black/60 disabled:opacity-30 sm:left-6"
            aria-label="上一张"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={go(1)}
            disabled={index === media.length - 1}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 px-3 py-2 text-2xl text-white/80 hover:bg-black/60 disabled:opacity-30 sm:right-6"
            aria-label="下一张"
          >
            ›
          </button>
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-xs text-white/80">
            {index + 1} / {media.length}
          </div>
        </>
      )}

      {current.type === "video" ? (
        <video
          key={current.url}
          src={proxyImg(current.url)}
          poster={current.poster ? proxyImg(current.poster, 400) : undefined}
          className="motion-layer-panel max-h-[90vh] max-w-[92vw]"
          controls
          autoPlay
          playsInline
          onClick={(e) => e.stopPropagation()}
          onError={() => {
            let host = "";
            try { host = new URL(current.url).host; } catch {
              // 非法 URL 仍按空 host 上报，图片降级流程继续执行。
            }
            track(EVENTS.IMAGE_LOAD_ERROR, {
              url_host: host,
              source: "lightbox-video",
            });
          }}
        />
      ) : (
        <img
          src={proxyImg(current.url)}
          alt={current.alt || ""}
          className="motion-layer-panel max-h-[90vh] max-w-[92vw] object-contain"
          onClick={(e) => e.stopPropagation()}
          onError={() => {
            let host = "";
            try { host = new URL(current.url).host; } catch {
              // 非法 URL 仍按空 host 上报，图片降级流程继续执行。
            }
            track(EVENTS.IMAGE_LOAD_ERROR, {
              url_host: host,
              source: "lightbox",
            });
          }}
        />
      )}
    </div>
  );
}
