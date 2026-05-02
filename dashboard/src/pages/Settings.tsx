import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '../lib/authStore';
import { AvatarPlaceholder } from '../components/AvatarPlaceholder';
import { LogoutConfirm } from '../components/LogoutConfirm';
import { displayNameOf } from '../lib/defaultProfile';
import { toast } from '../lib/toast';

export function Settings() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const logoutAction = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const [logoutOpen, setLogoutOpen] = useState(false);

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

      <section className="mb-6 rounded-lg border border-neutral-200 bg-white p-4">
        <div className="flex items-center gap-3">
          <AvatarPlaceholder name={name} phoneMasked={user.phone_masked ?? undefined} size={48} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base font-medium text-neutral-900">{name}</div>
            <div className="font-mono text-sm text-neutral-500">{user.phone_masked || '—'}</div>
          </div>
        </div>
      </section>

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
    </div>
  );
}
