import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuthStore } from "../lib/authStore";
import { avatarUrlOf } from "../lib/defaultProfile";
import { useVideoCoordinator } from "../lib/videoCoordinator";
import { isWeChatBrowser } from "../lib/wechat";
import { useFeedbackUnreadStore } from "../api";
import { useMotionDismiss } from "../lib/motionLayer";

// 对话气泡 icon — lucide MessageSquare 同款，1.6 stroke 跟全站 icon 风格统一
function IconMessageSquare({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// 齿轮 icon — lucide Settings 同款，1.5 stroke 跟全站 icon 风格统一
function IconSettings({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  );
}

// 极简 toggle switch — 跟全站 neutral 调色一致
function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between rounded-md px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
    >
      <span>{label}</span>
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? "bg-neutral-900" : "bg-neutral-300"}`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`}
        />
      </span>
    </button>
  );
}

export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const openLogin = useAuthStore((s) => s.openLoginModal);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const { layerClassName, requestClose } = useMotionDismiss(
    () => setOpen(false),
    "popover",
    open,
  );

  const prefs = useVideoCoordinator((s) => s.prefs);
  const setPrefs = useVideoCoordinator((s) => s.setPrefs);

  // 用户反馈入口 gating（1.1/1.2）：登录 + 非微信浏览器才展示。
  const showFeedback = !!user && !isWeChatBrowser();
  const unread = useFeedbackUnreadStore((s) => s.unread);
  // 登录态确定后拉一次未读回复数（§5.7：不轮询，只在 hydrate 成功后拉一次）。
  useEffect(() => {
    if (hydrated && user && !isWeChatBrowser()) {
      useFeedbackUnreadStore.getState().loadUnread();
    }
  }, [hydrated, user]);

  // outside click + Esc 关
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) requestClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, requestClose]);

  // Pre-hydrate placeholder（避免登录态闪烁）
  if (!hydrated) {
    return <div className="h-8 w-8" aria-hidden />;
  }

  const trigger = user ? (
    <button
      type="button"
      onClick={() => open ? requestClose() : setOpen(true)}
      className="flex h-8 w-8 shrink-0 items-center justify-center self-center rounded-full hover:opacity-80"
      aria-label="账号菜单"
      aria-haspopup="menu"
      aria-expanded={open}
    >
      <img
        src={avatarUrlOf(user)}
        alt=""
        width={32}
        height={32}
        className="block h-8 w-8 rounded-full bg-neutral-100 object-cover ring-1 ring-neutral-200"
      />
    </button>
  ) : (
    <button
      type="button"
      onClick={() => open ? requestClose() : setOpen(true)}
      className="flex h-8 w-8 shrink-0 items-center justify-center self-center rounded-md text-neutral-700 hover:bg-neutral-100 hover:text-neutral-900"
      aria-label="设置"
      aria-haspopup="menu"
      aria-expanded={open}
    >
      <IconSettings className="h-5 w-5" />
    </button>
  );

  return (
    <div className="relative" ref={popRef}>
      {trigger}
      {open && (
        <div
          role="menu"
          className={`${layerClassName} absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg`}
        >
          {user ? (
            <div className="border-b border-neutral-100 px-3 py-2 text-xs text-neutral-500 truncate">
              {user.display_name || user.identity_masked || user.id}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                requestClose();
                openLogin("manual");
              }}
              className="flex w-full items-center justify-center gap-2 border-b border-neutral-100 bg-neutral-900 px-3 py-2 text-sm font-medium text-white hover:bg-neutral-800"
            >
              登录
            </button>
          )}

          <div className="py-1">
            <Switch
              checked={prefs.autoplay}
              onChange={(v) => setPrefs({ autoplay: v })}
              label="自动播放视频"
            />
            {/* "默认静音"开关已删除（2026-05-15）：浏览器自动播放策略
                强制 muted autoplay，user 显式设 muted=false 也会被浏览器
                内核覆盖。设置项给不了实际控制，反而误导。
                业界做法（X / Instagram）：永远默认静音，user 在 video
                native controls 上点 unmute 后当前 session 内 sticky。 */}
          </div>

          <div className="border-t border-neutral-100">
            <button
              type="button"
              onClick={() => {
                requestClose();
                navigate(user ? "/me/subscription" : "/subscribe");
              }}
              className="flex w-full items-center px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              订阅推送
            </button>
            {user && (
              <button
                type="button"
                onClick={() => {
                  requestClose();
                  navigate("/settings");
                }}
                className="flex w-full items-center px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                账号设置
              </button>
            )}
            {showFeedback && (
              <button
                type="button"
                onClick={() => {
                  requestClose();
                  navigate("/feedback");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                <IconMessageSquare className="h-4 w-4 shrink-0 text-neutral-500" />
                <span>用户反馈</span>
                {unread > 0 && (
                  <span
                    className="ml-auto h-2 w-2 shrink-0 rounded-full bg-rose-500"
                    aria-label="有新回复"
                  />
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
