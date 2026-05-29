import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { SourceIcon } from '../components/icons';
import { TurnstileWidget, type TurnstileWidgetHandle } from '../components/TurnstileWidget';
import {
  subscribeDigest,
  configureSubscription,
  getMySubscription,
  updateMySubscription,
  unsubscribeMySubscription,
  type DigestSourceKey,
  type DigestSlot,
  type DigestDensity,
  type SubscribeErrorCode,
  type SubscriptionData,
} from '../api';
import { toast } from '../lib/toast';
import { cn } from '../lib/utils';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 订阅源固定顺序 + 展示元数据。key 为 BE 契约源 key；sourceType 映射到全站
// SourceIcon 内部命名（两套命名不同，见 CLAUDE.md 字段映射）。label 对齐 App.tsx
// FILTER_CHIPS，与首页频道一致。
interface SourceMeta {
  key: DigestSourceKey;
  sourceType: string;
  label: string;
  desc: string;
}
const DIGEST_SOURCES: SourceMeta[] = [
  { key: 'ph', sourceType: 'product_hunt', label: '热门产品', desc: 'Product Hunt 每日新品' },
  { key: 'gh', sourceType: 'github', label: '开源项目', desc: 'GitHub 趋势仓库' },
  { key: 'hf-paper', sourceType: 'hf_paper', label: '论文', desc: 'arXiv / HuggingFace 精选' },
  { key: 'clawhub', sourceType: 'clawhub', label: '龙虾技能', desc: 'ClawHub Claude 技能' },
  { key: 'x', sourceType: 'x_list', label: '动态', desc: 'X 平台 AI 推文' },
];

const SLOTS: { value: DigestSlot; label: string }[] = [
  { value: 8, label: '早 8:00' },
  { value: 12, label: '午 12:00' },
  { value: 17, label: '下午 17:00' },
];

const DENSITIES: { value: DigestDensity; label: string }[] = [
  { value: 'normal', label: '默认5条' },
  { value: 'curated', label: '精选3条' },
];

function slotLabel(slot: DigestSlot): string {
  return SLOTS.find((s) => s.value === slot)?.label ?? `${slot}:00`;
}

