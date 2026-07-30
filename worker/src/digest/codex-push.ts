// 日报内容推送 Codex 渲染机：按阶段锁定 news/ph/gh/hf-paper 的 digest_pool 快照
// → 复用 renderItem 产出完整条目(cover + media + 全字段)→ POST Codex daily/ingest。
// 设计:docs/plans/2026-06-05-daily-codex-push-design.md
//
// 非阻塞:任何失败都只 PushDeer 告警 + 返回结果,绝不抛错(不影响订阅邮件投递)。
// token 复用 X_CARD_SHARED_TOKEN,绝不进 payload / log / 前端。

import type { Env } from '../index';
import { type DigestSource } from './config';
import { slotKey, bjtDateStr, getBases } from './lib';
import { renderItem, type RenderRow, type RenderedItem } from './render';
import { SOURCE_LABELS } from './templates';
import { pushDeerAlert } from '../notifier';
import { getAppliedNewsReviewSelection } from './news-review';

const DEFAULT_DAILY_ENDPOINT = 'https://ai-feeds.cc/aifeeds/api/daily/ingest';
const PUSH_TIMEOUT_MS = 30_000;
// Codex 渲这几源(X/clawhub 暂不打包,等模板扩展)。
// news(行业新闻)推送由 env.NEWS_CODEX_PUSH 门控:默认关,等下游 Codex 适配好 news 板块再开
// (prod 设 NEWS_CODEX_PUSH=1 即生效,无需改码 / 重部署)。
function pushSources(env: Env): DigestSource[] {
  const base: DigestSource[] = ['ph', 'gh', 'hf-paper'];
  return env.NEWS_CODEX_PUSH === '1' ? ['news', ...base] : base;
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(',')}}`;
}

function generatedAtBjt(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' (BJT)';
}

function stagedGeneratedAtBjt(date: string, stage: DailyCodexStage): string {
  const time = stage === 'foundation'
    ? '06:30:00'
    : stage === 'editorial'
      ? '07:50:00'
      : '08:00:00';
  return `${date} ${time} (BJT)`;
}

// Codex item:cover 顶层 + media/logo 进 raw(满足 Codex「多图从 raw.media[] 收集」规则)
interface CodexItem {
  rank: number;
  source: DigestSource;
  title: string;
  summary: string;
  summary_full: string;
  url: string;
  deep_link: string;
  author: string;
  cover: string | null;
  item_id: string;
  segment_id?: string;
  card_index?: number;
  duration_sec?: number; // 播客单集时长(秒),仅 podcast 行业新闻条目有
  guests?: string[]; // 播客本集嘉宾名,仅 podcast 且抽到时有
  intro?: string; // 内容简介:图文→excerpt_zh / 播客→shownotes_zh
  timeline?: RenderedItem['timeline']; // 话题脉络:有原生时间戳文字稿的 podcast 才有
  raw: { media: RenderedItem['media']; logo: string | null };
}

function toCodexItem(r: RenderedItem): CodexItem {
  return {
    rank: r.rank,
    source: r.source,
    title: r.title,
    summary: r.summary,
    summary_full: r.summary_full,
    url: r.url,
    deep_link: r.deep_link,
    author: r.author,
    cover: r.cover,
    item_id: r.item_id,
    ...(r.duration_sec ? { duration_sec: r.duration_sec } : {}),
    ...(r.guests && r.guests.length ? { guests: r.guests } : {}),
    ...(r.intro ? { intro: r.intro } : {}),
    ...(r.timeline && r.timeline.length ? { timeline: r.timeline } : {}),
    raw: { media: r.media, logo: r.logo },
  };
}

async function fetchRows(env: Env, ids: string[]): Promise<Map<string, RenderRow>> {
  if (!ids.length) return new Map();
  const ph = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT id, title, content, content_translated, author, handle, url, media, extra
     FROM items WHERE id IN (${ph})`,
  )
    .bind(...ids)
    .all<RenderRow>();
  return new Map((r.results || []).map((row) => [row.id, row]));
}

