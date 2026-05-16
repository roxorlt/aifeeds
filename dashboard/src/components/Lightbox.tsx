import { useEffect, useState } from "react";
import type { MediaItem } from "../types";
import { proxyImg } from "../lib/utils";
import { track, EVENTS } from "../lib/telemetry";

interface Props {
  media: MediaItem[];
  startIndex: number;
  onClose: () => void;
}

export function Lightbox({ media, startIndex, onClose }: Props) {
  const [index, setIndex] = useState(startIndex);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (e.key === "ArrowRight")
        setIndex((i) => Math.min(media.length - 1, i + 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [media.length, onClose]);

  // Lock body scroll while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Telemetry: lightbox open (mount once)
  useEffect(() => {
    track(EVENTS.IMAGE_LIGHTBOX_OPEN, {
      image_index: startIndex,
      images_count: media.length,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = media[index];
  if (!current) return null;

  const go = (delta: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setIndex((i) => Math.max(0, Math.min(media.length - 1, i + delta)));
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90"
      onClick={onClose}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
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
          className="max-h-[90vh] max-w-[92vw]"
          controls
          autoPlay
          playsInline
          onClick={(e) => e.stopPropagation()}
          onError={() => {
            let host = "";
            try { host = new URL(current.url).host; } catch {}
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
          className="max-h-[90vh] max-w-[92vw] object-contain"
          onClick={(e) => e.stopPropagation()}
          onError={() => {
            let host = "";
            try { host = new URL(current.url).host; } catch {}
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
