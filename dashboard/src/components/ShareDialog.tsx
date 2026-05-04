// PR5 share dialog：弹模态框，渲海报预览 + 复制链接 / 三态分发
// 设计：docs/plans/2026-05-04-pr5-share-implementation.md § 5

import { useEffect, useRef, useState } from "react";
import { createShare, type CreateShareResponse } from "../lib/share";
import { toast } from "../lib/toast";
import { useAuthStore } from "../lib/authStore";

interface Props {
  open: boolean;
  itemId: string;
  itemTitle?: string;
  onClose: () => void;
}

type Stage = "idle" | "creating" | "rendering" | "ready" | "error";

export function ShareDialog({ open, itemId, itemTitle, onClose }: Props) {
  const [stage, setStage] = useState<Stage>("idle");
  const [share, setShare] = useState<CreateShareResponse | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");
  const triggeredRef = useRef<string>("");
  const user = useAuthStore((s) => s.user);
  const openLoginModal = useAuthStore((s) => s.openLoginModal);

  useEffect(() => {
    // 关闭时清状态
    if (!open) {
      setStage("idle");
      setShare(null);
      setErrMsg("");
      triggeredRef.current = "";
      return;
    }
    // 未登录 → 提示并触发登录
    if (!user) {
      onClose();
      openLoginModal("manual");
      toast.info("登录后即可生成分享海报");
      return;
    }
    // 同一 itemId 不重复创建
    if (triggeredRef.current === itemId) return;
    triggeredRef.current = itemId;
    setStage("creating");
    setErrMsg("");
    createShare(itemId)
      .then((res) => {
        setShare(res);
        setStage("rendering");
      })
      .catch((err) => {
        setErrMsg(err instanceof Error ? err.message : "创建失败");
        setStage("error");
      });
  }, [open, itemId, user, openLoginModal, onClose]);

  if (!open) return null;
  if (!user) return null;

  const onCopy = async () => {
    if (!share) return;
    try {
      await navigator.clipboard.writeText(share.share_url);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败，请长按链接手动复制");
    }
  };

  const onSavePoster = () => {
    if (!share) return;
    // 触发浏览器下载（PC 场景）
    const a = document.createElement("a");
    a.href = share.poster_url;
    a.download = `ai-feeds-${share.token}.png`;
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-neutral-900">分享 · 生成海报</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto bg-neutral-50 p-4">
          {itemTitle && (
            <div className="mb-3 truncate text-xs text-neutral-500" title={itemTitle}>
              {itemTitle}
            </div>
          )}

          {stage === "creating" && <Skeleton hint="正在生成短链…" />}
          {stage === "rendering" && share && (
            <PosterPreview
              src={share.poster_url}
              onLoaded={() => setStage("ready")}
              onError={() => {
                setErrMsg("海报渲染失败");
                setStage("error");
              }}
            />
          )}
          {stage === "ready" && share && (
            <PosterPreview src={share.poster_url} onLoaded={() => undefined} onError={() => undefined} />
          )}
          {stage === "error" && (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <p className="text-sm text-red-600">{errMsg}</p>
              <button
                type="button"
                onClick={() => {
                  triggeredRef.current = "";
                  setStage("idle");
                  setTimeout(() => {
                    triggeredRef.current = itemId;
                    setStage("creating");
                    createShare(itemId)
                      .then((res) => { setShare(res); setStage("rendering"); })
                      .catch((err) => {
                        setErrMsg(err instanceof Error ? err.message : "创建失败");
                        setStage("error");
                      });
                  }, 0);
                }}
                className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                重试
              </button>
            </div>
          )}
        </div>

        <footer className="flex flex-col gap-2 border-t border-neutral-100 bg-white px-4 py-3">
          {share && (
            <div className="truncate rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600" title={share.share_url}>
              {share.share_url}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onCopy}
              disabled={!share}
              className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              复制链接
            </button>
            <button
              type="button"
              onClick={onSavePoster}
              disabled={!share || stage !== "ready"}
              className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              保存海报
            </button>
          </div>
          <p className="text-center text-[11px] text-neutral-400">
            微信内：长按海报保存图片 · PC：直接保存
          </p>
        </footer>
      </div>
    </div>
  );
}

function Skeleton({ hint }: { hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-900" />
      <p className="text-xs text-neutral-500">{hint}</p>
    </div>
  );
}

function PosterPreview({
  src,
  onLoaded,
  onError,
}: {
  src: string;
  onLoaded: () => void;
  onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative">
      {!loaded && <Skeleton hint="海报渲染中…首次约 3-5 秒" />}
      <img
        src={src}
        alt="分享海报"
        className={`mx-auto block w-full max-w-sm rounded-lg shadow-md transition-opacity ${loaded ? "opacity-100" : "opacity-0 absolute inset-0"}`}
        onLoad={() => {
          setLoaded(true);
          onLoaded();
        }}
        onError={onError}
      />
    </div>
  );
}
