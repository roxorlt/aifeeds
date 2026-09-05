/**
 * 手工补录线索的内容生成流水线（`docs/plans/2026-09-05-manual-lead-real-content-spec.md`）。
 *
 * owner 在页面上写的那句话是**线索**，不是成品。这个模块拿着线索去找真实报道、抓回正文，
 * 再用常规新闻那一套提示词写出标题与摘要：
 *
 * ```
 * 有链接：抓正文 → 读懂是什么新闻并拟检索词 → 搜索 → 素材合并 → 生成
 * 无链接：owner 那句话即检索词 → 搜索 → 素材合并 → 生成
 * ```
 *
 * **三条不可动的边界**（规格第 8 节）：
 *
 * 1. **这里的任何失败都不能变成「没能入池」**。所以整个流水线一个异常都不往外抛，每一步
 *    失败都只是「这一步没拿到东西」，最后照样返回一份结果，调用方拿着它去入池 —— 起草
 *    不出来就退回 owner 那句话当标题。
 * 2. **出处信息只走素材正文前缀，共享提示词一个字不改**。分档结论（媒体报道 / 官方 X
 *    账号 / 普通博主）写在每份素材正文前面，模型据此措辞；常规新闻那条生成路径因此零
 *    风险。
 * 3. **起草结果要在写签名快照之前自己先验一遍**。模型偶尔吐出进不了快照的东西，那只该
 *    让这条候选退回那句话，不能让入池被拒。
 */
import {
  OFFICIAL_X_ACCOUNT_ACTORS,
  type OfficialXAccountActor,
} from './manual-news-leads';
import { parseTwitterStatusUrl } from '../security/safe-url-fetch';
import {
  safeManualNewsOwnerAssertedDraft,
  type ManualNewsOwnerAssertedDraft,
} from './manual-news-owner-asserted';
import type { ManualEnrichmentMaterial, ManualEvidenceKind } from './manual-lead-enrichment';
import type { FeedEnrichment } from '../feeds/classify-translate';

/**
 * 卡片上要显示的加工阶段。取值与规格第 4 节的表逐字对应，面板据此写文案。
 *
 * `done` / `failed` 是终态：`done` 说明这一轮加工走完了（无论有没有取到素材，候选此时
 * 已经在池子里），`failed` 说明连入池那一步都没成 —— 只有审核窗口已过之类的情况才会到
 * 这里，卡片要写明卡在哪一步。
 */
export type ManualLeadContentStage =
  | 'submitted'
  | 'fetching_source'
  | 'analyzing'
  | 'searching'
  | 'drafting'
  | 'done'
  | 'failed';

/**
 * 素材分档（规格第 2 节）。
 *
 * - `report` A 档：非 x.com / twitter.com 的链接，算公开报道。
 * - `official_x` B 档：x.com 且 handle 命中 {@link OFFICIAL_X_ACCOUNT_ACTORS}，算第一方公告。
 * - `tweet` C 档：其余推文，是 UGC，不算公开报道。
 * - `none`：一份素材都没取到。
 */
export type ManualLeadMaterialTier = 'report' | 'official_x' | 'tweet' | 'none';

export interface ManualLeadContentMaterial {
  text: string;
  url: string;
  publisher: string;
  kind: ManualEvidenceKind;
  tier: Exclude<ManualLeadMaterialTier, 'none'>;
  /** B 档命中的白名单主体，如 `OpenAI`；其余档是空串。 */
  actor: string;
  /** 推文的 handle（不带 @）；非推文或解析不出来时是空串。 */
  handle: string;
}

/** 交给生成函数的素材正文上限，与 `selectEnrichExcerptForFeeds` 的 `slice(0, 4000)` 同口径。 */
export const MANUAL_LEAD_CONTENT_EXCERPT_MAX_CHARS = 4_000;

/**
 * 整轮加工的总上限。到点立刻走兜底入池，不得挂住。
 *
 * owner 明确说过「一两分钟都可以等，只要拿到结果」，所以这里按各段实际需要给足，而不是
 * 挑一个好看的小数字。2026-09-05 生产实测：抓正文 0.3–2.3s、ScrapeBadger 搜索 8–26s、
 * 生成那一次 DeepSeek 调用本身允许 60s（`classify-translate.ts` 的 `callJson`）。
 */
