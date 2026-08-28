import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Shared CI runners can starve crypto-heavy upper-bound tests under default parallelism.
    ...(process.env.CI ? { maxWorkers: 2 } : {}),
    // 历史遗留：以下 8 个测试文件用的是 Node 内置 runner（`import test from 'node:test'`），
    // 不是 vitest 风格。vitest 无法解析其 test() 注册，会误报 "No test suite found" 而使
    // `npm test` 变红。它们此前并未挂到任何 npm script（worker 之前没有 test 脚本），故排除
    // 后保持原状（仍可用 `node --test <file>` 单独跑）。是否统一迁移到 vitest 由后续任务决定。
    exclude: [
      ...configDefaults.exclude,
      'src/feedback.test.ts',
      'src/digest/node-run-subject.test.ts',
      'src/feeds/classify-translate.test.ts',
      'src/feeds/ranking.test.ts',
      'src/feeds/event-fingerprint-backfill.test.ts',
      'src/feeds/parse-weibo-cookie.test.ts',
      // C 端搜索测试同为 node:test 风格（`node:test` 的 test()），用 `tsx --test` 跑（35 条全过）。
      // rebase onto main 引入 vitest 后被 glob 命中会误报 "No test suite found"，同上排除。
      'src/search/tokenize.test.ts',
      'src/search/ranking.test.ts',
      'src/search/sync.test.ts',
      'src/search/terms.test.ts',
      'src/search/handlers.test.ts',
    ],
  },
});