function safeIds(s: string | null): string[] {
  try {
    const v = JSON.parse(s || '[]');
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export interface DailyCodexPayload {
  render_key: string;
  date: string;
  density: 'normal';
  title: string;
  source: string;
  digest: {
    meta: {
      generated_at: string;
      density: 'normal';
      source_order: DigestSource[];
      final_source_order?: DigestSource[];
      source_labels: Record<string, string>;
    };
    sections: {
      normal: Array<{ source: DigestSource; source_label: string; count: number; items: CodexItem[] }>;
    };
  };
}

// 读 8 点 digest_pool 快照(= 当天邮件用的同一份内容)→ 复用 renderItem → 组 Codex payload。
export async function buildDailyCodexPayload(
  env: Env,
  slotHourBjt = 8,
  dateOverride?: string, // 'YYYY-MM-DD':重推指定日的池(默认今天)
): Promise<DailyCodexPayload> {
  const PUSH_SOURCES = pushSources(env);
  const date = dateOverride || bjtDateStr();
  const sk = dateOverride
    ? `${dateOverride}-${String(slotHourBjt).padStart(2, '0')}`
    : slotKey(slotHourBjt);
  const { apiBase } = getBases(env);

  const sections: DailyCodexPayload['digest']['sections']['normal'] = [];
  const hashParts: string[] = [];

  for (const source of PUSH_SOURCES) {
    const pool = await env.DB.prepare(
      `SELECT item_ids FROM digest_pool WHERE slot_key = ? AND source = ? AND density = 'normal'`,
    )
      .bind(sk, source)
      .first<{ item_ids: string }>();
    const ids = safeIds(pool?.item_ids ?? null);
    if (!ids.length) continue;
    const rows = await fetchRows(env, ids);
    const items: CodexItem[] = [];
    ids.forEach((id, i) => {
      const row = rows.get(id);
      if (!row) return;
      const rendered = renderItem(source, row, i + 1, apiBase);
      items.push(toCodexItem(rendered));
      hashParts.push(`${id}|${rendered.title}`);
    });
    if (!items.length) continue;
    sections.push({ source, source_label: SOURCE_LABELS[source] || source, count: items.length, items });
  }

  // 内容指纹幂等:item_ids + title 变了才换 render_key(Codex 命中同 key 不重复生成)
  const hash8 = (await sha256Hex(hashParts.join('\n'))).slice(0, 8);
  const generatedAt = generatedAtBjt();

  return {
    render_key: `daily-${date}-normal-${hash8}`,
    date,
    density: 'normal',
    title: `AI Feeds ${date} 日报`,
    source: 'cloudflare-daily',
    digest: {
      meta: {
        generated_at: generatedAt,
        density: 'normal',
        source_order: PUSH_SOURCES,
        source_labels: Object.fromEntries(PUSH_SOURCES.map((s) => [s, SOURCE_LABELS[s] || s])),
      },
      sections: { normal: sections },
    },
  };
}

export const DAILY_CODEX_EXPECTED_STAGES = ['foundation', 'editorial', 'papers'] as const;
export type DailyCodexInputStage = (typeof DAILY_CODEX_EXPECTED_STAGES)[number];
export type DailyCodexStage = DailyCodexInputStage | 'finalize';

// 这是日报视频专用的来源契约。共享 digest_pool 的 editorial 阶段仍会刷新
// news/X，供邮件、静态日报等业务使用；视频 payload 只选择 news。
const DAILY_CODEX_STAGE_SOURCES: Record<DailyCodexInputStage, readonly DigestSource[]> = {
  foundation: ['ph', 'gh'],
  editorial: ['news'],
  papers: ['hf-paper'],
};
const FINAL_SECTION_ORDER: readonly DigestSource[] = ['news', 'ph', 'gh', 'hf-paper'];

function sourcesForStage(stage: DailyCodexStage): readonly DigestSource[] {
  return stage === 'finalize' ? FINAL_SECTION_ORDER : DAILY_CODEX_STAGE_SOURCES[stage];
}

function inputStageForSource(source: DigestSource): DailyCodexInputStage {
  if (source === 'ph' || source === 'gh') return 'foundation';
  if (source === 'news') return 'editorial';
  if (source === 'hf-paper') return 'papers';
  throw new Error(`unsupported_staged_source:${source}`);
}

export interface DailyStageState {
  stage: DailyCodexStage;
  revision: number;
  content_hash: string;
  pushed_at?: number;
  // Immutable payload snapshot selected for this revision. The shared
  // digest_pool rows remain live and can be rebuilt by later jobs, so the
  // 08:00 final manifest must never reconstruct a locked stage from them.
  snapshot?: DailyCodexPayload['digest'];
}

export interface DailyStageRevisionRef {
  revision: number;
  content_hash: string;
}

export interface DailyFinalManifestItem {
  segment_id: string;
  item_id: string;
  source: DigestSource;
  card_index: number;
  stage: DailyCodexInputStage;
  revision: number;
}

export interface DailyFinalManifest {
  stage_revisions: Record<DailyCodexInputStage, DailyStageRevisionRef>;
  section_order: DigestSource[];
  items: DailyFinalManifestItem[];
  manifest_hash: string;
}

export interface StagedDailyCodexPayload {
  protocol_version: 2;
  date: string;
  density: 'normal';
  batch_id: string;
  stage: DailyCodexStage;
  revision: number;
  content_hash: string;
  render_key: string;
  expected_stages: DailyCodexInputStage[];
  title: string;
  source: 'cloudflare-daily-staged';
  digest: DailyCodexPayload['digest'];
  final_manifest: DailyFinalManifest | null;
}

function stageStateSource(stage: DailyCodexStage): string {
  return `_codex_stage_${stage}`;
}

function parseStageState(raw: string | null | undefined, stage: DailyCodexStage): DailyStageState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<DailyStageState>;
    if (
      value.stage !== stage ||
      !Number.isInteger(value.revision) ||
      Number(value.revision) < 1 ||
      typeof value.content_hash !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(value.content_hash)
    ) return null;
    return {
      stage,
      revision: Number(value.revision),
      content_hash: value.content_hash,
      ...(typeof value.pushed_at === 'number' ? { pushed_at: value.pushed_at } : {}),
      ...(value.snapshot && typeof value.snapshot === 'object'
        ? { snapshot: value.snapshot as DailyCodexPayload['digest'] }
        : {}),
    };
  } catch {
    return null;
  }
}