export const MANUAL_LEAD_CONTENT_BUDGET_MS = 180_000;
/**
 * 分段预算。
 *
 * **生成这一段必须大于它内部那次模型调用的超时**，否则预算比调用还短，慢一点就必被掐死
 * ——2026-09-05 首轮验收就是这么失败的：素材抓到了（档位 report），生成停在 30s 被砍，
 * 候选只能退回 owner 那句话。
 */
export const MANUAL_LEAD_CONTENT_STAGE_BUDGET_MS: Readonly<Record<
  'fetching_source' | 'analyzing' | 'searching' | 'drafting', number
>> = {
  fetching_source: 30_000,
  analyzing: 30_000,
  searching: 50_000,
  drafting: 70_000,
};

const TIER_ORDER: Readonly<Record<Exclude<ManualLeadMaterialTier, 'none'>, number>> = {
  report: 0, official_x: 1, tweet: 2,
};

/**
 * 给一份素材定档。**判据只有 URL**：分档说的是「这段文字是谁发的」，与正文写了什么无关，
 * 拿正文去猜只会给注入留口子。
 */
export function classifyManualLeadMaterial(
  material: ManualEnrichmentMaterial,
): ManualLeadContentMaterial {
  const url = String(material.url || '').trim();
  const base = {
    text: String(material.text || ''),
    url,
    publisher: String(material.publisher || '').trim(),
    kind: material.kind,
  };
  const parsed = parseTwitterStatusUrl(url);
  if (!parsed) {
    // 推文链接解析不出来但网关说这是推文：宁可按最保守的一档走，不能让一条 UGC
    // 因为链接形状少见就被当成公开报道。
    if (material.kind === 'tweet' || /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\//i.test(url)) {
      return { ...base, tier: 'tweet', actor: '', handle: '' };
    }
    return { ...base, tier: 'report', actor: '', handle: '' };
  }
  const official: OfficialXAccountActor | undefined =
    OFFICIAL_X_ACCOUNT_ACTORS.get(parsed.handle.toLowerCase());
  return official
    ? { ...base, tier: 'official_x', actor: official.actor, handle: parsed.handle }
    : { ...base, tier: 'tweet', actor: '', handle: parsed.handle };
}

/**
 * 一份素材正文前面要加的出处说明。
 *
 * 这是整个分档机制唯一的出口 —— 出处信息通过**素材文本**传达，共享提示词一个字不改，
 * 常规新闻那条生成路径因此零风险（规格第 2 节的关键实现要求）。
 */
export function manualLeadMaterialPrefix(material: ManualLeadContentMaterial): string {
  if (material.tier === 'official_x') return `以下内容为 ${material.actor} 官方账号的公告：`;
  if (material.tier === 'tweet') {
    return material.handle
      ? `以下内容为 X 博主 @${material.handle} 的发文，非媒体报道：`
      : '以下内容为 X 博主的发文，非媒体报道：';
  }
  return '';
}

/**
 * A 档优先作主素材，B 档次之，C 档只作补充。同档之间保持传入顺序 —— 先抓到的链接正文
 * 排在搜索召回之前。
 */
export function orderManualLeadMaterials(
  materials: readonly ManualLeadContentMaterial[],
): ManualLeadContentMaterial[] {
  return materials
    .map((material, index) => ({ material, index }))
    .sort((left, right) => (TIER_ORDER[left.material.tier] - TIER_ORDER[right.material.tier])
      || (left.index - right.index))
    .map((entry) => entry.material);
}

/** 把排好序的素材逐份加前缀拼成一份正文，按既有口径截到 4000 字。 */
export function manualLeadContentExcerpt(
  materials: readonly ManualLeadContentMaterial[],
): string {
  return materials
    .map((material) => {
      const prefix = manualLeadMaterialPrefix(material);
      return prefix ? `${prefix}\n${material.text}` : material.text;
    })
    .filter((block) => block.trim())
    .join('\n\n')
    .slice(0, MANUAL_LEAD_CONTENT_EXCERPT_MAX_CHARS);
}

