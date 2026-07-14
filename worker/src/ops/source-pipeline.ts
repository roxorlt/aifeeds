import { triggerGhWorkflowForItem } from '../github';
import {
  triggerHfPaperWorkflowForItem,
  type HfPaperWorkflowSignals,
} from '../scrapers/hf-paper';
import { GITHUB_CANDIDATE_TIME_EXPR } from '../digest/selection';

type GithubDrainEnv = {
  DB: D1Database;
  GITHUB_PIPELINE_WORKFLOW?: Workflow;
};

type HfDrainEnv = {
  DB: D1Database;
  HF_PAPER_PIPELINE_WORKFLOW?: Workflow;
};

type ReadinessEnv = { DB: D1Database };

type PendingRow = {
  id: string;
  extra: string | null;
};

type SummaryRow = {
  pending: number | null;
  ready: number | null;
  oldest_scraped_at: string | null;
};

export type SourceReadiness = {
  pending: number;
  ready: number;
  eligibleReady: number;
  oldestAge: number | null;
};

export type SourceDrainResult = SourceReadiness & {
  source: 'github' | 'hf-paper';
  picked: number;
  started: number;
  skipped: number;
  alreadyExists: number;
  retryable: number;
  failed: number;
};

export type SourceDrainOptions = {
  limit?: number;
  retryAfterSeconds?: number;
  now?: Date;
};

export const GITHUB_STUCK_EXPR = `(
  COALESCE(json_extract(extra, '$.gh_pending'), 0) IN (1, 'true')
  OR is_relevant IS NULL
  OR (
    is_relevant = 1
    AND json_extract(extra, '$.readme_translated') IS NULL
    AND COALESCE(json_extract(extra, '$.readme_lang'), 'other') != 'zh'
    AND json_extract(extra, '$.readme_excerpt') IS NOT NULL
  )
  OR (
    is_relevant = 1
    AND json_extract(extra, '$.r2_migrated_at') IS NULL
    AND json_extract(extra, '$.readme_excerpt') IS NOT NULL
  )
)`;
export const GITHUB_ELIGIBLE_READY_EXPR = `(
  is_relevant = 1
  AND json_extract(extra, '$.workflow_completed_at') IS NOT NULL
  AND NOT ${GITHUB_STUCK_EXPR}
  AND ${GITHUB_CANDIDATE_TIME_EXPR} >= datetime('now', '-1 day')
)`;
export const HF_ELIGIBLE_READY_EXPR = `(
  json_extract(extra, '$.workflow_completed_at') IS NOT NULL
  AND json_extract(extra, '$.ai_summary_zh') IS NOT NULL
  AND json_extract(extra, '$.ai_summary_zh') != ''
  AND datetime(scraped_at) >= datetime('now', '-3 day')
)`;
const HF_PENDING = `json_extract(extra, '$.workflow_completed_at') IS NULL`;
// Existing GH/HF trigger helpers use an hour-bucket Workflow instance ID.
// Matching the eligibility cooldown to that generation prevents a :20 attempt
// from being selected again at :50 with the same ID, while the next hour gets
// a fresh instance even if the previous one exists in a failed state.
const RETRY_AFTER_SECONDS = 60 * 60;

function boundedLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return 20;
  return Math.min(Math.max(Math.trunc(value as number), 1), 200);
}

function retryCutoff(options: SourceDrainOptions): number {
  const now = options.now ?? new Date();
  const retryAfter = Number.isFinite(options.retryAfterSeconds)
    ? Math.max(RETRY_AFTER_SECONDS, Math.trunc(options.retryAfterSeconds as number))
    : RETRY_AFTER_SECONDS;
  return Math.floor(now.getTime() / 1000) - retryAfter;
}

function oldestAge(oldestScrapedAt: string | null, now: Date): number | null {
  if (!oldestScrapedAt) return null;
  const oldestMs = Date.parse(oldestScrapedAt);
  if (!Number.isFinite(oldestMs)) return null;
  return Math.max(0, Math.floor((now.getTime() - oldestMs) / 1000));
}

