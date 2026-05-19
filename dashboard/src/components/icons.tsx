// Inline SVGs for tweet card — avoids pulling in lucide-react/heroicons.
// Sizes default to 1em so they scale with surrounding text.

interface IconProps {
  className?: string;
}

// X's official blue verified badge (six-point star with check)
export function VerifiedBadge({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 22 22"
      className={className || "h-[16px] w-[16px] shrink-0 fill-sky-500"}
      aria-label="已认证"
    >
      <path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.817.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
    </svg>
  );
}

// Thin outline icons matching X's style (24x24 viewBox, stroke via currentColor)
export function IconReply({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || "h-[18px] w-[18px] fill-current"}>
      <path d="M1.751 10c0-4.42 3.584-8 8.005-8h4.366c4.49 0 8.129 3.64 8.129 8.13 0 2.96-1.607 5.68-4.196 7.11l-8.054 4.46v-3.69h-.067c-4.49.1-8.183-3.51-8.183-8.01z" />
    </svg>
  );
}

export function IconRetweet({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || "h-[18px] w-[18px] fill-current"}>
      <path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z" />
    </svg>
  );
}

// IconThread: 两个 chat bubble 叠加，表示推文串
export function IconThread({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || "h-[18px] w-[18px] fill-current"}>
      <path d="M13 3H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1v3l3-3h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm7 6h-3v2a4 4 0 0 1-4 4H9v.5a2 2 0 0 0 2 2h5l3 3V19h1a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2z" />
    </svg>
  );
}

// IconQuote: 经典 typography 双引号占位
export function IconQuote({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || "h-[18px] w-[18px] fill-current"}>
      <path d="M6.5 17H10l2-4V7H5v6h3.5l-2 4zm9 0H19l2-4V7h-7v6h3.5l-2 4z" />
    </svg>
  );
}

export function IconHeart({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || "h-[18px] w-[18px] fill-current"}>
      <path d="M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91zm4.187 7.69c-1.351 2.48-4.001 5.12-8.379 7.67l-.503.3-.504-.3c-4.379-2.55-7.029-5.19-8.382-7.67-1.36-2.5-1.41-4.86-.514-6.67.887-1.79 2.647-2.91 4.601-3.01 1.651-.09 3.368.56 4.798 2.01 1.429-1.45 3.146-2.1 4.796-2.01 1.954.1 3.714 1.22 4.601 3.01.896 1.81.846 4.17-.514 6.67z" />
    </svg>
  );
}

export function IconEye({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || "h-[18px] w-[18px] fill-current"}>
      <path d="M8.75 21V3h2v18h-2zM18 21V8.5h2V21h-2zM4 21l.004-10h2L6 21H4zm9.248 0v-7h2v7h-2z" />
    </svg>
  );
}

// GitHub octicons (16x16). Paths from primer/octicons (MIT).
export function IconStarFill({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className || "h-[14px] w-[14px] fill-current"} aria-hidden="true">
      <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" />
    </svg>
  );
}

export function IconRepoForked({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className || "h-[14px] w-[14px] fill-current"} aria-hidden="true">
      <path d="M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z" />
    </svg>
  );
}

export function IconWatching({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className || "h-[14px] w-[14px] fill-current"} aria-hidden="true">
      <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z" />
    </svg>
  );
}

export function IconIssueOpened({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className || "h-[14px] w-[14px] fill-current"} aria-hidden="true">
      <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
      <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z" />
    </svg>
  );
}

export function IconPullRequest({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className || "h-[14px] w-[14px] fill-current"} aria-hidden="true">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z" />
    </svg>
  );
}

