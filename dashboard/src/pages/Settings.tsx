import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '../lib/authStore';
import { AvatarPlaceholder } from '../components/AvatarPlaceholder';
import { DeleteAccountConfirm } from '../components/DeleteAccountConfirm';
import { resetDeviceId } from '../lib/device';

export function Settings() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const logoutAction = useAuthStore((s) => s.logout);
  const logoutAllAction = useAuthStore((s) => s.logoutAll);
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);

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
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          返回首页
        </button>
      </div>
    );
  }

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
        <h1 className="text-xl font-semibold">设置</h1>
      </header>

      <section className="mb-8">
        <div className="mb-3 flex items-center gap-3">
          <AvatarPlaceholder name={user.display_name} phoneMasked={user.phone_masked ?? undefined} size={48} />
          <div>
            <div className="font-medium">{user.display_name || '未命名用户'}</div>
            <div className="font-mono text-sm text-neutral-500">{user.phone_masked || '—'}</div>
          </div>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-neutral-500">数据</h2>
        <div className="rounded-lg border border-neutral-200">
          <button
            type="button"
            onClick={() => {
              resetDeviceId();
              alert('本地浏览器标识已清除，刷新页面后将重新生成。');
            }}
            className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-neutral-50"
          >
            <span>清除本地浏览器标识</span>
            <span className="text-xs text-neutral-400">device_id</span>
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-rose-600">危险区</h2>
        <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50/50 p-4">
          <button
            type="button"
            onClick={async () => {
              await logoutAction();
              navigate('/');
            }}
            className="block w-full rounded-md border border-neutral-300 bg-white py-2 text-sm font-medium hover:bg-neutral-50"
          >
            退出登录
          </button>
          <button
            type="button"
            onClick={async () => {
              await logoutAllAction();
              navigate('/');
            }}
            className="block w-full rounded-md border border-neutral-300 bg-white py-2 text-sm font-medium hover:bg-neutral-50"
          >
            退出全部设备
          </button>
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="block w-full rounded-md bg-rose-600 py-2 text-sm font-medium text-white hover:bg-rose-700"
          >
            注销账号
          </button>
        </div>
      </section>

      <DeleteAccountConfirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onSuccess={() => navigate('/')}
      />
    </div>
  );
}