export async function getDailyStageState(
  env: Env,
  date: string,
  stage: DailyCodexStage,
): Promise<DailyStageState | null> {
  const row = await env.DB.prepare(
    `SELECT items_meta FROM digest_pool WHERE slot_key = ? AND source = ? AND density = ?`,
  )
    .bind(`${date}-08`, stageStateSource(stage), 'meta')
    .first<{ items_meta: string | null }>();
  return parseStageState(row?.items_meta, stage);
}

async function persistDailyStageState(env: Env, date: string, state: DailyStageState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO digest_pool (slot_key, source, density, item_ids, items_meta, generated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slot_key, source, density) DO UPDATE SET
       item_ids = excluded.item_ids, items_meta = excluded.items_meta, generated_at = excluded.generated_at`,
  )
    .bind(
      `${date}-08`,
      stageStateSource(state.stage),
      'meta',
      '[]',
      JSON.stringify(state),
      Date.now(),
    )
    .run();
}

async function markDailyStagePushed(
  env: Env,
  date: string,
  stage: DailyCodexStage,
  revision: number,
  contentHash: string,
): Promise<void> {
  const current = await getDailyStageState(env, date, stage);
  if (!current || current.revision !== revision || current.content_hash !== contentHash) {
    throw new Error(`stage_state_changed_during_push:${stage}`);
  }
  await persistDailyStageState(env, date, { ...current, pushed_at: Date.now() });
}

async function buildCodexSections(
  env: Env,
  sk: string,
  sources: readonly DigestSource[],
): Promise<DailyCodexPayload['digest']['sections']['normal']> {
  const { apiBase } = getBases(env);
  const reviewDate = sk.slice(0, 10);
  const reviewedNewsIds = sources.includes('news')
    ? await getAppliedNewsReviewSelection(env, reviewDate)
    : null;
  const sections: DailyCodexPayload['digest']['sections']['normal'] = [];
  let stageCardIndex = 0;
  for (const source of sources) {
    const pool = await env.DB.prepare(
      `SELECT item_ids FROM digest_pool WHERE slot_key = ? AND source = ? AND density = 'normal'`,
    )
      .bind(sk, source)
      .first<{ item_ids: string }>();
    const ids = source === 'news' && reviewedNewsIds
      ? reviewedNewsIds
      : safeIds(pool?.item_ids ?? null);
    if (!ids.length) continue;
    const rows = await fetchRows(env, ids);
    const items: CodexItem[] = [];
    for (let index = 0; index < ids.length; index++) {
      const id = ids[index];
      const row = rows.get(id);
      if (!row) continue;
      const item = toCodexItem(renderItem(source, row, index + 1, apiBase));
      const segmentHash = (await sha256Hex(`${source}\0${item.item_id}`)).slice(0, 16);
      items.push({
        ...item,
        segment_id: `segment-${source}-${segmentHash}`,
        card_index: ++stageCardIndex,
      });
    }
    if (items.length) {
      sections.push({ source, source_label: SOURCE_LABELS[source] || source, count: items.length, items });
    }
  }
  return sections;
}

interface LockedStageSnapshot {
  state: DailyStageState;
  digest: DailyCodexPayload['digest'];
}

async function loadLockedStageSnapshots(
  env: Env,
  date: string,
): Promise<Record<DailyCodexInputStage, LockedStageSnapshot>> {
  const snapshots = {} as Record<DailyCodexInputStage, LockedStageSnapshot>;
  for (const stage of DAILY_CODEX_EXPECTED_STAGES) {
    const state = await getDailyStageState(env, date, stage);
    if (!state) throw new Error(`missing_stage_state:${stage}`);
    if (!state.snapshot) throw new Error(`missing_stage_snapshot:${stage}`);
    const snapshotHash = `sha256:${await sha256Hex(stableJson(state.snapshot))}`;
    if (snapshotHash !== state.content_hash) throw new Error(`stage_snapshot_hash_mismatch:${stage}`);

    const expectedSources = new Set(DAILY_CODEX_STAGE_SOURCES[stage]);
    const seenSources = new Set<DigestSource>();
    for (const section of state.snapshot.sections.normal) {
      if (!expectedSources.has(section.source) || seenSources.has(section.source)) {
        throw new Error(`stage_snapshot_sources_invalid:${stage}`);
      }
      seenSources.add(section.source);
    }
    snapshots[stage] = { state, digest: state.snapshot };
  }
  return snapshots;
}

function combineLockedStageSections(
  snapshots: Record<DailyCodexInputStage, LockedStageSnapshot>,
): DailyCodexPayload['digest']['sections']['normal'] {
  const sections: DailyCodexPayload['digest']['sections']['normal'] = [];
  let cardIndex = 0;
  for (const source of FINAL_SECTION_ORDER) {
    const stage = inputStageForSource(source);
    const locked = snapshots[stage].digest.sections.normal.find((section) => section.source === source);
    if (!locked) continue;
    const items = locked.items.map((item) => ({ ...item, card_index: ++cardIndex }));
    sections.push({ ...locked, count: items.length, items });
  }
  return sections;
}

async function buildFinalManifest(
  snapshots: Record<DailyCodexInputStage, LockedStageSnapshot>,
  sections: DailyCodexPayload['digest']['sections']['normal'],
): Promise<DailyFinalManifest> {
  const stageRevisions = Object.fromEntries(DAILY_CODEX_EXPECTED_STAGES.map((stage) => [stage, {
    revision: snapshots[stage].state.revision,
    content_hash: snapshots[stage].state.content_hash,
  }])) as Record<DailyCodexInputStage, DailyStageRevisionRef>;

  const items: DailyFinalManifestItem[] = [];
  for (const section of sections) {
    const itemStage = inputStageForSource(section.source);
    for (const item of section.items) {
      items.push({
        segment_id: item.segment_id!,
        item_id: item.item_id,
        source: section.source,
        card_index: item.card_index!,
        stage: itemStage,
        revision: snapshots[itemStage].state.revision,
      });
    }
  }
  const core = {
    stage_revisions: stageRevisions,
    section_order: sections.map((section) => section.source),
    items,
  };
  return {
    ...core,
    manifest_hash: `sha256:${await sha256Hex(stableJson(core))}`,
  };
}

export async function buildStagedDailyCodexPayload(
  env: Env,
  stage: DailyCodexStage,
  opts: { date?: string; persistRevision?: boolean } = {},
): Promise<StagedDailyCodexPayload> {
  const date = opts.date || bjtDateStr();
  const sources = sourcesForStage(stage);
  const lockedSnapshots = stage === 'finalize' ? await loadLockedStageSnapshots(env, date) : null;
  const sections = lockedSnapshots
    ? combineLockedStageSections(lockedSnapshots)
    : await buildCodexSections(env, `${date}-08`, sources);
  const total = sections.reduce((count, section) => count + section.count, 0);
  if (!total) throw new Error(`empty_stage:${stage}`);

  const digest: DailyCodexPayload['digest'] = {
    meta: {
      // This field participates in content_hash. Keep it deterministic for a
      // date/stage so retries and the 08:00 finalize integrity check see the
      // same snapshot hash when the selected content has not changed.
      generated_at: stagedGeneratedAtBjt(date, stage),
      density: 'normal',
      source_order: [...sources],
      final_source_order: [...FINAL_SECTION_ORDER],
      source_labels: Object.fromEntries(sources.map((source) => [source, SOURCE_LABELS[source] || source])),
    },
    sections: { normal: sections },
  };
  const finalManifest = lockedSnapshots ? await buildFinalManifest(lockedSnapshots, sections) : null;
  // 跨端契约：content_hash 只覆盖实际 digest，HK 可在 ingest 时独立重算并拒绝
  // 传输损坏；final_manifest 另有自己的 manifest_hash，职责不混用。
  const contentHash = `sha256:${await sha256Hex(stableJson(digest))}`;
  const previous = await getDailyStageState(env, date, stage);
  const revision = previous?.content_hash === contentHash ? previous.revision : (previous?.revision || 0) + 1;
  if (opts.persistRevision) {
    await persistDailyStageState(env, date, {
      stage,
      revision,
      content_hash: contentHash,
      ...(previous?.content_hash === contentHash && previous.pushed_at ? { pushed_at: previous.pushed_at } : {}),
      snapshot: digest,
    });
  }
  return {
    protocol_version: 2,
    date,
    density: 'normal',
    batch_id: `daily-${date}-normal`,
    stage,
    revision,
    content_hash: contentHash,
    render_key: `daily-${date}-normal-${stage}-r${revision}-${contentHash.slice(7, 15)}`,
    expected_stages: [...DAILY_CODEX_EXPECTED_STAGES],
    title: `AI Feeds ${date} 日报`,
    source: 'cloudflare-daily-staged',
    digest,
    final_manifest: finalManifest,
  };
}

export interface DailyPushResult {
  ok: boolean;
  skipped?: string;
  render_key?: string;
  total_items?: number;
  codex_id?: string;
  codex_status?: string;
  stage?: DailyCodexStage;
  revision?: number;
  content_hash?: string;
  error?: string;
}

function stagedDailyEndpoint(env: Env): string | null {
  if (getBases(env).apiBase.includes('//api.ai-feeds.com')) {
    return env.DAILY_PUSH_ENDPOINT || DEFAULT_DAILY_ENDPOINT;
  }
  const staging = env.DAILY_PUSH_STAGING_ENDPOINT;
  if (!staging) return null;
  try {
    const candidate = new URL(staging);
    const production = new URL(DEFAULT_DAILY_ENDPOINT);
    if (
      candidate.origin === production.origin &&
      candidate.pathname.replace(/\/+$/, '') === production.pathname.replace(/\/+$/, '')
    ) return null;
  } catch {
    return null;
  }
  return staging;
}

async function postDailyPayload(endpoint: string, token: string, body: string): Promise<Response> {
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(tid);
    }
  };
  try {
    const first = await attempt();
    return first.status >= 500 ? await attempt() : first;
  } catch {
    return await attempt();
  }
}

// v2 stage push:revision/hash 在网络调用前固化，成功响应后才写 pushed_at。Workflow
// step 失败重试会复用同 revision/hash；08:00 可据 pushed_at 精确识别缺批并补推。
export async function pushDailyStageToCodex(
  env: Env,
  stage: DailyCodexStage,
  dateOverride?: string,
): Promise<DailyPushResult> {
  if (!env.X_CARD_SHARED_TOKEN) return { ok: false, skipped: 'no_token', stage };
  const endpoint = stagedDailyEndpoint(env);
  if (!endpoint) return { ok: false, skipped: 'non_prod_or_staging_endpoint_missing', stage };
  if (stage === 'finalize') {
    for (const inputStage of DAILY_CODEX_EXPECTED_STAGES) {
      const state = await getDailyStageState(env, dateOverride || bjtDateStr(), inputStage);
      if (!state?.pushed_at) {
        return { ok: false, stage, error: `stage_not_pushed:${inputStage}` };
      }
    }
  }

  let payload: StagedDailyCodexPayload;
  try {
    payload = await buildStagedDailyCodexPayload(env, stage, {
      date: dateOverride,
      persistRevision: true,
    });
  } catch (error) {
    const message = String(error).slice(0, 200);
    await pushDeerAlert(env, '分批日报推 Codex 失败', `${stage} 构造 payload 异常: ${message}`).catch(() => {});
    return { ok: false, stage, error: message };
  }

  const total = payload.digest.sections.normal.reduce((count, section) => count + section.count, 0);
  let response: Response;
  try {
    response = await postDailyPayload(endpoint, env.X_CARD_SHARED_TOKEN, JSON.stringify(payload));
  } catch (error) {
    const message = `network: ${String(error).slice(0, 160)}`;
    await pushDeerAlert(env, '分批日报推 Codex 失败', `${payload.render_key}: ${message}`).catch(() => {});
    return {
      ok: false, stage, revision: payload.revision, content_hash: payload.content_hash,
      render_key: payload.render_key, total_items: total, error: message,
    };
  }
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 200);
    const error = `http_${response.status}: ${text}`;
    await pushDeerAlert(env, '分批日报推 Codex 失败', `${payload.render_key}: ${error}`).catch(() => {});
    return {
      ok: false, stage, revision: payload.revision, content_hash: payload.content_hash,
      render_key: payload.render_key, total_items: total, error,
    };
  }

  try {
    await markDailyStagePushed(env, payload.date, stage, payload.revision, payload.content_hash);
  } catch (error) {
    const message = String(error).slice(0, 200);
    await pushDeerAlert(env, '分批日报状态落库失败', `${payload.render_key}: ${message}`).catch(() => {});
    return {
      ok: false, stage, revision: payload.revision, content_hash: payload.content_hash,
      render_key: payload.render_key, total_items: total, error: message,
    };
  }
  const data = (await response.json().catch(() => ({}))) as { id?: string; status?: string };
  console.log(`[daily-codex-stage] ${payload.render_key} items=${total} → id=${data.id} status=${data.status}`);
  return {
    ok: true,
    stage,
    revision: payload.revision,
    content_hash: payload.content_hash,
    render_key: payload.render_key,
    total_items: total,
    codex_id: data.id,
    codex_status: data.status,
  };
}

// 构造 payload + POST Codex。内部对 5xx/网络错重试一次。永不抛错(非阻塞)。
export async function pushDailyToCodex(env: Env, slotHourBjt = 8, dateOverride?: string): Promise<DailyPushResult> {
  if (!env.X_CARD_SHARED_TOKEN) return { ok: false, skipped: 'no_token' };

  // 闸:只有 prod 能真推到 Codex 生产端;staging/dev 一律拦死(防假数据污染 Codex,2026-06-07 事故)。
  // staging 验证只能用 dry=1 看 payload 结构,绝不真推。
  if (!getBases(env).apiBase.includes('//api.ai-feeds.com')) {
    return { ok: false, skipped: 'non_prod_blocked' };
  }

  let payload: DailyCodexPayload;
  try {
    payload = await buildDailyCodexPayload(env, slotHourBjt, dateOverride);
  } catch (e) {
    const error = String(e).slice(0, 200);
    await pushDeerAlert(env, '日报推 Codex 失败', `构造 payload 异常: ${error}`).catch(() => {});
    return { ok: false, error };
  }

  const total = payload.digest.sections.normal.reduce((n, s) => n + s.count, 0);
  if (!total) return { ok: false, skipped: 'empty_pool', render_key: payload.render_key };

  const endpoint = env.DAILY_PUSH_ENDPOINT || DEFAULT_DAILY_ENDPOINT;
  const body = JSON.stringify(payload);

  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.X_CARD_SHARED_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(tid);
    }
  };

  let res: Response;
  try {
    res = await attempt();
    if (res.status >= 500) res = await attempt(); // 5xx 重试一次
  } catch (e) {
    // 网络/超时:重试一次
    try {
      res = await attempt();
    } catch (e2) {
      const error = `network: ${String(e2).slice(0, 160)}`;
      await pushDeerAlert(env, '日报推 Codex 失败', `${payload.render_key}: ${error}`).catch(() => {});
      return { ok: false, error, render_key: payload.render_key, total_items: total };
    }
  }

  if (!res.ok) {
    const txt = (await res.text().catch(() => '')).slice(0, 200);
    const error = `http_${res.status}: ${txt}`;
    await pushDeerAlert(env, '日报推 Codex 失败', `${payload.render_key}: ${error}`).catch(() => {});
    return { ok: false, error, render_key: payload.render_key, total_items: total };
  }

  // Codex 返回 202 { id, status, ... }
  const data = (await res.json().catch(() => ({}))) as { id?: string; status?: string };
  console.log(`[daily-codex-push] ${payload.render_key} items=${total} → id=${data.id} status=${data.status}`);
  return {
    ok: true,
    render_key: payload.render_key,
    total_items: total,
    codex_id: data.id,
    codex_status: data.status,
  };
}
