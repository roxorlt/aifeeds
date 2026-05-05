// PR5 share dialog：弹模态框，渲海报预览 + 复制链接 / 三态分发
// 设计：docs/plans/2026-05-04-pr5-share-implementation.md § 5
//
// 行为约定：
// - share 数据**只**信父组件 cache（按 itemId 索引），dialog 不维护内部 share 状态
//   → 杜绝跨 itemId 切换时本地 state 串到不同 token 的可能
// - 未登录由父组件在 click 处理时拦截（openLoginModal + retry 回调），dialog 不再处理鉴权

import { useEffect, useRef, useState } from "react";
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

type Stage = "idle" | "creating" | "ready" | "error";

export function ShareDialog({ open, itemId, cachedShare, onShareCreated, onClose }: Props) {
  // ⚠️ 所有 hooks 必须在任何 early-return 之前声明（React Rules of Hooks）。
  const [stage, setStage] = useState<Stage>("idle");
  const [errMsg, setErrMsg] = useState<string>("");
  const [saving, setSaving] = useState(false);
  // 防止重复触发 createShare 的 itemId 标记（StrictMode 双 effect / 闪进闪出）
  const triggeredRef = useRef<string>("");

  // 状态机：根据 (open, itemId, cachedShare) 决定 stage + 触发 createShare
  // - dialog 关 / itemId 切 → 重置 stage 跟 triggeredRef
  // - dialog 开且当前 itemId 已 cached → ready（直接渲）
  // - dialog 开且 cachedShare 缺 → 触发一次 createShare(itemId)
  useEffect(() => {
    if (!open) {
      setStage("idle");
      setErrMsg("");
      triggeredRef.current = "";
      return;
    }
    if (cachedShare) {
      setStage("ready");
      setErrMsg("");
      return;
    }
    // 同一 itemId 不重复发 createShare（防 StrictMode 双跑 + race）
    if (triggeredRef.current === itemId) return;
    triggeredRef.current = itemId;
    setStage("creating");
    setErrMsg("");
    const requestedItemId = itemId; // 闭包捕获，回调写回前校验当前 itemId
    createShare(itemId)
      .then((res) => {
        onShareCreated(requestedItemId, res);
        // stage 由下一次 render 的 cachedShare 命中分支转 'ready'
      })
      .catch((err) => {
        // 若 itemId 已切换（dialog 关 / 切到别的 item），不再 setStage，避免污染新状态
        if (triggeredRef.current !== requestedItemId) return;
        setErrMsg(err instanceof Error ? err.message : "创建失败");
        setStage("error");
      });
  }, [open, itemId, cachedShare, onShareCreated]);

  if (!open) return null;

  const onCopy = async () => {
    if (!cachedShare) return;
    try {
      await navigator.clipboard.writeText(cachedShare.share_url);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败，请长按链接手动复制");
    }
  };

  const onSavePoster = async () => {
    if (!cachedShare || saving) return;
    setSaving(true);
    try {
      const res = await fetch(cachedShare.poster_url);
      if (!res.ok) throw new Error(`fetch ${res.status}`);
      const blob = await res.blob();
      const filename = `ai-feeds-${cachedShare.token}.png`;
      const file = new File([blob], filename, { type: blob.type || "image/png" });

      const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      const canShareFiles =
        typeof navigator !== "undefined" &&
        typeof (navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean }).canShare === "function"
        && (navigator as Navigator & { canShare: (data: { files: File[] }) => boolean }).canShare({ files: [file] });

      if (isMobile && canShareFiles) {
        await navigator.share({ files: [file] });
        return;
      }

      // PC / 不支持 share-with-files 的移动端：触发下载
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      // 用户取消 share dialog 不算错
      if (e instanceof DOMException && e.name === "AbortError") return;
      toast.error("保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  const onRetry = () => {
    triggeredRef.current = ""; // reset to allow re-trigger via useEffect
    setStage("idle");
    setErrMsg("");
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
          {stage === "ready" && cachedShare && (
            // key 用 token，token 变了 <img> 重挂载，避免 React 复用旧 src 的过渡帧
            <PosterPreview key={cachedShare.token} src={cachedShare.poster_url} />
          )}
          {stage === "error" && (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <p className="text-sm text-red-600">{errMsg}</p>
              <button
                type="button"
                onClick={onRetry}
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
            disabled={!cachedShare}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            复制链接
          </button>
          <button
            type="button"
            onClick={onSavePoster}
            disabled={!cachedShare || stage !== "ready" || saving}
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "保存中…" : "保存海报"}
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

function PosterPreview({ src }: { src: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative">
      {!loaded && <Skeleton hint="海报渲染中…首次约 3-5 秒" />}
      <img
        src={src}
        alt="分享海报"
        className={`mx-auto block w-full max-w-sm rounded-lg shadow-md transition-opacity ${loaded ? "opacity-100" : "opacity-0 absolute inset-0"}`}
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}
