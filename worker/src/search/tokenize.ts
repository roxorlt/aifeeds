// worker/src/search/tokenize.ts
// 索引侧与查询侧共用的分词器。中文（含日文假名/韩文）连续段切 bigram，
// 拉丁数字段整词保留（词内 - _ . 连接时整词与拆分都入 token），其余字符丢弃。
// CJK 段：平假名/片假名 U+3040-30FF、CJK 扩展A U+3400-4DBF、CJK 统一 U+4E00-9FFF、
// CJK 兼容表意 U+F900-FAFF、韩文音节 U+AC00-D7AF。用显式 \u 转义 + u 标志，
// 避免同形字（豈 U+F900 与 U+8C48 字形相同）把区间撑大到吞掉 emoji 代理对（U+D800-DFFF）。
const CJK_CLASS = "\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af";
const CJK_SINGLE = new RegExp(`^[${CJK_CLASS}]$`, "u");
const RUN_RE = new RegExp(`([a-z0-9]+(?:[-_.][a-z0-9]+)*)|([${CJK_CLASS}]+)`, "gu");

export function tokenizeForSearch(text: string | null | undefined): string[] {
  if (!text) return [];
  const norm = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  RUN_RE.lastIndex = 0;
  while ((m = RUN_RE.exec(norm))) {
    if (m[1]) {
      const word = m[1].slice(0, 32);
      tokens.push(word);
      if (/[-_.]/.test(word)) {
        for (const part of word.split(/[-_.]/)) if (part) tokens.push(part.slice(0, 32));
      }
    } else if (m[2]) {
      const run = m[2];
      if (run.length === 1) tokens.push(run);
      else for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    }
  }
  return tokens;
}

// 用户输入 → MATCH 表达式的唯一入口。token 双引号包裹（内部双引号剔除），
// 隐式 AND；仅当只有单个 token 且其为拉丁≥3 或中文单字时，追加 * 前缀匹配
// （多 token 视为完成的 AND 查询，不加前缀星；渐进联想由 /suggest 单独承担）。
// 禁止任何裸拼接。
export function buildMatchQuery(tokens: string[]): string | null {
  const t = tokens
    .slice(0, 12)
    .map((x) => x.replace(/"/g, ""))
    .filter(Boolean);
  if (t.length === 0) return null;
  const sole = t.length === 1;
  return t
    .map((tok) => {
      const prefix = sole && (CJK_SINGLE.test(tok) || (/^[a-z0-9]+$/.test(tok) && tok.length >= 3));
      return prefix ? `"${tok}"*` : `"${tok}"`;
    })
    .join(" ");
}
