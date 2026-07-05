import { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate } from 'react-router';
import {
  fetchMyFeedback,
  markFeedbackRead,
  submitFeedback,
  useFeedbackUnreadStore,
  type FeedbackItem,
} from '../api';
import { resolveAssetUrl } from '../lib/asset';
import { isWeChatBrowser } from '../lib/wechat';
import { toast } from '../lib/toast';
import { timeAgo } from '../lib/utils';

const CONTENT_MAX = 2000;
const IMG_MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// API 返回 created_at 为 epoch ms；utils.timeAgo 吃 ISO 串 → 先转 ISO 再复用。
function relTime(ms: number): string {
  return timeAgo(new Date(ms).toISOString());
}

// lucide 同款内联 SVG（项目未装 lucide-react，沿用 UserMenu 内联 icon 约定，1.6 stroke）。
function IconArrowLeft({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

function IconImagePlus({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M16 5h6" />
      <path d="M19 2v6" />
      <path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
      <circle cx="9" cy="9" r="2" />
    </svg>
  );
}

function IconX({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

type ListState = 'loading' | 'ready' | 'error';

// 单条反馈卡片（含官方回复线程）。
function FeedbackCard({ item }: { item: FeedbackItem }) {
  const img = item.image_url ? resolveAssetUrl(item.image_url) : null;
  return (
    <article className="rounded-lg border border-neutral-200 bg-white p-4">
      <p className="whitespace-pre-wrap break-words text-[15px] text-neutral-900">{item.content}</p>
      {img && (
        <a href={img} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block">
          <img src={img} alt="" className="h-20 w-auto rounded-md border border-neutral-200 object-cover" />
        </a>
      )}
      <div className="mt-2 text-[13px] text-neutral-500">{relTime(item.created_at)}</div>

      {item.replies.length > 0 && (
        <div className="mt-3 space-y-2 border-t border-neutral-100 pt-3">
          {item.replies.map((r) => {
            const rimg = r.image_url ? resolveAssetUrl(r.image_url) : null;
            return (
              <div key={r.id} className="rounded-md bg-neutral-50 p-3">
                <div className="mb-1 flex items-center gap-2">
                  <span className="rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] font-medium text-white">
                    官方回复
                  </span>
                  {r.read_at === null && (
                    <span className="flex items-center gap-1 text-[11px] font-medium text-rose-600">
                      <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />新
                    </span>
                  )}
                </div>
                <p className="whitespace-pre-wrap break-words text-[15px] text-neutral-900">{r.content}</p>
                {rimg && (
                  <a href={rimg} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block">
                    <img src={rimg} alt="" className="h-20 w-auto rounded-md border border-neutral-200 object-cover" />
                  </a>
                )}
                <div className="mt-1 text-[13px] text-neutral-500">{relTime(r.created_at)}</div>
              </div>
            );
          })}
        </div>
      )}
    </article>
  );
}

export function Feedback() {
  const navigate = useNavigate();
  const [content, setContent] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [listState, setListState] = useState<ListState>('loading');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 重新拉取「我的反馈」列表（重试按钮 / 提交成功后刷新调用）。仅在事件处理器里用，
  // 不在 effect 里调用 —— effect 首拉走下方 mount 版本（setState 放 .then 回调内，规避
  // react-hooks/set-state-in-effect）。loading 态由调用方按需先行设置。
  const loadList = useCallback(async () => {
    try {
      const data = await fetchMyFeedback();
      setItems(data.items);
      setListState('ready');
      useFeedbackUnreadStore.getState().setUnread(data.unread_count);
    } catch {
      setListState('error');
    }
  }, []);

  // Mount 首拉：初始 listState 已是 'loading'。setState 全部落在 .then/.catch 回调内
  // （对齐 App.tsx 的 fetchSources().then(setState) 惯例），effect 体内无同步 setState。
  // 拉取成功即「全部标记已读」+ 清零红点（§5.6）：fire-and-forget，渲染仍用本次拉取的
  // read_at，「新」标记本访问可见、下次访问消失。alive 守卫防卸载后 setState。
  useEffect(() => {
    // 微信内不该走到这里（入口隐藏 + 下方 Navigate 兜底），跳过拉取避免无谓请求。
    if (isWeChatBrowser()) return;
    let alive = true;
    fetchMyFeedback()
      .then((data) => {
        if (!alive) return;
        setItems(data.items);
        setListState('ready');
        markFeedbackRead();
        useFeedbackUnreadStore.getState().clearUnread();
      })
      .catch(() => {
        if (alive) setListState('error');
      });
    return () => {
      alive = false;
    };
  }, []);

  // 组件卸载 / 预览切换时释放 objectURL，避免内存泄漏。
  useEffect(() => {
    return () => {
      if (imagePreview) URL.revokeObjectURL(imagePreview);
    };
  }, [imagePreview]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    // 清空 value：同一文件再次选择也能触发 onChange。
    e.target.value = '';
    if (!f) return;
    // 客户端前置校验（服务端仍强制），文案逐字对齐 §5.3。
    if (f.size > IMG_MAX_BYTES) {
      toast.error('图片不能超过 5MB');
      return;
    }
    if (!ALLOWED_IMAGE_TYPES.includes(f.type)) {
      toast.error('仅支持 jpg/png/webp/gif 图片');
      return;
    }
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImage(f);
    setImagePreview(URL.createObjectURL(f));
  };

  const removeImage = () => {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImage(null);
    setImagePreview(null);
  };

  const onSubmit = async () => {
    const text = content.trim();
    if (!text || submitting) return;
    setSubmitting(true);
    const res = await submitFeedback(text, image);
    setSubmitting(false);
    if (res.ok) {
      toast.success('反馈已提交，感谢支持');
      setContent('');
      removeImage();
      loadList();
      return;
    }
    if (res.code === 'rate_limited') {
      toast.error('操作太频繁了，稍后再试');
      return;
    }
    if (res.code === 'unauthorized') {
      // submitFeedback 已弹登录弹窗，无需额外 toast
      return;
    }
    toast.error('提交失败，请稍后再试');
  };

  // 微信浏览器兜底：直接输 URL 访问也重定向回首页（1.1「微信内无此模块」）。
  // 放在所有 hooks 之后，保证 hook 顺序稳定。
  if (isWeChatBrowser()) return <Navigate to="/" replace />;

  const canSubmit = content.trim().length > 0 && !submitting;

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-md px-2 py-1 text-neutral-600 hover:bg-neutral-100"
          aria-label="返回"
        >
          <IconArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-xl font-semibold text-neutral-900">用户反馈</h1>
      </header>

      {/* 提交表单 */}
      <section className="mb-8 rounded-lg border border-neutral-200 bg-white p-4">
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          maxLength={CONTENT_MAX}
          rows={5}
          placeholder="说说你遇到的问题或建议…"
          className="w-full resize-none rounded-md border border-neutral-300 px-3 py-2 text-base placeholder:text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none"
        />
        <div className="mt-1 text-right text-[11px] text-neutral-400">
          {content.length}/{CONTENT_MAX}
        </div>

        {imagePreview ? (
          <div className="relative mt-2 inline-block">
            <img
              src={imagePreview}
              alt="预览"
              className="h-20 w-20 rounded-md border border-neutral-200 object-cover"
            />
            <button
              type="button"
              onClick={removeImage}
              className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-900 text-white hover:bg-neutral-800"
              aria-label="移除图片"
            >
              <IconX className="h-3 w-3" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-2 flex items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            <IconImagePlus className="h-4 w-4 shrink-0" />
            添加图片（选填，最多 1 张）
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          className="hidden"
          onChange={onFileChange}
        />

        <div className="mt-4">
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? '提交中…' : '提交反馈'}
          </button>
        </div>
      </section>

      {/* 我的反馈 */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-neutral-700">我的反馈</h2>
        {listState === 'loading' && <p className="text-sm text-neutral-400">加载中…</p>}
        {listState === 'error' && (
          <div className="flex items-center gap-3 text-sm">
            <span className="text-rose-600">加载失败</span>
            <button
              type="button"
              onClick={() => {
                setListState('loading');
                loadList();
              }}
              className="text-neutral-500 underline hover:text-neutral-700"
            >
              重试
            </button>
          </div>
        )}
        {listState === 'ready' && items.length === 0 && (
          <p className="text-sm text-neutral-400">还没有提交过反馈</p>
        )}
        {listState === 'ready' && items.length > 0 && (
          <div className="space-y-3">
            {items.map((it) => (
              <FeedbackCard key={it.id} item={it} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