// Share icon (lucide-style 24x24, stroke 2 outline)
export function IconShare({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className || "h-[18px] w-[18px]"} aria-hidden="true">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

// Trophy icon for GitHub trending rank chip (lucide-style 24x24)
export function IconLeaderboard({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className || "h-[14px] w-[14px]"} aria-hidden="true">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
      <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" />
      <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

// Brand icons for data sources. Paths from Simple Icons (simpleicons.org, CC0).
// Rendered at 1em so they scale with surrounding text via className.
const BRAND_CLASS = "h-[16px] w-[16px] shrink-0 fill-current";

export function BrandX({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || BRAND_CLASS} aria-label="X">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export function BrandYouTube({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || BRAND_CLASS} aria-label="YouTube">
      <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
    </svg>
  );
}

export function BrandGitHub({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || BRAND_CLASS} aria-label="GitHub">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export function BrandProductHunt({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || BRAND_CLASS} aria-label="Product Hunt">
      <path d="M13.604 8.4h-3.405V12h3.405a1.8 1.8 0 100-3.6zM12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zm1.604 14.4h-3.405V18H7.801V6h5.804a4.2 4.2 0 110 8.4z" />
    </svg>
  );
}

// Events — calendar with center AI spark, reversed-out. 通用「活动」标识，
// 当前用于活动行（huodongxing）source；未来如接入其他活动源也可复用。
export function BrandEvents({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || BRAND_CLASS} aria-label="活动" fill="currentColor">
      <rect x="7" y="1.5" width="1.6" height="4" rx=".5" />
      <rect x="15.4" y="1.5" width="1.6" height="4" rx=".5" />
      <path d="M3.5 4.5h17a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <rect x="2.5" y="8" width="19" height="1.2" fill="#fff" />
      <path d="M12 11.5l1.1 2.6 2.6 1.1-2.6 1.1-1.1 2.6-1.1-2.6-2.6-1.1 2.6-1.1z" fill="#fff" />
    </svg>
  );
}

// arXiv official χ-style logo from Simple Icons (CC0).
export function BrandArxiv({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || BRAND_CLASS} aria-label="arXiv">
      <path d="M3.8423 0a1.0037 1.0037 0 0 0-.922.6078c-.1536.3687-.0438.6275.2938 1.1113l6.9185 8.3597-1.0223 1.1058a1.0393 1.0393 0 0 0 .003 1.4229l1.2292 1.3135-5.4391 6.4444c-.2803.299-.4538.823-.2971 1.1986a1.0253 1.0253 0 0 0 .9585.635.9133.9133 0 0 0 .6891-.3405l5.783-6.126 7.4902 8.0051a.8527.8527 0 0 0 .6835.2597.9575.9575 0 0 0 .8777-.6138c.1577-.377-.017-.7502-.306-1.1407l-7.0518-8.3418 1.0632-1.13a.9626.9626 0 0 0 .0089-1.3165L4.6336.4639s-.3733-.4535-.768-.463zm0 .272h.0166c.2179.0052.4874.2715.5644.3639l.005.006.0052.0055 10.169 10.9905a.6915.6915 0 0 1-.0072.945l-1.0666 1.133-1.4982-1.7724-8.5994-10.39c-.3286-.472-.352-.6183-.2592-.841a.7307.7307 0 0 1 .6704-.4401Zm14.341 1.5701a.877.877 0 0 0-.6554.2418l-5.6962 6.1584 1.6944 1.8319 5.3089-6.5138c.3251-.4335.479-.6603.3247-1.0292a1.1205 1.1205 0 0 0-.9763-.689zm-7.6557 12.2823 1.3186 1.4135-5.7864 6.1295a.6494.6494 0 0 1-.4959.26.7516.7516 0 0 1-.706-.4669c-.1119-.2682.0359-.6864.2442-.9083l.0051-.0055.0047-.0055z" />
    </svg>
  );
}

