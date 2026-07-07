-- 026-search-fts.sql — C 端搜索：FTS5 影子表 + suggestion 词表 + 同步水位
-- 影子表列内容是预分词后的空格分隔 token 流（见 src/search/tokenize.ts），
-- rowid 与 items.rowid 对齐（插入时显式指定）。
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title_tok,
  body_tok,
  author_tok,
  item_id UNINDEXED,
  source_type UNINDEXED,
  published_at UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS search_terms (
  term        TEXT NOT NULL,
  term_norm   TEXT NOT NULL,
  term_type   TEXT NOT NULL,            -- 'entity' | 'hot_query'
  source_type TEXT,
  weight      REAL NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (term_norm, term_type)
);
CREATE INDEX IF NOT EXISTS idx_search_terms_norm ON search_terms(term_norm, weight DESC);

CREATE TABLE IF NOT EXISTS search_sync_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