/** 模型读完正文之后给的两样东西：这条新闻的原标题，以及找同一件事其他报道用的检索词。 */
export interface ManualLeadContentAnalysis {
  headline: string;
  query: string;
}

export interface ManualLeadContentAdapters {
  /** 抓 owner 给的那条链接的正文。抓不到回 `null`。 */
  fetchSource(url: string, date: string): Promise<ManualEnrichmentMaterial | null>;
  /** 读懂正文是什么新闻，给出原标题与检索词。给不出回 `null`。 */
  analyze(input: { clue: string; material: ManualEnrichmentMaterial }):
  Promise<ManualLeadContentAnalysis | null>;
  /** 按检索词搜同一件事的其他报道并抓回正文。搜不到回 `null`。 */
  search(query: string, date: string): Promise<ManualEnrichmentMaterial | null>;
  /** 复用常规新闻那一次 enrich 调用写标题与摘要。 */
  generate(input: {
    title: string; excerpt: string; sourceCompany: string;
    lang: 'zh'; kind: 'blog';
  }): Promise<FeedEnrichment | null>;
}

/** 分段预算的可覆盖形状，供调用方按需收紧某一步。 */
export type ManualLeadContentStageBudget = Partial<Record<
  'fetching_source' | 'analyzing' | 'searching' | 'drafting', number
>>;

export interface ManualLeadContentHooks {
  /** 每进入一个阶段报一次，供卡片实时显示。它自己抛异常伤不到整轮。 */
  onStage(stage: ManualLeadContentStage): Promise<void> | void;
}

export interface ManualLeadContentResult {
  /** 起草结果，已按签名快照的口径验过；验不过或没生成时是 `null`。 */
  drafted: ManualNewsOwnerAssertedDraft | null;
  /** 生成出来的正文中译，写进 `extra.excerpt_zh`。 */
  excerptZh: string;
  aiCategory: string;
  /** 交给生成函数的那份素材正文（含出处前缀），也是 `extra.manual_evidence_text` 的来源。 */
  materialExcerpt: string;
  materialTier: ManualLeadMaterialTier;
  materials: ManualLeadContentMaterial[];
  /** 停在哪一步：正常走完是 `null`，被总预算截断时是当时正在做的那一步。 */
  stoppedAt: ManualLeadContentStage | null;
  /** 一句中文说明，直接写给卡片看：这一轮到底缺了什么。 */
  detail: string;
}

/** 让一步受一个时限约束。超时不是错误，是「这一步这次没拿到东西」。 */
function withBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** 一步的统一收口：异常与超时都收敛成 `null`，绝不往外抛。 */
async function step<T>(
  label: string,
  work: () => Promise<T | null>,
  budgetMs: number,
): Promise<T | null> {
  try {
    return await withBudget(
      Promise.resolve().then(work).catch((error) => {
        console.warn(`[manual-lead-content] ${label} failed:`,
          String((error as Error)?.message || error).slice(0, 200));
        return null;
      }),
      budgetMs,
    );
  } catch {
    return null;
  }
}

/**
 * 跑完一条线索的内容生成。**永不抛异常，永远返回一份结果。**
 *
 * 总预算到点时立刻返回当时手上的东西（规格第 4 节：超总预算立即走兜底入池，不得挂住）。
 */