async function readReadiness(
  env: ReadinessEnv,
  source: 'github' | 'hf-paper',
  now: Date,
): Promise<SourceReadiness> {
  const isGithub = source === 'github';
  const sourceType = isGithub ? 'github' : 'hf_paper';
  const pendingExpr = isGithub ? GITHUB_STUCK_EXPR : HF_PENDING;
  const readyExpr = isGithub ? GITHUB_ELIGIBLE_READY_EXPR : HF_ELIGIBLE_READY_EXPR;
  const row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN ${pendingExpr} THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN ${readyExpr} THEN 1 ELSE 0 END), 0) AS ready,
       MIN(CASE WHEN ${pendingExpr} THEN scraped_at END) AS oldest_scraped_at
       FROM items
      WHERE source_type='${sourceType}'
        AND deleted_at IS NULL`,
  ).first<SummaryRow>();
  const ready = Number(row?.ready ?? 0);
  return {
    pending: Number(row?.pending ?? 0),
    ready,
    eligibleReady: ready,
    oldestAge: oldestAge(row?.oldest_scraped_at ?? null, now),
  };
}

async function pickPending(
  env: ReadinessEnv,
  source: 'github' | 'hf-paper',
  options: SourceDrainOptions,
): Promise<PendingRow[]> {
  const isGithub = source === 'github';
  const sourceType = isGithub ? 'github' : 'hf_paper';
  const pendingExpr = isGithub ? GITHUB_STUCK_EXPR : HF_PENDING;
  const rows = await env.DB.prepare(
    `SELECT id, extra
       FROM items
      WHERE source_type='${sourceType}'
        AND deleted_at IS NULL
        AND ${pendingExpr}
        AND (
          json_extract(extra, '$.workflow_triggered_at') IS NULL
          OR CAST(json_extract(extra, '$.workflow_triggered_at') AS INTEGER) <= ?
        )
      ORDER BY datetime(scraped_at) ASC, id ASC
      LIMIT ?`,
  ).bind(retryCutoff(options), boundedLimit(options.limit)).all<PendingRow>();
  return rows.results ?? [];
}

function parseHfSignals(extraJson: string | null): HfPaperWorkflowSignals {
  let extra: Record<string, unknown> = {};
  try {
    extra = JSON.parse(extraJson || '{}') as Record<string, unknown>;
  } catch {
    // A malformed extra must not make the whole bounded drain fail.
  }
  return {
    hasGhRepo: !!extra.github_repo,
    hasProjectPage: !!extra.project_page,
    hasDiscussionId: !!extra.discussion_id,
  };
}

export async function getSourceReadiness(
  env: ReadinessEnv,
  now: Date = new Date(),
): Promise<{ github: SourceReadiness; hfPaper: SourceReadiness }> {
  const [github, hfPaper] = await Promise.all([
    readReadiness(env, 'github', now),
    readReadiness(env, 'hf-paper', now),
  ]);
  return { github, hfPaper };
}

export async function drainGithubPending(
  env: GithubDrainEnv,
  options: SourceDrainOptions = {},
): Promise<SourceDrainResult> {
  const now = options.now ?? new Date();
  const readiness = await readReadiness(env, 'github', now);
  const rows = await pickPending(env, 'github', { ...options, now });
  let started = 0;
  let alreadyExists = 0;
  let failed = 0;
  for (const row of rows) {
    const result = await triggerGhWorkflowForItem(env, row.id);
    if (result === 'triggered') started++;
    else if (result === 'already_exists') alreadyExists++;
    else failed++;
  }
  return {
    source: 'github',
    picked: rows.length,
    started,
    skipped: alreadyExists,
    alreadyExists,
    retryable: alreadyExists + failed,
    failed,
    ...readiness,
  };
}

export async function drainHfPending(
  env: HfDrainEnv,
  options: SourceDrainOptions = {},
): Promise<SourceDrainResult> {
  const now = options.now ?? new Date();
  const readiness = await readReadiness(env, 'hf-paper', now);
  const rows = await pickPending(env, 'hf-paper', { ...options, now });
  let started = 0;
  let alreadyExists = 0;
  let failed = 0;
  for (const row of rows) {
    const arxivId = row.id.replace(/^hf_paper:/, '');
    const result = await triggerHfPaperWorkflowForItem(
      env,
      row.id,
      arxivId,
      parseHfSignals(row.extra),
    );
    if (result === 'triggered') started++;
    else if (result === 'already_exists') alreadyExists++;
    else failed++;
  }
  return {
    source: 'hf-paper',
    picked: rows.length,
    started,
    skipped: alreadyExists,
    alreadyExists,
    retryable: alreadyExists + failed,
    failed,
    ...readiness,
  };
}
