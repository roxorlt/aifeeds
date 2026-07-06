// 搜索历史（localStorage 本地态，不同步后端）。LRU 20，重复词提到最前。
// key = aifeeds_search_history。隐私模式 / 配额满等异常一律静默降级为空。
const KEY = "aifeeds_search_history";
const MAX = 20;

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function write(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)));
  } catch {
    /* 隐私模式 / 配额满等忽略 */
  }
}

export const getSearchHistory = read;

export function addSearchHistory(q: string) {
  const t = q.trim();
  if (!t) return;
  write([t, ...read().filter((x) => x !== t)]);
}

export function removeSearchHistory(q: string) {
  write(read().filter((x) => x !== q));
}

export function clearSearchHistory() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 同上,静默 */
  }
}