export async function runManualLeadContentPipeline(
  clue: { url: string | null; text: string; date: string },
  adapters: ManualLeadContentAdapters,
  hooks: ManualLeadContentHooks,
  opts: { budgetMs?: number; stageBudgetMs?: ManualLeadContentStageBudget } = {},
): Promise<ManualLeadContentResult> {
  const budgets = { ...MANUAL_LEAD_CONTENT_STAGE_BUDGET_MS, ...(opts.stageBudgetMs || {}) };
  const collected: ManualLeadContentMaterial[] = [];
  const state: { stage: ManualLeadContentStage; detail: string } = {
    stage: 'submitted', detail: '',
  };
  let drafted: ManualNewsOwnerAssertedDraft | null = null;
  let excerptZh = '';
  let aiCategory = '';
  let materialExcerpt = '';
  // 抓回正文里的原标题，只在有链接且分析成功时才有。与 `detail` 分开存 —— 那个字段是
  // 写给卡片看的一句说明，两件事共用一个变量迟早串味。
  let headline = '';

  const enter = async (stage: ManualLeadContentStage): Promise<void> => {
    state.stage = stage;
    try {
      await hooks.onStage(stage);
    } catch (error) {
      // 阶段回写只是给卡片看的进度，写不进去不该让这一轮加工作废。
      console.warn('[manual-lead-content] stage callback failed:',
        String((error as Error)?.message || error).slice(0, 200));
    }
  };

  const work = (async (): Promise<void> => {
    const url = String(clue.url || '').trim();
    const clueText = String(clue.text || '').trim();
    let query = clueText;

    if (url) {
      await enter('fetching_source');
      const source = await step('fetch-source',
        () => adapters.fetchSource(url, clue.date), budgets.fetching_source);
      if (source && String(source.text || '').trim()) {
        collected.push(classifyManualLeadMaterial(source));
        await enter('analyzing');
        const analysis = await step('analyze',
          () => adapters.analyze({ clue: clueText, material: source }), budgets.analyzing);
        // 分析这一步只影响「拿什么去搜」。它挂了就退回 owner 那句话，整轮照跑。
        if (analysis?.query?.trim()) query = analysis.query.trim();
        if (analysis?.headline?.trim()) headline = analysis.headline.trim();
      }
    }

    if (query) {
      await enter('searching');
      const found = await step('search',
        () => adapters.search(query, clue.date), budgets.searching);
      if (found && String(found.text || '').trim()) collected.push(classifyManualLeadMaterial(found));
    }

    const ordered = orderManualLeadMaterials(collected);
    collected.length = 0;
    collected.push(...ordered);
    materialExcerpt = manualLeadContentExcerpt(ordered);
    const primary = ordered[0];
    if (!primary || !materialExcerpt) {
      state.detail = '未取到任何公开素材，标题与口播只能依据你写的这句话';
      return;
    }

    await enter('drafting');
    // 抓到文章时用文章自身的标题；只有搜索素材时退回 owner 那句话（规格第 3 节传参约定）。
    const enrichment = await step('generate', () => adapters.generate({
      title: headline || clueText,
      excerpt: materialExcerpt,
      sourceCompany: primary.publisher,
      lang: 'zh',
      kind: 'blog',
    }), budgets.drafting);
    if (!enrichment) {
      state.detail = '素材已取到，但这一轮生成没写出标题与摘要，先按你写的那句话入池';
      return;
    }
    excerptZh = enrichment.bodyZh;
    aiCategory = enrichment.aiCategory;
    // 起草结果要先过签名快照那一套校验：过不了就当没起草，绝不能把入池拖下水。
    drafted = safeManualNewsOwnerAssertedDraft({
      title: enrichment.titleZh,
      summary: enrichment.aiSummaryZh,
      source: primary.publisher || primary.url,
      url: primary.url,
    });
    state.detail = drafted
      ? ''
      : '这一轮起草出来的标题或摘要不合规，先按你写的那句话入池';
  })();

  const finished = await withBudget(
    work.then(() => true).catch((error) => {
      console.warn('[manual-lead-content] pipeline failed:',
        String((error as Error)?.message || error).slice(0, 200));
      return true;
    }),
    opts.budgetMs ?? MANUAL_LEAD_CONTENT_BUDGET_MS,
  );

  const ordered = orderManualLeadMaterials(collected);
  return {
    drafted,
    excerptZh,
    aiCategory,
    materialExcerpt: materialExcerpt || manualLeadContentExcerpt(ordered),
    materialTier: ordered[0]?.tier || 'none',
    materials: ordered,
    stoppedAt: finished ? null : state.stage,
    detail: finished
      ? state.detail
      : `加工超时，停在「${STAGE_LABELS[state.stage]}」这一步，先按你写的那句话入池`,
  };
}

const STAGE_LABELS: Readonly<Record<ManualLeadContentStage, string>> = {
  submitted: '排队',
  fetching_source: '抓取你给的链接正文',
  analyzing: '读懂这是什么新闻',
  searching: '检索相关报道',
  drafting: '生成标题与口播词',
  done: '已加入候选池',
  failed: '加入候选池',
};
