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

// extraExpression 只能由代码内调用点提供（当前为 `i.extra` / 测试别名），不得接收请求输入。
function cnSensitiveValueSql(extraExpression: string): string {
  return `(CASE
          WHEN json_valid(${extraExpression}) THEN
            CASE
              WHEN json_type(${extraExpression}, '$.cn_sensitive') IN ('integer', 'real') THEN
                CASE WHEN json_extract(${extraExpression}, '$.cn_sensitive') = 1 THEN 1 ELSE 0 END
              ELSE 0
            END
          ELSE 0
        END)`;
}

export function itemCnSensitiveSql(extraExpression: string): string {
  return `${cnSensitiveValueSql(extraExpression)} = 1`;
}

export function itemCnNotSensitiveSql(extraExpression: string): string {
  return `${cnSensitiveValueSql(extraExpression)} != 1`;
}

function dedupSuppressedValueSql(extraExpression: string): string {
  return `(CASE
          WHEN json_valid(${extraExpression}) THEN
            CASE
              WHEN json_extract(${extraExpression}, '$.dedup_of') IS NULL THEN 0
              WHEN json_extract(${extraExpression}, '$.dedup_of') = '' THEN 0
              ELSE 1
            END
          ELSE 0
        END)`;
}

export function itemNotDedupedSql(extraExpression: string): string {
  return `${dedupSuppressedValueSql(extraExpression)} != 1`;
}

export function itemDedupedSql(extraExpression: string): string {
  return `${dedupSuppressedValueSql(extraExpression)} = 1`;
}