// Apple Podcasts official logo from Simple Icons (CC0). Used as the podcast column icon.
export function BrandPodcast({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || BRAND_CLASS} aria-label="Apple Podcasts">
      <path d="M5.34 0A5.328 5.328 0 000 5.34v13.32A5.328 5.328 0 005.34 24h13.32A5.328 5.328 0 0024 18.66V5.34A5.328 5.328 0 0018.66 0zm6.525 2.568c2.336 0 4.448.902 6.056 2.587 1.224 1.272 1.912 2.619 2.264 4.392.12.59.12 2.2.007 2.864a8.506 8.506 0 01-3.24 5.296c-.608.46-2.096 1.261-2.336 1.261-.088 0-.096-.091-.056-.46.072-.592.144-.715.48-.856.536-.224 1.448-.874 2.008-1.435a7.644 7.644 0 002.008-3.536c.208-.824.184-2.656-.048-3.504-.728-2.696-2.928-4.792-5.624-5.352-.784-.16-2.208-.16-3 0-2.728.56-4.984 2.76-5.672 5.528-.184.752-.184 2.584 0 3.336.456 1.832 1.64 3.512 3.192 4.512.304.2.672.408.824.472.336.144.408.264.472.856.04.36.03.464-.056.464-.056 0-.464-.176-.896-.384l-.04-.03c-2.472-1.216-4.056-3.274-4.632-6.012-.144-.706-.168-2.392-.03-3.04.36-1.74 1.048-3.1 2.192-4.304 1.648-1.737 3.768-2.656 6.128-2.656zm.134 2.81c.409.004.803.04 1.106.106 2.784.62 4.76 3.408 4.376 6.174-.152 1.114-.536 2.03-1.216 2.88-.336.43-1.152 1.15-1.296 1.15-.023 0-.048-.272-.048-.603v-.605l.416-.496c1.568-1.878 1.456-4.502-.256-6.224-.664-.67-1.432-1.064-2.424-1.246-.64-.118-.776-.118-1.448-.008-1.02.167-1.81.562-2.512 1.256-1.72 1.704-1.832 4.342-.264 6.222l.413.496v.608c0 .336-.027.608-.06.608-.03 0-.264-.16-.512-.36l-.034-.011c-.832-.664-1.568-1.842-1.872-2.997-.184-.698-.184-2.024.008-2.72.504-1.878 1.888-3.335 3.808-4.019.41-.145 1.133-.22 1.814-.211zm-.13 2.99c.31 0 .62.06.844.178.488.253.888.745 1.04 1.259.464 1.578-1.208 2.96-2.72 2.254h-.015c-.712-.331-1.096-.956-1.104-1.77 0-.733.408-1.371 1.112-1.745.224-.117.534-.176.844-.176zm-.011 4.728c.988-.004 1.706.349 1.97.97.198.464.124 1.932-.218 4.302-.232 1.656-.36 2.074-.68 2.356-.44.39-1.064.498-1.656.288h-.003c-.716-.257-.87-.605-1.164-2.644-.341-2.37-.416-3.838-.218-4.302.262-.616.974-.966 1.97-.97z" />
    </svg>
  );
}

// ClawHub brand mark — 龙虾 silhouette（emoji 风格）。currentColor fill 配合
// SourceIcon 父级 className 控制颜色，避免和 column header 主色冲突。眼睛点用
// #fff 在着色身体上形成对比，浅色背景下身体本身的填色仍然可读。
export function BrandClawhub({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className || BRAND_CLASS}
      aria-label="ClawHub"
    >
      <path d="M9 3.5c-1 .5-1.8 1.4-2.2 2.5" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" />
      <path d="M15 3.5c1 .5 1.8 1.4 2.2 2.5" stroke="currentColor" strokeWidth="1.1" fill="none" strokeLinecap="round" />
      <path d="M3.5 9.5c0-1.4 1.1-2.5 2.5-2.5s2.5 1.1 2.5 2.5L7 11l1.5 1L7.2 13.4 5.5 12c-1.1-.2-2-1.2-2-2.5z" />
      <circle cx="5.7" cy="9.3" r=".5" fill="#fff" />
      <path d="M20.5 9.5c0-1.4-1.1-2.5-2.5-2.5s-2.5 1.1-2.5 2.5L17 11l-1.5 1 1.3 1.4L18.5 12c1.1-.2 2-1.2 2-2.5z" />
      <circle cx="18.3" cy="9.3" r=".5" fill="#fff" />
      <path d="M9 11h6l-.5 2h-5z" />
      <path d="M9 14h6l-.5 2h-5z" />
      <path d="M9.5 17h5l-.5 2h-4z" />
      <path d="M10 19.5l-1.5 2.5 1.5-.6L12 22l2-.6 1.5.6-1.5-2.5z" />
    </svg>
  );
}

