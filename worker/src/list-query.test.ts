import { describe, expect, test } from 'vitest';

import {
  LIST_ROW_COLUMNS,
  buildListProjection,
  buildListSelect,
  selectProjectedListColumns,
} from './list-query';

const PUBLIC_SOURCES = [
  'x_list',
  'github',
  'product_hunt',
  'clawhub',
  'huodongxing',
  'hf_paper',
  'blog',
  'podcast',
  'youtube',
  'arxiv',
] as const;

function expectExplicitSelect(sql: string): void {
  expect(sql).not.toMatch(/\bSELECT\s+(?:\w+\.)?\*/i);
  expect(sql).not.toMatch(/\bitems\.\*/i);
  for (const column of LIST_ROW_COLUMNS) {
    expect(sql, column).toMatch(new RegExp(`\\bAS\\s+${column}\\b`, 'i'));
  }
}

describe('list SQL projection', () => {
  test.each(PUBLIC_SOURCES)('%s selects explicit base and compact extra fields', (sourceType) => {
    const sql = buildListSelect({ sourceTypes: [sourceType] });
    expectExplicitSelect(sql);
    expect(sql).toContain('json_object(');
    expect(sql).not.toMatch(/\bextra\s+AS\s+extra\b/i);
  });

  test('mixed-source projection is a source-aware CASE rather than raw extra', () => {
    const sql = buildListSelect();
    expectExplicitSelect(sql);
    expect(sql).toMatch(/CASE\s+items\.source_type/i);
    for (const sourceType of PUBLIC_SOURCES) {
      expect(sql).toContain(`WHEN '${sourceType}'`);
    }
    expect(sql).not.toMatch(/ELSE\s+items\.extra/i);
  });

  test('heavy source fields are bounded or omitted before D1 returns the row', () => {
    const github = buildListProjection({ sourceTypes: ['github'] });
    expect(github).toContain("'cover_url'");
    expect(github).toContain("'readme_excerpt'");
    expect(github).toContain("cover_status') IN ('ok', 'none')");
    expect(github).not.toMatch(/cover_url'\) IS NOT NULL/);
    expect(github).not.toContain('readme_translated');
    expect(github).not.toContain('recent_commits');

    const hf = buildListProjection({ sourceTypes: ['hf_paper'] });
    expect(hf).toContain("'deep_analysis'");
    expect(hf).toContain('deep_analysis.tldr');
    expect(hf).not.toContain('discussion_comments');
    expect(hf).not.toContain('full_text_zh');

    for (const sourceType of ['blog', 'podcast'] as const) {
      const feed = buildListProjection({ sourceTypes: [sourceType] });
      expect(feed).toMatch(/substr\(json_extract\([^)]*'\$\.excerpt'/i);
      expect(feed).not.toMatch(/body_markdown|transcript_text/i);
    }

    const clawhub = buildListProjection({ sourceTypes: ['clawhub'] });
    expect(clawhub).toMatch(/substr\(items\.content,\s*1,\s*280\)/i);
    expect(clawhub).not.toContain('files_manifest');
  });

  test('X nested article bodies are removed in SQL as well as at serialization', () => {
    const x = buildListProjection({ sourceTypes: ['x_list'] });
    expect(x).toContain('json_remove(');
    expect(x).toContain('$.x_article.body');
    expect(x).toContain('$.body_translated');
  });

  test('callers can add hidden order aliases without reintroducing wildcard columns', () => {
    const sql = buildListSelect({
      sourceTypes: ['x_list'],
      additional: [
        { alias: '_hot_score', expression: '42' },
        { alias: '_state', expression: '7' },
      ],
    });
    expectExplicitSelect(sql);
    expect(sql).toContain('42 AS _hot_score');
    expect(sql).toContain('7 AS _state');

    const outer = selectProjectedListColumns('sub');
    for (const column of LIST_ROW_COLUMNS) {
      expect(outer).toContain(`sub.${column}`);
    }
    expect(outer).not.toContain('*');
  });

  test('additional projections must use an internal underscore alias', () => {
    expect(() => buildListSelect({
      sourceTypes: ['x_list'],
      additional: [{ alias: 'hot_score' as '_hot_score', expression: '42' }],
    })).toThrow(/invalid hidden list alias/);
  });
});
