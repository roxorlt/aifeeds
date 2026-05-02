import { useNavigate } from 'react-router';
import { useAuthStore } from '../lib/authStore';
import { AvatarPlaceholder } from './AvatarPlaceholder';
import { displayNameOf } from '../lib/defaultProfile';

export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const openLogin = useAuthStore((s) => s.openLoginModal);
  const navigate = useNavigate();

  // Pre-hydrate placeholder (avoid flash)
  if (!hydrated) {
    return <div className="h-8 w-8" aria-hidden />;
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => openLogin('manual')}
        className="shrink-0 whitespace-nowrap rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800"
      >
        登录
      </button>
    );
  }

  const name = displayNameOf(user);
  return (
    <button
      type="button"
      onClick={() => navigate('/settings')}
      className="rounded-full hover:opacity-80"
      aria-label="账号设置"
    >
      <AvatarPlaceholder name={name} phoneMasked={user.phone_masked ?? undefined} size={32} />
    </button>
  );
}
