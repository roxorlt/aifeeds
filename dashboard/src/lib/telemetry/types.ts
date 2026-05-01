// telemetry SDK 类型定义
// 设计：docs/plans/2026-05-01-auth-system-design.md § 3.5

export interface TelemetryEvent {
  type: string;
  payload?: Record<string, unknown>;
  occurred_at: number;
  page_path?: string;
}

export interface TrackRequestBody {
  events: TelemetryEvent[];
  session_token_hash?: string;
}

export interface TrackResponse {
  accepted: number;
  rejected: number;
  errors?: string[];
}

export type EventTypeName =
  // 导航
  | 'app_open' | 'page_view' | 'session_start' | 'session_end'
  // 内容
  | 'item_impression' | 'item_click' | 'item_open_drawer' | 'item_close_drawer'
  | 'thread_expand' | 'image_lightbox_open' | 'external_link_click'
  // 筛选
  | 'source_filter_change' | 'sort_change' | 'new_content_banner_click'
  // 分享
  | 'share_click' | 'share_landing'
  // 登录（PR2/3）
  | 'login_modal_open' | 'sms_send_attempt' | 'sms_send_success'
  | 'code_verify_attempt' | 'login_success' | 'logout' | 'account_delete'
  // 互动（PR5）
  | 'favorite_toggle' | 'subscribe_toggle'
  // 性能
  | 'perf_lcp' | 'perf_inp' | 'perf_cls' | 'perf_ttfb'
  // 错误
  | 'js_error' | 'unhandled_promise' | 'api_error' | 'image_load_error';
