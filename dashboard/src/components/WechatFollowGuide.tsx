// 微信内置浏览器里的订阅引导：Turnstile 人机校验在微信里过不去，邮箱订阅是死路，
// 故在 /subscribe 页改为引导用户长按二维码关注公众号「AI Feeds」，每早收 AI 日报。
// 仅在 isWeChatBrowser() 为真时由 AnonymousSubscribe 渲染。

// 往期日报封面 + 内页（同一期 06-09 的封面与条目页，做横划预览）。
// 静态资源在 public/digest/，图片不常更换，换期时覆盖同名文件即可。
const DIGEST_COUNT = 11;
const DIGESTS = Array.from(
  { length: DIGEST_COUNT },
  (_, i) => `digest-${String(i).padStart(2, '0')}.webp`,
);

function IconBadgeCheck({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function IconQr({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3M21 14v.01M14 21h.01M17 21h4v-4" />
    </svg>
  );
}

function IconArrowDown({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 5v14M19 12l-7 7-7-7" />
    </svg>
  );
}

export function WechatFollowGuide() {
  return (
    <>
      {/* 主引导卡片：标题 + 公众号名片 + 二维码 */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
        <h2 className="text-xl font-bold tracking-tight text-neutral-900">
          关注公众号，每早看 AI 日报
        </h2>

        {/* 公众号名片：包装成账号形态 */}
        <div className="mt-4 flex items-center gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-3">
          <img
            src="/favicon.svg"
            alt="AI Feeds"
            className="h-11 w-11 shrink-0 rounded-[11px] border border-neutral-200"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="text-base font-semibold text-neutral-900">AI Feeds</span>
              <span className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-100 px-1.5 py-px text-[11px] font-medium text-neutral-600">
                <IconBadgeCheck className="h-3 w-3" />
                公众号
              </span>
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">
              聚合 X、Product Hunt、GitHub、arXiv 等 AI 资讯精华
            </p>
          </div>
        </div>

        {/* 二维码：微信内长按可识别关注 */}
        <div className="mt-5 flex flex-col items-center">
          <div className="h-[200px] w-[200px] rounded-2xl border border-neutral-200 bg-white p-2.5">
            <img
              src="/wechat-qr.png"
              alt="AI Feeds 公众号二维码"
              className="h-full w-full"
            />
          </div>
          <div className="mt-3 inline-flex items-center gap-1.5 text-sm font-semibold text-neutral-900">
            <IconQr className="h-4 w-4 text-neutral-600" />
            长按二维码关注
          </div>
        </div>
      </div>

      {/* 往期日报：横向滑动预览 */}
      <div className="mt-4">
        <div className="mb-3 flex items-center justify-center gap-1.5 text-xs text-neutral-600">
          <span>往期日报</span>
          <IconArrowDown className="h-[15px] w-[15px]" />
        </div>
        <div className="flex snap-x snap-mandatory gap-2.5 overflow-x-auto pb-2.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {DIGESTS.map((d, i) => (
            <img
              key={d}
              src={`/digest/${d}`}
              alt={i === 0 ? 'AI 日报封面' : `AI 日报内页 ${i}`}
              loading="lazy"
              draggable={false}
              className="h-[184px] w-[138px] shrink-0 snap-start rounded-[10px] border border-neutral-200 bg-white object-cover shadow-[0_4px_14px_rgba(0,0,0,0.08)]"
            />
          ))}
        </div>
      </div>
    </>
  );
}
