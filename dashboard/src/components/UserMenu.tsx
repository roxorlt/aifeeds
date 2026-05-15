import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAuthStore } from "../lib/authStore";
import { avatarUrlOf } from "../lib/defaultProfile";
import { useVideoCoordinator } from "../lib/videoCoordinator";

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

  const prefs = useVideoCoordinator((s) => s.prefs);
  const setPrefs = useVideoCoordinator((s) => s.setPrefs);

  // outside click + Esc 关
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!popRef.current) return;
      if (!popRef.current.contains(e.target as Node)) setOpen(false);
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
  }, [open]);

  // Pre-hydrate placeholder（避免登录态闪烁）
  if (!hydrated) {
    return <div className="h-8 w-8" aria-hidden />;
  }

  const trigger = user ? (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
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
      onClick={() => setOpen((v) => !v)}
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
          className="absolute right-0 top-full z-40 mt-1 w-56 overflow-hidden rounded-lg border border-neutral-200 bg-white py-1 shadow-lg"
        >
          {user ? (
            <div className="border-b border-neutral-100 px-3 py-2 text-xs text-neutral-500 truncate">
              {user.display_name || user.identity_masked || user.id}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
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
            <Switch
              checked={prefs.muted}
              onChange={(v) => setPrefs({ muted: v })}
              label="默认静音"
            />
          </div>

          {user && (
            <div className="border-t border-neutral-100">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate("/settings");
                }}
                className="flex w-full items-center px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                账号设置
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
