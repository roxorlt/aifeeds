// 单条静态内容页的 JSON 合规口径。
//
// TypeScript 与 SQLite/D1 必须精确等价：
// - 仅 JSON number 1（含 1.0 / 1e0）算 cn_sensitive；
// - boolean true、string "1"、null、缺字段与 malformed JSON 均不算敏感；
// - SQL 对 json_type/json_extract 的调用必须放在 json_valid 的惰性 CASE 分支里，
//   不能依赖 AND/OR 的求值顺序规避 malformed JSON。

export function isCnSensitive(extra: string | null | undefined): boolean {
  if (!extra) return false;
  try {
    return (JSON.parse(extra) as { cn_sensitive?: unknown }).cn_sensitive === 1;
  } catch {
    return false;
  }
}

export function isDedupSuppressed(extra: string | null | undefined): boolean {
  if (!extra) return false;
  try {
    const dedupOf = (JSON.parse(extra) as { dedup_of?: unknown }).dedup_of;
    return dedupOf != null && dedupOf !== '';
  } catch {
    return false;
  }
}

const CN_SENSITIVE_VALUE_SQL = `(CASE
          WHEN json_valid(i.extra) THEN
            CASE
              WHEN json_type(i.extra, '$.cn_sensitive') IN ('integer', 'real') THEN
                CASE WHEN json_extract(i.extra, '$.cn_sensitive') = 1 THEN 1 ELSE 0 END
              ELSE 0
            END
          ELSE 0
        END)`;

export const ITEM_CN_SENSITIVE_SQL = `${CN_SENSITIVE_VALUE_SQL} = 1`;
export const ITEM_CN_NOT_SENSITIVE_SQL = `${CN_SENSITIVE_VALUE_SQL} != 1`;

const DEDUP_SUPPRESSED_VALUE_SQL = `(CASE
          WHEN json_valid(i.extra) THEN
            CASE
              WHEN json_extract(i.extra, '$.dedup_of') IS NULL THEN 0
              WHEN json_extract(i.extra, '$.dedup_of') = '' THEN 0
              ELSE 1
            END
          ELSE 0
        END)`;

export const ITEM_NOT_DEDUPED_SQL = `${DEDUP_SUPPRESSED_VALUE_SQL} != 1`;
export const ITEM_DEDUPED_SQL = `${DEDUP_SUPPRESSED_VALUE_SQL} = 1`;