// ClawHub-specific metric icons (mirrors lucide-react: Download / Package / Tag / Clock / Shield)
export function IconDownload({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className || "h-[14px] w-[14px]"} aria-hidden="true">
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
    </svg>
  );
}

export function IconPackage({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className || "h-[14px] w-[14px]"} aria-hidden="true">
      <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
      <path d="M12 22V12" />
      <polyline points="3.29 7 12 12 20.71 7" />
      <path d="m7.5 4.27 9 5.15" />
    </svg>
  );
}

export function IconTag({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className || "h-[14px] w-[14px]"} aria-hidden="true">
      <path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z" />
      <circle cx="7.5" cy="7.5" r="1" fill="currentColor" />
    </svg>
  );
}

export function IconClock({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className || "h-[14px] w-[14px]"} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

export function IconShield({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className || "h-[14px] w-[14px]"} aria-hidden="true">
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}

export function IconCopy({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className || "h-[14px] w-[14px]"} aria-hidden="true">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

// HuggingFace 标志风格 logo — 黄色「拥抱脸」笑脸 + 双手举起。
// 简化版纯几何形:头(圆) + 两眼(椭圆) + 嘴(弧) + 两手(圆角矩形)。
// HF 品牌色 #FFD21E,但 SourceIcon 通常受父级 className 控制颜色,这里走 currentColor
// 让颜色跟着 source filter chip 主色变化(选中时高亮)。
export function BrandHF({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className || BRAND_CLASS} aria-label="HuggingFace" fill="currentColor">
      {/* 头(圆形 face) */}
      <circle cx="12" cy="11" r="6.5" />
      {/* 两眼(白色椭圆) */}
      <ellipse cx="9.6" cy="10.3" rx="0.8" ry="1.1" fill="#fff" />
      <ellipse cx="14.4" cy="10.3" rx="0.8" ry="1.1" fill="#fff" />
      {/* 嘴(向上弧线 = 笑) */}
      <path d="M9.5 12.8 Q12 14.6 14.5 12.8" stroke="#fff" strokeWidth="0.8" fill="none" strokeLinecap="round" />
      {/* 两手(举起拥抱姿势,左右各一) */}
      <rect x="3.5" y="13.5" width="3.5" height="2.2" rx="1.1" />
      <rect x="17" y="13.5" width="3.5" height="2.2" rx="1.1" />
    </svg>
  );
}

export function SourceIcon({ source_type, className }: IconProps & { source_type: string }) {
  switch (source_type) {
    case "x_list":
      return <BrandX className={className} />;
    case "youtube":
      return <BrandYouTube className={className} />;
    case "github":
      return <BrandGitHub className={className} />;
    case "podcast":
      return <BrandPodcast className={className} />;
    case "product_hunt":
      return <BrandProductHunt className={className} />;
    case "huodongxing":
      return <BrandEvents className={className} />;
    case "arxiv":
    case "hf_paper":
      // PM 2026-05-19: 论文流 title 左侧 icon 用 arxiv 标志(论文实际来自 arxiv,
      // HF 只是发现/聚合渠道)。BrandHF 暂保留在文件里,如未来需要区分场景再启用
      return <BrandArxiv className={className} />;
    case "clawhub":
      return <BrandClawhub className={className} />;
    default:
      return null;
  }
}
