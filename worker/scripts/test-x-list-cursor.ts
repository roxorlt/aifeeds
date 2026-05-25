// 纯函数 ad-hoc 测试。运行：npx tsx worker/scripts/test-x-list-cursor.ts
// 不依赖 D1/SB/workflow runtime，纯逻辑断言。
//
// 设计参考: docs/plans/2026-05-22-x-list-cursor-driven-design.md

import {
  parseSeenSet,
  serializeSeenSet,
  findStopIndex,
  partitionForCatchup,
} from '../src/x-list-cursor';

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}`);
  }
}

function eq<T>(actual: T, expected: T, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ✓ ${msg}`);
  } else {
    fail++;
    console.error(`  ✗ ${msg}\n      expected: ${e}\n      actual:   ${a}`);
  }
}

// ─── parseSeenSet ───────────────────────────────────────────────
console.log('\nparseSeenSet:');
eq(parseSeenSet(null), new Set<string>(), 'null → 空 Set（冷启动）');
eq(parseSeenSet(''), new Set<string>(), '空串 → 空 Set');
eq(
  parseSeenSet('["A","B","C"]'),
  new Set(['A', 'B', 'C']),
  '合法 JSON → Set',
);
eq(parseSeenSet('not json'), new Set<string>(), '非法 JSON → 空 Set（容错）');
eq(parseSeenSet('{}'), new Set<string>(), '非数组 → 空 Set（容错）');

// ─── serializeSeenSet ───────────────────────────────────────────
console.log('\nserializeSeenSet:');
eq(serializeSeenSet([]), '[]', '空数组 → "[]"');
eq(
  serializeSeenSet(['N1', 'N2', 'N3']),
  '["N1","N2","N3"]',
  '3 个 id → JSON 数组',
);
eq(
  serializeSeenSet(['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8', 'N9', 'N10', 'N11', 'N12']),
  '["N1","N2","N3","N4","N5","N6","N7","N8","N9","N10"]',
  '> 10 个 id 自动截断为前 10 个',
);

// ─── findStopIndex ──────────────────────────────────────────────
// 返回 page 内第一个命中 seen_set 的 index；没命中返回 -1
console.log('\nfindStopIndex:');
eq(
  findStopIndex(['N1', 'N2', 'N3'], new Set(['A', 'B'])),
  -1,
  '无任何命中 → -1',
);
eq(
  findStopIndex(['N1', 'N2', 'A', 'N4'], new Set(['A', 'B'])),
  2,
  '第一条命中位于 index 2',
);
eq(
  findStopIndex(['A', 'N2', 'N3'], new Set(['A', 'B'])),
  0,
  'page 第一条就命中 → 0',
);
eq(
  findStopIndex(['N1', 'C', 'B', 'A'], new Set(['A', 'B', 'C'])),
  1,
  '取最早出现的命中 index（即使有多个命中）',
);
eq(
  findStopIndex([], new Set(['A'])),
  -1,
  '空页 → -1',
);
eq(
  findStopIndex(['N1', 'N2'], new Set()),
  -1,
  '空 seen_set（冷启动）→ -1（全部要）',
);

// ─── partitionForCatchup ────────────────────────────────────────
console.log('\npartitionForCatchup:');
{
  const items = Array.from({ length: 50 }, (_, i) => `id${i}`);
  const r = partitionForCatchup(items, 70);
  eq(r.immediate, items, '50 条（≤70）→ 全部 immediate');
  eq(r.pending, [], '50 条 → pending 空');
}
{
  const items = Array.from({ length: 350 }, (_, i) => `id${i}`);
  const r = partitionForCatchup(items, 70);
  eq(r.immediate.length, 70, '350 条 → immediate 70 条');
  eq(r.pending.length, 280, '350 条 → pending 280 条');
  eq(r.immediate[0], 'id0', 'immediate 是最新的（index 0 in）');
  eq(r.pending[0], 'id70', 'pending 从 index 70 起');
}
{
  const r = partitionForCatchup([], 70);
  eq(r.immediate, [], '空数组 → immediate 空');
  eq(r.pending, [], '空数组 → pending 空');
}

// ─── 收尾 ───────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
