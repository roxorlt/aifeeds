// PR5 share feature 类型定义
// 设计：docs/plans/2026-05-04-pr5-share-implementation.md § 2

export interface ShareRelation {
  id: number;
  token: string;
  from_uid: string;
  item_id: string;
  shared_at: number;
  to_did: string | null;
  to_uid: string | null;
  landed_at: number | null;
  registered_at: number | null;
  scan_count: number;
  last_scanned_at: number | null;
}

export interface CreateShareRequest {
  item_id: string;
}

export interface CreateShareResponse {
  token: string;
  share_url: string;
  poster_url: string;
  expires_at: number;
}

export interface LandingRequest {
  token: string;
}
