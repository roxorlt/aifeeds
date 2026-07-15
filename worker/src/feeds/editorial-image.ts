// 正文图片噪声的统一判定入口。
//
// 规则只依赖原始 URL 的稳定语义，不做站点级“一刀切”：The Verge 的正常 hero、截图、
// 人物新闻照片仍保留，只剔除作者署名头像及通用 badge/icon。采集、R2 迁移、日报渲染和
// 存量回填必须共用本文件，避免某个消费端单独打补丁后再次泄漏。

const AUTHOR_PROFILE_IMAGE_PATTERNS: RegExp[] = [
  /(^|[/_-])avatars?([/_.-]|$)/i,
  /\/authors?\//i,
  /author[_-]/i,
  /head[_-]?shot/i,
  /byline/i,
  /contributor/i,
  /profile[_-]?(pic|photo|image)/i,
  /gravatar\.com/i,
  // The Verge 的两种稳定作者头像路径：Chorus 作者资料目录，以及品牌蓝紫滤镜文件名。
  /\/chorus\/author_profile_images\//i,
  /blurple/i,
];

const SMALL_INLINE_IMAGE_PATTERN = /[?&](?:w|width)=(?:[1-9]\d?|1[0-4]\d)(?:\D|$)/i;

function htmlDecode(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function matchableUrl(url: string): string {
  const decoded = htmlDecode(String(url || "").trim());
  try {
    return decodeURIComponent(decoded);
  } catch {
    return decoded;
  }
}

/** R2 资源统一归一为 `/r/...`，消除相对路径与 `https://api.../r/...` 的表示差异。 */
export function normalizeImageAlias(url: string): string {
  const value = matchableUrl(url);
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (parsed.pathname.startsWith('/r/')) return parsed.pathname;
  } catch {
    // 相对 URL 走下方分支。
  }
  if (value.startsWith('/r/')) return value.split(/[?#]/, 1)[0];
  return value;
}

export function isAuthorProfileImage(url: string): boolean {
  const value = matchableUrl(url);
  if (!value) return false;
  return AUTHOR_PROFILE_IMAGE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * 入库/数据清理使用的强规则：只处理 The Verge 自有域名，且必须命中其稳定头像目录或
 * BLURPLE 文件名。相比通用渲染兜底，这条规则可安全地做不可逆删除。
 */
export function isTheVergeAuthorProfileImage(url: string): boolean {
  const value = matchableUrl(url);
  if (!value) return false;
  let hostname = '';
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname !== 'theverge.com' && !hostname.endsWith('.theverge.com')) return false;
  return /\/chorus\/author_profile_images\//i.test(value) || /blurple/i.test(value);
}

export function isSkippableInlineImage(url: string): boolean {
  const value = matchableUrl(url);
  if (!value) return true;
  if (
    /\.svg(?:\?|$)/i.test(value) ||
    /(shields\.io|badgen\.net|badge\.fury|forthebadge|img\.shields)/i.test(value) ||
    /^data:/i.test(value)
  ) {
    return true;
  }
  return isAuthorProfileImage(value) || SMALL_INLINE_IMAGE_PATTERN.test(value);
}

function blocked(
  url: string,
  aliases: ReadonlySet<string>,
  predicate: (value: string) => boolean,
): boolean {
  const value = htmlDecode(String(url || "").trim());
  return aliases.has(value)
    || aliases.has(matchableUrl(value))
    || aliases.has(normalizeImageAlias(value))
    || predicate(value);
}

/**
 * 从 Markdown/HTML 正文中移除非编辑图片。aliases 用于同时剔除同一脏图迁 R2 后的 URL；
 * R2 内容寻址路径本身已丢失 author_profile/BLURPLE 语义，必须由原始 asset 建立对应关系。
 */
export function removeSkippableMarkdownImages(
  markdown: string,
  aliases: ReadonlySet<string> = new Set<string>(),
  predicate: (url: string) => boolean = isSkippableInlineImage,
): string {
  if (!markdown) return markdown;

  let removed = false;
  let out = markdown.replace(
    /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
    (whole, url: string) => {
      if (!blocked(url, aliases, predicate)) return whole;
      removed = true;
      return "";
    },
  );
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const match = tag.match(/\bsrc\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i);
    const url = match?.[2] || match?.[3] || "";
    if (!url || !blocked(url, aliases, predicate)) return tag;
    removed = true;
    return "";
  });

  if (!removed) return markdown;
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
