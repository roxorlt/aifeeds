import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '../lib/authStore';
import { LogoutConfirm } from '../components/LogoutConfirm';
import { AvatarPicker } from '../components/AvatarPicker';
import { displayNameOf, avatarUrlOf } from '../lib/defaultProfile';
import { toast } from '../lib/toast';

export function Settings() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const logoutAction = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false);

  if (!hydrated) {
    return <div className="p-8 text-center text-neutral-500">加载中…</div>;
  }
  if (!user) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <p className="mb-4 text-neutral-700">请先登录</p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
        >
          返回首页
        </button>
      </div>
    );
  }

  const name = displayNameOf(user);
  const avatarSrc = avatarUrlOf(user);
  const usingDefaultName = !user.display_name?.trim();

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-md px-2 py-1 text-neutral-600 hover:bg-neutral-100"
          aria-label="返回"
        >
          ←
        </button>
        <h1 className="text-xl font-semibold text-neutral-900">设置</h1>
      </header>

      {/* Profile 区 */}
      <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-4">
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => setAvatarPickerOpen(true)}
            className="shrink-0 rounded-full ring-2 ring-transparent hover:ring-neutral-200"
            aria-label="更换头像"
          >
            <img
              src={avatarSrc}
              alt=""
              className="h-16 w-16 rounded-full bg-neutral-100 object-cover"
            />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-medium text-neutral-900">{name}</span>
              {usingDefaultName && (
                <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500">默认</span>
              )}
            </div>
            <div className="font-mono text-sm text-neutral-500">{user.phone_masked || '—'}</div>
          </div>
          <button
            type="button"
            onClick={() => toast.info('编辑昵称即将开放')}
            className="shrink-0 rounded-md border border-neutral-300 px-2.5 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
          >
            编辑
          </button>
        </div>
      </section>

      {/* 入口列表 */}
      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
        <button
          type="button"
          onClick={() => navigate('/settings/account')}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-neutral-700 hover:bg-neutral-50"
        >
          <span>账号管理</span>
          <span className="text-neutral-400">›</span>
        </button>
        <div className="border-t border-neutral-100" />
        <button
          type="button"
          onClick={() => setLogoutOpen(true)}
          className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-neutral-700 hover:bg-neutral-50"
        >
          <span>退出登录</span>
          <span className="text-neutral-400">›</span>
        </button>
      </div>

      <LogoutConfirm
        open={logoutOpen}
        onClose={() => setLogoutOpen(false)}
        onConfirm={async () => {
          await logoutAction();
          toast.success('已退出登录');
          setLogoutOpen(false);
          navigate('/');
        }}
      />

      <AvatarPicker
        open={avatarPickerOpen}
        userId={user.id}
        currentSrc={user.avatar_url || null}
        onClose={() => setAvatarPickerOpen(false)}
      />
    </div>
  );
}
