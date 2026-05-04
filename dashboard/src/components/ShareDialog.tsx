// PR5 share dialog：弹模态框，渲海报预览 + 复制链接 / 三态分发
// 设计：docs/plans/2026-05-04-pr5-share-implementation.md § 5
//
// 行为约定：
// - share 数据由父组件（drawer）按 itemId 缓存并传入；同 itemId 重开不换 token
// - 未登录由父组件在 click 处理时拦截（openLoginModal + retry 回调），dialog 不再处理鉴权

import { useEffect, useState } from "react";
import { createShare, type CreateShareResponse } from "../lib/share";
import { toast } from "../lib/toast";

interface Props {
  open: boolean;
  itemId: string;
  /** 父组件提供的缓存（同 itemId 之前已创建过的 share 数据），首次为 null */
  cachedShare: CreateShareResponse | null;
  /** 父组件回写：成功创建后存入 cache，避免下次重新生成 token */
  onShareCreated: (itemId: string, share: CreateShareResponse) => void;
  onClose: () => void;
}

type Stage = "idle" | "creating" | "rendering" | "ready" | "error";

export function ShareDialog({ open, itemId, cachedShare, onShareCreated, onClose }: Props) {
  const [stage, setStage] = useState<Stage>("idle");
  const [share, setShare] = useState<CreateShareResponse | null>(cachedShare);
  const [errMsg, setErrMsg] = useState<string>("");

  // 同步父组件 cache：itemId 切换或 cachedShare 更新时拉进来
  useEffect(() => {
    setShare(cachedShare);
    if (cachedShare) {
      setStage("ready");
    } else {
      setStage("idle");
    }
    setErrMsg("");
  }, [itemId, cachedShare]);

  // open 切换为 true 且尚无 share → 触发创建
  useEffect(() => {
    if (!open) return;
    if (cachedShare) return; // 已有缓存，不重复创建
    if (stage === "creating" || stage === "rendering") return;
    setStage("creating");
    setErrMsg("");
    createShare(itemId)
      .then((res) => {
        setShare(res);
        setStage("rendering");
        onShareCreated(itemId, res);
      })
      .catch((err) => {
        setErrMsg(err instanceof Error ? err.message : "创建失败");
        setStage("error");
      });
    // 故意不监听 stage：避免 stage→creating 触发自身重入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId, cachedShare]);

  if (!open) return null;

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
          <h3 className="text-sm font-semibold text-neutral-900">分享</h3>
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
                  setStage("creating");
                  setErrMsg("");
                  createShare(itemId)
                    .then((res) => { setShare(res); setStage("rendering"); onShareCreated(itemId, res); })
                    .catch((err) => {
                      setErrMsg(err instanceof Error ? err.message : "创建失败");
                      setStage("error");
                    });
                }}
                className="rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                重试
              </button>
            </div>
          )}
        </div>

        <footer className="grid grid-cols-2 gap-2 border-t border-neutral-100 bg-white px-4 py-3">
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
