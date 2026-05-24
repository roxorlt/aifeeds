// PR5 share dialog:弹模态框,c 端渲染海报 + 复制链接 / 三态分发
// 设计:docs/plans/2026-05-04-pr5-share-implementation.md § 5
//
// PR2 v3 (2026-05-25):海报渲染从 worker /api/share/poster/<token> 切到 c 端
// PosterCanvas (modern-screenshot + 真实 Card 组件 + HarmonyOS Sans SC).
// 视觉跟 dashboard 流内 100% 一致,字体复用浏览器已加载的 hmos.
// worker svg-template 仅保留作 og:image fallback (LinkPreview scan 仍用).
//
// 行为约定:
// - share 数据**只**信父组件 cache (按 itemId 索引),dialog 不维护内部 share 状态
//   → 杜绝跨 itemId 切换时本地 state 串到不同 token 的可能
// - 未登录由父组件在 click 处理时拦截 (openLoginModal + retry 回调),dialog 不再处理鉴权

import { useEffect, useRef, useState } from "react";
import { createShare, type CreateShareResponse } from "../lib/share";
import { toast } from "../lib/toast";
import { PosterCanvas, type PosterCanvasHandle } from "./PosterCanvas";
import { useAuthStore } from "../lib/authStore";
import type { Item } from "../types";

interface Props {
  open: boolean;
  /** PR2 v3: 必须接收完整 item (而非只 itemId) — c 端海报渲染需要完整 item 数据
   *  (extra/media/metrics 等) 喂给 PosterCanvas 内的真实 Card 组件 */
  item: Item;
  /** 父组件提供的缓存(同 itemId 之前已创建过的 share 数据),首次为 null */
  cachedShare: CreateShareResponse | null;
  /** 父组件回写:成功创建后存入 cache,避免下次重新生成 token */
  onShareCreated: (itemId: string, share: CreateShareResponse) => void;
  onClose: () => void;
}

type Stage = "idle" | "creating" | "ready" | "error";

