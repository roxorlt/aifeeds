// 活动行 event 详情页 (detail) HTML parser。
//
// 输入：fetch /event/<id> 返回的整页 HTML。
// 输出：DetailEnrich object，含 start/end ISO 时间、地址、票种、嘉宾、报名容量等
//        所有结构化字段。
//
// 实现关键：detail 页里有一个 88KB 的 inline <script>，含完整 event JSON 对象
//        （ASP.NET DataContractJsonSerializer 输出，日期格式 "/Date(ms)/"）。
//        我们 brace-counting walker 把它扣出来 JSON.parse，比 DOM 解析稳健 10 倍。
//
// 限制：activity body 正文是客户端 Vue hydrate 后填的，worker fetch 拿不到。
//      v1 用 inline JSON 已能覆盖 drawer 90% 字段；body_html 留作 v2（CF Browser Rendering）。

export interface TicketTier {
  sn: number;                      // 票种序号
  name: string;                    // Title（"早鸟" / "项目方"）
  description: string;             // Description
  price: number;                   // 0 = 免费
  price_str: string;               // "免费" / "¥199"
  src_price_str: string | null;    // 原价（如有打折）
  currency: string | null;
  quantity: number;                // 库存
  sold_number: number;             // 已售
  book_number: number;             // 预订中
  status_str: string;              // "报名中" / "已售罄" / 等
  need_apply: boolean;             // 需要审核
}

export interface EventGuest {
  name: string;
  titles: string[];                // ["秘书长", ...]
  company: string;                 // "北京科创企业投融资联盟"
  description: string;             // bio
  avatar_url: string;              // 完整 URL（已加 cdn 前缀）
  sort: number;                    // 显示顺序
}

export interface DetailEnrich {
  event_id: string;
  title: string;
  thumbnail_full: string;          // LogoV2 完整 URL
  og_image: string;                // og:image meta
  start_time: string | null;       // ISO 8601 with +08:00 offset
  end_time: string | null;
  start_short: string;             // 站点提供 "05/21 14:30"，作 fallback
  end_short: string;
  city_district: string | null;    // detail JSON 里的 City 字段（实际是"区"，如 "朝阳"）
  address: string | null;          // detail JSON 里的 Address（场所名称如 "三板汇茶咖空间发布厅"，不带城市/区前缀）
  location_full: string | null;    // city + district + address 拼接（需要列表 location_raw 补市名）
  category: number | null;         // PH 站点分类 ID
  tags: string[];                  // Tag 字段拆出
  max_instance: number | null;     // 总容量
  registered_count: number | null; // 已报名（InstanceNumber）
  is_free: boolean;
  is_private: boolean;
  follows: number;                 // 活动 follow 数
  visit_number: number;            // 浏览数
  status: number;                  // 0/1/...
  ticket_tiers: TicketTier[];
  guests: EventGuest[];
  contact: {
    org_phone: string | null;
    org_email: string | null;
    org_qr_code: string | null;    // 联系咨询的客服微信二维码
    org_description: string | null;
  };
  organizer_ids: number[];         // 主办方数字 ID，要单独查 organizer profile 拿头像/粉丝
  create_date: string | null;      // ISO
  update_date: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────

const CDN_PREFIX = 'https://cdn.huodongxing.com/';

/**
 * ASP.NET `/Date(1779345000000)/` → ISO 8601 with +08:00 (站点服务器时区猜测).
 * 实际上 unix ms 是绝对时刻，所以不依赖时区，直接转 ISO 加 +08:00 offset 让前端显示成北京时间。
 */
function aspNetDateToIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = s.match(/\/Date\((\d+)\)\//);
  if (!m) return null;
  const ms = parseInt(m[1], 10);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  // BJT-format ISO（活动行是中国站，事件时间默认 BJT 解读）
  const pad = (n: number) => String(n).padStart(2, '0');
  // Get UTC components then add 8 hours for BJT
  const bjt = new Date(ms + 8 * 3600 * 1000);
  return (
    `${bjt.getUTCFullYear()}-${pad(bjt.getUTCMonth() + 1)}-${pad(bjt.getUTCDate())}` +
    `T${pad(bjt.getUTCHours())}:${pad(bjt.getUTCMinutes())}:${pad(bjt.getUTCSeconds())}+08:00`
  );
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function resolveCdnUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith('/')) return CDN_PREFIX.replace(/\/$/, '') + path;
  // "logo/202605/.../foo.jpg" or just "202605/.../foo.jpg"
  if (!path.startsWith('logo/')) return CDN_PREFIX + 'logo/' + path;
  return CDN_PREFIX + path;
}

/**
 * 从 detail HTML 里扣出完整 event JSON 对象。
 *
 * 找 `{"Id":<digits>,"Type":<digits>...` 起点，brace-counting walker 找匹配 `}`。
 * Worker JSON.parse 即可。这块对应站点 inline 大 script 里的 SSR data，不依赖 Vue 渲染。
 */