function IconCheck({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function PageShell({ title, children }: { title: string; children: ReactNode }) {
  const navigate = useNavigate();
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
        <h1 className="text-xl font-semibold text-neutral-900">{title}</h1>
      </header>
      {children}
    </div>
  );
}

// 共享偏好选择：订阅源 / 推送时间 / 内容密度。匿名订阅与登录态管理共用。
function PreferenceFields({
  sources,
  setSources,
  slot,
  setSlot,
  density,
  setDensity,
  sourcesError,
}: {
  sources: DigestSourceKey[];
  setSources: (next: DigestSourceKey[]) => void;
  slot: DigestSlot;
  setSlot: (next: DigestSlot) => void;
  density: DigestDensity;
  setDensity: (next: DigestDensity) => void;
  sourcesError?: string;
}) {
  const toggle = (k: DigestSourceKey) => {
    setSources(sources.includes(k) ? sources.filter((s) => s !== k) : [...sources, k]);
  };

  return (
    <>
      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-neutral-700">订阅源</h2>
        <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
          {DIGEST_SOURCES.map((s) => {
            const selected = sources.includes(s.key);
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => toggle(s.key)}
                aria-pressed={selected}
                className="flex w-full items-center gap-3 border-b border-neutral-100 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-neutral-50/60"
              >
                <SourceIcon
                  source_type={s.sourceType}
                  className="h-5 w-5 shrink-0 fill-current text-neutral-700"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-neutral-900">{s.label}</div>
                  <div className="text-xs text-neutral-500">{s.desc}</div>
                </div>
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors',
                    selected
                      ? 'border-neutral-900 bg-neutral-900 text-white'
                      : 'border-neutral-300 text-transparent',
                  )}
                >
                  <IconCheck className="h-3 w-3" />
                </span>
              </button>
            );
          })}
        </div>
        {sourcesError && <p className="mt-1 text-xs text-rose-600">{sourcesError}</p>}
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-neutral-700">推送时间</h2>
        <div className="flex flex-wrap gap-2">
          {SLOTS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSlot(s.value)}
              className={cn(
                'rounded-md border px-3.5 py-1.5 text-sm font-medium transition-colors',
                slot === s.value
                  ? 'border-neutral-900 bg-neutral-900 text-white'
                  : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-2 text-sm font-medium text-neutral-700">内容密度</h2>
        <div className="flex flex-wrap gap-2">
          {DENSITIES.map((d) => (
            <button
              key={d.value}
              type="button"
              onClick={() => setDensity(d.value)}
              className={cn(
                'rounded-md border px-3.5 py-1.5 text-sm font-medium transition-colors',
                density === d.value
                  ? 'border-neutral-900 bg-neutral-900 text-white'
                  : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50',
              )}
            >
              {d.label}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

// ─── 匿名订阅 /subscribe（两步：先填邮箱一键订阅，再可选精调）──────────────
const DEFAULT_SOURCES: DigestSourceKey[] = DIGEST_SOURCES.map((s) => s.key);
const DEFAULT_SLOT: DigestSlot = 8;
const DEFAULT_DENSITY: DigestDensity = 'normal';

function AnonymousSubscribe() {
  const navigate = useNavigate();
  // step:'email' 只填邮箱 + 人机校验，按默认配置（全选 / 早8 / 默认档）一键订阅
  //   → 'config' 已订阅成功，可选精调（用 edit_token 改偏好）→ 'done'
  const [step, setStep] = useState<'email' | 'config' | 'done'>('email');
  const [email, setEmail] = useState('');
  const [submittedEmail, setSubmittedEmail] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileError, setTurnstileError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);
  const [editToken, setEditToken] = useState<string | null>(null);
  const [doneKind, setDoneKind] = useState<'active' | 'pending_confirm'>('active');
  const turnstileRef = useRef<TurnstileWidgetHandle>(null);

  // 第二页精调偏好，预填默认值；用户不改也没关系，已按默认订阅
  const [sources, setSources] = useState<DigestSourceKey[]>(DEFAULT_SOURCES);
  const [slot, setSlot] = useState<DigestSlot>(DEFAULT_SLOT);
  const [density, setDensity] = useState<DigestDensity>(DEFAULT_DENSITY);
  const [sourcesError, setSourcesError] = useState('');
  const [saving, setSaving] = useState(false);

  function applyError(code: SubscribeErrorCode) {
    switch (code) {
      case 'invalid_email':
        setEmailError('请输入正确的邮箱');
        break;
      case 'turnstile_failed':
        setFormError('人机验证失败，请重试');
        turnstileRef.current?.reset();
        setTurnstileToken(null);
        break;
      case 'rate_limited':
        setFormError('请求过于频繁，请稍后再试');
        break;
      // invalid_sources / invalid_slot：第一步用默认配置不会触发，归兜底
      default:
        setFormError('服务暂时不可用，请稍后重试');
    }
  }

  // 第一步：只校验邮箱 + 人机校验，按默认配置一键订阅
  async function handleSubscribe() {
    setEmailError('');
    setFormError('');
    const trimmed = email.trim().toLowerCase();
    if (!EMAIL_REGEX.test(trimmed)) {
      setEmailError('请输入正确的邮箱');
      return;
    }
    if (!turnstileToken) {
      setFormError('请先完成人机验证');
      return;
    }
    setLoading(true);
    try {
      const r = await subscribeDigest({
        email: trimmed,
        sources: DEFAULT_SOURCES,
        send_slot: DEFAULT_SLOT,
        density: DEFAULT_DENSITY,
        turnstile_token: turnstileToken,
      });
      if (r.ok) {
        setSubmittedEmail(trimmed);
        if (r.status === 'pending_confirm') {
          // 曾退订重订 → 不直接激活，跳过精调，提示已发确认邮件
          setDoneKind('pending_confirm');
          setStep('done');
        } else {
          setEditToken(r.edit_token ?? null);
          setDoneKind('active');
          setStep('config'); // 已按默认订阅成功，进第二页可选精调
        }
      } else {
        applyError(r.code);
      }
    } catch {
      setFormError('订阅失败，请稍后重试');
    } finally {
      setLoading(false);
    }
  }

  // 第二步（可选）：用 edit_token 改偏好。无 token / 失效 → 已按默认订阅，引导登录后改
  async function handleSaveConfig() {
    setSourcesError('');
    if (sources.length === 0) {
      setSourcesError('请至少选择一个订阅源');
      return;
    }
    if (!editToken) {
      toast.info('已按默认订阅；如需调整可登录后在「订阅推送」里修改');
      setStep('done');
      return;
    }
    setSaving(true);
    try {
      const r = await configureSubscription({ edit_token: editToken, sources, send_slot: slot, density });
      if (r.ok) {
        toast.success('偏好已保存');
        setStep('done');
      } else if (r.code === 'invalid_sources') {
        setSourcesError('请至少选择一个订阅源');
      } else if (r.code === 'invalid_token' || r.code === 'expired_token') {
        toast.info('调整链接已过期，已按默认订阅；可登录后再改');
        setStep('done');
      } else {
        toast.error('保存失败，请稍后重试');
      }
    } catch {
      toast.error('保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  }

  // ── 第三步：完成 ──
  if (step === 'done') {
    const active = doneKind === 'active';
    return (
      <PageShell title="订阅推送">
        <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center">
          <h2 className="text-base font-medium text-neutral-900">
            {active ? '订阅成功' : '确认邮件已发送'}
          </h2>
          <p className="mt-2 text-sm text-neutral-600">
            {active ? (
              <>
                日报邮件将在 {slotLabel(slot)} 推送到{' '}
                <span className="font-medium text-neutral-900">{submittedEmail}</span>。
              </>
            ) : (
              <>
                你之前退订过本推送。我们已发送确认邮件到{' '}
                <span className="font-medium text-neutral-900">{submittedEmail}</span>，请点击邮件中的链接完成重新订阅。
              </>
            )}
          </p>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            返回首页
          </button>
        </div>
      </PageShell>
    );
  }

  // ── 第二步：可选精调 ──
  if (step === 'config') {
    return (
      <PageShell title="订阅推送">
        <div className="mb-6 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
          <h2 className="text-base font-medium text-neutral-900">订阅成功！</h2>
          <p className="mt-1 text-sm text-neutral-600">
            邮件将在每天早 8 点推送。如需对推送内容和时间做精细定制，可在下面调整。
          </p>
        </div>

        <PreferenceFields
          sources={sources}
          setSources={setSources}
          slot={slot}
          setSlot={setSlot}
          density={density}
          setDensity={setDensity}
          sourcesError={sourcesError}
        />

        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={handleSaveConfig}
            disabled={saving || sources.length === 0}
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存偏好'}
          </button>
          <button
            type="button"
            onClick={() => setStep('done')}
            className="text-sm text-neutral-500 hover:text-neutral-700"
          >
            暂不调整
          </button>
        </div>
      </PageShell>
    );
  }

  // ── 第一步：只填邮箱 ──
  const submitDisabled = loading || !email || !turnstileToken;

  return (
    <PageShell title="订阅推送">
      <p className="mb-6 text-sm text-neutral-600">
        填入邮箱即可订阅，我们每天把过去 24 小时的多源 AI 精华推到你邮箱。首封推送即欢迎邮件，随时可一键退订。订阅后还能精调来源和推送时间。
      </p>

      <section className="mb-6">
        <label className="mb-1 block text-sm text-neutral-700">邮箱</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value.slice(0, 254))}
          placeholder="请输入邮箱"
          className="w-full rounded-md border border-neutral-300 px-3 py-2 text-base placeholder:text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none"
          autoComplete="email"
        />
        {emailError && <p className="mt-1 text-xs text-rose-600">{emailError}</p>}
      </section>

      <section className="mb-6">
        <TurnstileWidget
          ref={turnstileRef}
          className="flex justify-center"
          onToken={(t) => {
            setTurnstileToken(t);
            setTurnstileError('');
          }}
          onError={(m) => {
            setTurnstileToken(null);
            setTurnstileError(m);
          }}
          onExpire={() => setTurnstileToken(null)}
        />
        {turnstileError && <p className="mt-1 text-center text-xs text-rose-600">{turnstileError}</p>}
      </section>

      {formError && <p className="mb-3 text-xs text-rose-600">{formError}</p>}

      <button
        type="button"
        onClick={handleSubscribe}
        disabled={submitDisabled}
        className="w-full rounded-md bg-neutral-900 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {loading ? '订阅中…' : '订阅'}
      </button>

      <p className="mt-4 text-center text-[11px] text-neutral-500">
        订阅即同意{' '}
        <a
          href="/privacy.html"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-neutral-700"
        >
          隐私政策
        </a>{' '}
        和{' '}
        <a
          href="/terms.html"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-neutral-700"
        >
          服务条款
        </a>
      </p>
    </PageShell>
  );
}

// ─── 登录态管理 /me/subscription ─────────────────────────────────────
function ManageSubscription() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [sub, setSub] = useState<SubscriptionData | null>(null);

  const [sources, setSources] = useState<DigestSourceKey[]>([]);
  const [slot, setSlot] = useState<DigestSlot>(8);
  const [density, setDensity] = useState<DigestDensity>('normal');
  const [sourcesError, setSourcesError] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingUnsub, setConfirmingUnsub] = useState(false);
  const [unsubscribing, setUnsubscribing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const { subscription } = await getMySubscription();
      setSub(subscription);
      if (subscription) {
        setSources(subscription.sources);
        setSlot(subscription.send_slot);
        setDensity(subscription.density);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    setSourcesError('');
    if (sources.length === 0) {
      setSourcesError('请至少选择一个订阅源');
      return;
    }
    setSaving(true);
    try {
      const r = await updateMySubscription({ sources, send_slot: slot, density });
      if (r.ok) {
        toast.success('已保存');
        setSub((prev) => (prev ? { ...prev, sources, send_slot: slot, density } : prev));
      } else if (r.code === 'not_subscribed') {
        toast.error('订阅已失效，请重新订阅');
        load();
      } else if (r.code === 'invalid_sources') {
        setSourcesError('请至少选择一个订阅源');
      } else {
        toast.error('保存失败，请稍后重试');
      }
    } catch {
      toast.error('保存失败，请稍后重试');
    } finally {
      setSaving(false);
    }
  }

  async function handleUnsubscribe() {
    setUnsubscribing(true);
    try {
      const r = await unsubscribeMySubscription();
      if (r.ok) {
        toast.success('已退订');
        setSub((prev) => (prev ? { ...prev, status: 'unsubscribed' } : prev));
        setConfirmingUnsub(false);
      } else {
        toast.error('退订失败，请稍后重试');
      }
    } catch {
      toast.error('退订失败，请稍后重试');
    } finally {
      setUnsubscribing(false);
    }
  }

  if (loading) {
    return (
      <PageShell title="订阅推送">
        <div className="py-12 text-center text-sm text-neutral-500">加载中…</div>
      </PageShell>
    );
  }

  if (loadError) {
    return (
      <PageShell title="订阅推送">
        <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center">
          <p className="text-sm text-neutral-600">加载失败，请稍后重试</p>
          <button
            type="button"
            onClick={load}
            className="mt-3 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            重试
          </button>
        </div>
      </PageShell>
    );
  }

  // 未订阅 / 已退订 / 被踢出 → 引导去订阅页（创建只走匿名 POST + Turnstile）
  if (!sub || sub.status === 'unsubscribed' || sub.status === 'kicked') {
    let title = '你还没有订阅推送';
    let desc = '订阅后，我们每天把过去 24 小时的多源 AI 精华推到你邮箱。';
    if (sub?.status === 'unsubscribed') {
      title = '你已退订推送';
      desc = '随时可以重新订阅，继续每天接收多源 AI 精华。';
    } else if (sub?.status === 'kicked') {
      title = '推送已暂停';
      desc = '你的邮箱多次投递失败，推送已自动暂停。请检查邮箱能否正常收信后重新订阅。';
    }
    return (
      <PageShell title="订阅推送">
        <div className="rounded-lg border border-neutral-200 bg-white p-6 text-center">
          <h2 className="text-base font-medium text-neutral-900">{title}</h2>
          <p className="mt-2 text-sm text-neutral-600">{desc}</p>
          <button
            type="button"
            onClick={() => navigate('/subscribe')}
            className="mt-4 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800"
          >
            去订阅
          </button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell title="订阅推送">
      <section className="mb-6">
        <label className="mb-1 block text-sm text-neutral-700">邮箱</label>
        <input
          type="email"
          value={sub.email}
          readOnly
          disabled
          className="w-full rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-base text-neutral-500 focus:outline-none"
        />
        <p className="mt-1 text-xs text-neutral-400">如需更换邮箱，请退订后用新邮箱重新订阅。</p>
      </section>

      <PreferenceFields
        sources={sources}
        setSources={setSources}
        slot={slot}
        setSlot={setSlot}
        density={density}
        setDensity={setDensity}
        sourcesError={sourcesError}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || sources.length === 0}
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {saving ? '保存中…' : '保存偏好'}
        </button>

        {!confirmingUnsub ? (
          <button
            type="button"
            onClick={() => setConfirmingUnsub(true)}
            className="text-sm text-neutral-500 hover:text-neutral-700"
          >
            退订推送
          </button>
        ) : (
          <span className="flex items-center gap-2 text-sm">
            <span className="text-neutral-600">确认退订？</span>
            <button
              type="button"
              onClick={handleUnsubscribe}
              disabled={unsubscribing}
              className="font-medium text-rose-600 hover:text-rose-700 disabled:opacity-50"
            >
              {unsubscribing ? '退订中…' : '确认'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingUnsub(false)}
              className="text-neutral-500 hover:text-neutral-700"
            >
              取消
            </button>
          </span>
        )}
      </div>
    </PageShell>
  );
}

export function Subscription({ mode }: { mode: 'anonymous' | 'manage' }) {
  return mode === 'manage' ? <ManageSubscription /> : <AnonymousSubscribe />;
}
