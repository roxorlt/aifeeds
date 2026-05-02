import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '../lib/authStore';
import { AvatarPlaceholder } from './AvatarPlaceholder';
import { track, EVENTS } from '../lib/telemetry';

export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const openLogin = useAuthStore((s) => s.openLoginModal);
  const logoutAction = useAuthStore((s) => s.logout);
  const logoutAllAction = useAuthStore((s) => s.logoutAll);
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 点 outside 关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // 还没 hydrate 完，按空 placeholder 占位（avoid flash）
  if (!hydrated) {
    return <div className="h-8 w-8" aria-hidden />;
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => openLogin('manual')}
        className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
      >
        登录
      </button>
    );
  }

  const handleLogout = async () => {
    setOpen(false);
    track(EVENTS.LOGOUT, { logout_all: false });
    await logoutAction();
  };
  const handleLogoutAll = async () => {
    setOpen(false);
    track(EVENTS.LOGOUT, { logout_all: true });
    await logoutAllAction();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-full hover:opacity-80"
        aria-label="账号菜单"
      >
        <AvatarPlaceholder name={user.display_name} phoneMasked={user.phone_masked ?? undefined} size={32} />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-56 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
          <div className="border-b border-neutral-100 px-3 py-2">
            <div className="text-sm font-medium text-neutral-900 truncate">
              {user.display_name || '未命名用户'}
            </div>
            <div className="font-mono text-xs text-neutral-500">{user.phone_masked || '—'}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate('/settings');
            }}
            className="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50"
          >
            ⚙ 设置
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50"
          >
            ↩ 退出登录
          </button>
          <button
            type="button"
            onClick={handleLogoutAll}
            className="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50"
          >
            ↩ 退出全部设备
          </button>
        </div>
      )}
    </div>
  );
}
