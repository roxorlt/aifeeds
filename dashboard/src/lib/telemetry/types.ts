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
  // C 端搜索（worker/src/track.ts 白名单同步）
  | 'search_open' | 'search_submit' | 'search_suggest_click'
  | 'search_result_click' | 'search_empty' | 'search_error' | 'search_perf'
  // 视频起播（诊断 mobile/微信 autoplay 受限）
  // video_effective_play: 连续播放 ≥3s 触发一次（IAB/Twitter/Meta 短视频 view 标准），
  // 区分"真看了"和"快滑/误触" — payload 含 threshold_ms 兼容未来阈值调整
  | 'video_autoplay_attempt' | 'video_autoplay_blocked' | 'video_play_start'
  | 'video_effective_play'
  // 性能(web-vitals + navigation timing)
  | 'perf_lcp' | 'perf_inp' | 'perf_cls' | 'perf_ttfb' | 'perf_fcp' | 'perf_nav' | 'perf_img'
  | 'perf_api' | 'feed_ready'
  // 错误
  | 'js_error' | 'unhandled_promise' | 'api_error' | 'image_load_error'
  | 'feed_load_error';