function extractEventJsonRaw(html: string): string | null {
  // 多重起点候选，找到最早出现的合理匹配
  const startRe = /\{"Id":\d+,"Type":\d+,"Featureds":/;
  const startMatch = html.match(startRe);
  if (!startMatch || startMatch.index === undefined) return null;
  const start = startMatch.index;

  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return null;
}

interface RawEventJson {
  Id?: number;
  Title?: string;
  Logo?: string;
  LogoV2?: string;
  Start?: string;
  End?: string;
  StartShort?: string;
  EndShort?: string;
  City?: string;
  Address?: string;
  Location?: string | null;
  Category?: number;
  Tag?: string;
  MaxInstance?: number;
  InstanceNumber?: number;
  Status?: number;
  IsPrivate?: boolean;
  IsFree?: boolean;
  Follows?: number;
  VisitNumber?: number;
  Organizers?: number[];
  CreateDate?: string;
  UpdateDate?: string;
  ActivityTickets?: RawTicket[];
  ActivityGuests?: { Cate?: unknown; Sort?: string; Guest?: RawGuest }[];
  Setting?: RawSetting;
}

interface RawTicket {
  SN?: number;
  Title?: string;
  Description?: string;
  Price?: number;
  PriceStr?: string;
  SrcPriceStr?: string | null;
  Currency?: string | null;
  Quantity?: number;
  SoldNumber?: number;
  BookNumber?: number;
  StatusStr?: string;
  NeedApply?: boolean;
}

interface RawGuest {
  Name?: string;
  Logo?: string;
  Titles?: string[];
  Company?: string;
  Description?: string;
}

interface RawSetting {
  ContactOrgPhone?: string | null;
  ContactOrgEmail?: string | null;
  ContactOrgQrCode?: string | null;
  ContactOrgDescription?: string | null;
}

function extractOgImage(html: string): string {
  const m = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
  return m ? decodeEntities(m[1]) : '';
}

// ─── Public API ───────────────────────────────────────────────

/**
 * Parse detail page HTML → DetailEnrich. Returns null if inline event JSON
 * couldn't be located (site structure changed / fetched a non-detail page).
 *
 * 与列表 parser 配合：列表给的 location_raw（"北京朝阳"）含市名，detail JSON 里 City
 * 字段只是"区"（"朝阳"）。location_full 拼接由调用方完成，需要传入列表里 city 字段。
 */
export function parseDetail(html: string): DetailEnrich | null {
  const raw = extractEventJsonRaw(html);
  if (!raw) return null;

  let obj: RawEventJson;
  try {
    obj = JSON.parse(raw) as RawEventJson;
  } catch {
    return null;
  }

  if (!obj.Id) return null;

  const tags = (obj.Tag || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const ticket_tiers: TicketTier[] = (obj.ActivityTickets || []).map((t) => ({
    sn: t.SN ?? 0,
    name: t.Title ?? '',
    description: t.Description ?? '',
    price: typeof t.Price === 'number' ? t.Price : 0,
    price_str: t.PriceStr ?? '',
    src_price_str: t.SrcPriceStr ?? null,
    currency: t.Currency ?? null,
    quantity: t.Quantity ?? 0,
    sold_number: t.SoldNumber ?? 0,
    book_number: t.BookNumber ?? 0,
    status_str: t.StatusStr ?? '',
    need_apply: !!t.NeedApply,
  }));

  const guests: EventGuest[] = (obj.ActivityGuests || [])
    .filter((g) => g.Guest)
    .map((g) => ({
      name: g.Guest!.Name ?? '',
      titles: g.Guest!.Titles ?? [],
      company: g.Guest!.Company ?? '',
      description: g.Guest!.Description ?? '',
      avatar_url: resolveCdnUrl(g.Guest!.Logo),
      sort: parseInt(g.Sort ?? '0', 10) || 0,
    }));

  const setting = obj.Setting || {};

  return {
    event_id: String(obj.Id),
    title: obj.Title ?? '',
    thumbnail_full: resolveCdnUrl(obj.LogoV2 || obj.Logo),
    og_image: extractOgImage(html),
    start_time: aspNetDateToIso(obj.Start),
    end_time: aspNetDateToIso(obj.End),
    start_short: obj.StartShort ?? '',
    end_short: obj.EndShort ?? '',
    city_district: obj.City ?? null,
    address: obj.Address ?? null,
    location_full: null, // 调用方拼接（列表 city + JSON City + JSON Address）
    category: obj.Category ?? null,
    tags,
    max_instance: obj.MaxInstance ?? null,
    registered_count: obj.InstanceNumber ?? null,
    is_free: !!obj.IsFree,
    is_private: !!obj.IsPrivate,
    follows: obj.Follows ?? 0,
    visit_number: obj.VisitNumber ?? 0,
    status: obj.Status ?? 0,
    ticket_tiers,
    guests,
    contact: {
      org_phone: setting.ContactOrgPhone ?? null,
      org_email: setting.ContactOrgEmail ?? null,
      org_qr_code: resolveCdnUrl(setting.ContactOrgQrCode) || null,
      org_description: setting.ContactOrgDescription ?? null,
    },
    organizer_ids: obj.Organizers ?? [],
    create_date: aspNetDateToIso(obj.CreateDate),
    update_date: aspNetDateToIso(obj.UpdateDate),
  };
}

/**
 * 用 list-parser 的 city（"北京"）+ detail JSON 的 City（"朝阳"）+ Address（"三板汇..."）
 * 拼出完整 location 字符串。
 */
export function combineLocation(
  cityFromList: string | null,
  detail: DetailEnrich,
): string | null {
  const parts: string[] = [];
  if (cityFromList) parts.push(cityFromList);
  if (detail.city_district) parts.push(detail.city_district);
  if (detail.address) parts.push(detail.address);
  return parts.length ? parts.join(' · ') : null;
}
