/**
 * 读路径的分步耗时探针。只记步骤名与毫秒数，不记任何数据内容；
 * `wrangler tail` 里按 `[news-review-timing]` 过滤即可拿到真实分布。
 *
 * 单独成一个模块是为了让 news-review.ts 与 news-source-policy.ts 都能用它，
 * 而不制造 news-review ↔ news-source-policy 的循环 import。
 */
export async function timedNewsReviewStep<T>(step: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await run();
  } finally {
    console.log(`[news-review-timing] ${step} ${Date.now() - started}ms`);
  }
}