export function ShareDialog({ open, item, cachedShare, onShareCreated, onClose }: Props) {
  const itemId = item.id;
  // ⚠️ 所有 hooks 必须在任何 early-return 之前声明 (React Rules of Hooks)。
  const [stage, setStage] = useState<Stage>("idle");
  const [errMsg, setErrMsg] = useState<string>("");
  const [saving, setSaving] = useState(false);
  // PR2 v3: 海报截图后的 blob URL (用于 modal 内 PNG 预览,所见即所得)
  const [previewUrl, setPreviewUrl] = useState<string>("");
  // 预览阶段:海报 DOM mount 完 → 截图 → 设置 previewUrl
  const [previewing, setPreviewing] = useState(false);
  // 防止重复触发 createShare 的 itemId 标记 (StrictMode 双 effect / 闪进闪出)
  const triggeredRef = useRef<string>("");
  const posterRef = useRef<PosterCanvasHandle>(null);

  const user = useAuthStore((s) => s.user);
  // PM 反馈 2026-05-25 R6:user.display_name 在邮箱登录时 BE 不会自动设置 (默认 null),
  // 用 identity_masked 邮箱前缀 (例 "l***@gmail.com" → "l***") 作为兜底,
  // 比"匿名分享者"更具识别度且不露完整邮箱.手机号登录同理用 phone_masked.
  const sharerName = (() => {
    if (user?.display_name) return user.display_name;
    if (user?.identity_masked) {
      const at = user.identity_masked.indexOf("@");
      return at > 0 ? user.identity_masked.slice(0, at) : user.identity_masked;
    }
    if (user?.phone_masked) return user.phone_masked;
    return "AI-Feeds 用户";
  })();
  const sharerAvatarUrl = user?.avatar_url || undefined;

  // 状态机:根据 (open, itemId, cachedShare) 决定 stage + 触发 createShare
  // - dialog 关 / itemId 切 → 重置 stage 跟 triggeredRef
  // - dialog 开且当前 itemId 已 cached → ready (直接渲)
  // - dialog 开且 cachedShare 缺 → 触发一次 createShare(itemId)
  useEffect(() => {
    if (!open) {
      setStage("idle");
      setErrMsg("");
      triggeredRef.current = "";
      // 关闭时释放上一张 preview blob URL
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl("");
      return;
    }
    if (cachedShare) {
      setStage("ready");
      setErrMsg("");
      return;
    }
    // 同一 itemId 不重复发 createShare (防 StrictMode 双跑 + race)
    if (triggeredRef.current === itemId) return;
    triggeredRef.current = itemId;
    setStage("creating");
    setErrMsg("");
    const requestedItemId = itemId; // 闭包捕获,回调写回前校验当前 itemId
    createShare(itemId)
      .then((res) => {
        onShareCreated(requestedItemId, res);
        // stage 由下一次 render 的 cachedShare 命中分支转 'ready'
      })
      .catch((err) => {
        // 若 itemId 已切换 (dialog 关 / 切到别的 item),不再 setStage,避免污染新状态
        if (triggeredRef.current !== requestedItemId) return;
        // 区分网络错误 vs 业务错误:fetch 抛 TypeError "Failed to fetch" 时给中文提示
        const raw = err instanceof Error ? err.message : "";
        const friendly = err instanceof TypeError || /Failed to fetch|NetworkError/i.test(raw)
          ? "网络异常,请检查网络后重试"
          : (raw || "创建失败");
        setErrMsg(friendly);
        setStage("error");
      });
  // previewUrl 不进依赖 — 它只在卸载时被清,不应触发 re-run 影响 createShare 调度
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, itemId, cachedShare, onShareCreated]);

  // PR2 v3: cachedShare ready 后立即触发 c 端截图,生成 PNG preview
  useEffect(() => {
    if (stage !== "ready" || !cachedShare) return;
    let cancelled = false;
    setPreviewing(true);
    // 等一帧 DOM mount 完成 (PosterCanvas 是同一 render 周期 mount 的)
    const raf = requestAnimationFrame(async () => {
      try {
        // 兜底等 50ms 让 layout 稳定 (主要是字体子集加载)
        await new Promise((r) => setTimeout(r, 50));
        if (cancelled) return;
        if (!posterRef.current) return;
        const blob = await posterRef.current.capture();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
      } catch (e) {
        console.error("[share] poster capture failed", e);
        // 不阻塞 — preview 区显示 fallback 文案
      } finally {
        if (!cancelled) setPreviewing(false);
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  // PM 2026-05-25 第四轮:sharerName / sharerAvatarUrl 进依赖,user 数据
  // hydrate 完后 (fetchMe 返回) 重新截图,确保海报上是登录态完整数据
  }, [stage, cachedShare, sharerName, sharerAvatarUrl]);

  if (!open) return null;

  const onCopy = async () => {
    if (!cachedShare) return;
    try {
      await navigator.clipboard.writeText(cachedShare.share_url);
      toast.success("链接已复制");
    } catch {
      toast.error("复制失败,请长按链接手动复制");
    }
  };

  const onSavePoster = async () => {
    if (!cachedShare || saving) return;
    setSaving(true);
    try {
      // PR2 v3: c 端截图 — 复用预览阶段已挂载的 PosterCanvas,
      // 如果 previewUrl 已经生成就直接 fetch 它转 blob;否则现场截一张
      let blob: Blob;
      if (previewUrl) {
        const res = await fetch(previewUrl);
        blob = await res.blob();
      } else if (posterRef.current) {
        blob = await posterRef.current.capture();
      } else {
        throw new Error("poster not ready");
      }

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

      // PC / 不支持 share-with-files 的移动端:触发下载
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
      console.error("[share] save poster failed", e);
      toast.error("保存失败,请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  const onRetry = () => {
    triggeredRef.current = ""; // reset to allow re-trigger via useEffect
    setStage("idle");
    setErrMsg("");
  };

  // PR2 v3: 海报始终挂载到屏幕外 (cachedShare 一拿到就 mount),
  // 截图后把 PNG blob URL 设到 previewUrl,modal 内 <img> 直接显示。
  // 这样 user 看到的就是即将分享出去的真实海报 (WYSIWYG)。
  const shouldMountPoster = stage === "ready" && cachedShare !== null;

  return (
    <>
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
              <PosterPreview previewUrl={previewUrl} previewing={previewing} />
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
              disabled={!cachedShare || stage !== "ready" || saving || previewing}
              className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? "保存中…" : previewing ? "生成中…" : "保存海报"}
            </button>
          </footer>
        </div>
      </div>

      {/* PR2 v3: 屏幕外渲染容器 — 浏览器必须真实 layout 才能 modern-screenshot 截图,
          放 fixed left:-99999 不影响视觉,pointer-events:none 防止任何意外交互。
          只在 ready 时 mount 避免无效渲染。 */}
      {shouldMountPoster && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            left: -99999,
            top: 0,
            width: 1080,
            pointerEvents: "none",
          }}
        >
          <PosterCanvas
            ref={posterRef}
            item={item}
            shareUrl={cachedShare!.share_url}
            sharerName={sharerName}
            sharerAvatarUrl={sharerAvatarUrl}
          />
        </div>
      )}
    </>
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

function PosterPreview({ previewUrl, previewing }: { previewUrl: string; previewing: boolean }) {
  if (!previewUrl) {
    return <Skeleton hint={previewing ? "海报渲染中…" : "准备中"} />;
  }
  return (
    <img
      src={previewUrl}
      alt="分享海报"
      className="mx-auto block w-full max-w-sm rounded-lg shadow-md"
    />
  );
}
