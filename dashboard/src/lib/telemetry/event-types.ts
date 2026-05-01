// event_type 常量集中点。新增事件类型在这里加，Worker 端 track.ts 同步加。
// 设计：docs/plans/2026-05-01-auth-system-design.md § 3.5.2

import type { EventTypeName } from './types';

export const EVENTS = {
  // 导航
  APP_OPEN: 'app_open',
  PAGE_VIEW: 'page_view',
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
  // 内容
  ITEM_IMPRESSION: 'item_impression',
  ITEM_CLICK: 'item_click',
  ITEM_OPEN_DRAWER: 'item_open_drawer',
  ITEM_CLOSE_DRAWER: 'item_close_drawer',
  THREAD_EXPAND: 'thread_expand',
  IMAGE_LIGHTBOX_OPEN: 'image_lightbox_open',
  EXTERNAL_LINK_CLICK: 'external_link_click',
  // 筛选
  SOURCE_FILTER_CHANGE: 'source_filter_change',
  SORT_CHANGE: 'sort_change',
  NEW_CONTENT_BANNER_CLICK: 'new_content_banner_click',
  // 分享
  SHARE_CLICK: 'share_click',
  SHARE_LANDING: 'share_landing',
  // 登录（PR2/3）
  LOGIN_MODAL_OPEN: 'login_modal_open',
  SMS_SEND_ATTEMPT: 'sms_send_attempt',
  SMS_SEND_SUCCESS: 'sms_send_success',
  CODE_VERIFY_ATTEMPT: 'code_verify_attempt',
  LOGIN_SUCCESS: 'login_success',
  LOGOUT: 'logout',
  ACCOUNT_DELETE: 'account_delete',
  // 互动（PR5）
  FAVORITE_TOGGLE: 'favorite_toggle',
  SUBSCRIBE_TOGGLE: 'subscribe_toggle',
  // 性能
  PERF_LCP: 'perf_lcp',
  PERF_INP: 'perf_inp',
  PERF_CLS: 'perf_cls',
  PERF_TTFB: 'perf_ttfb',
  // 错误
  JS_ERROR: 'js_error',
  UNHANDLED_PROMISE: 'unhandled_promise',
  API_ERROR: 'api_error',
  IMAGE_LOAD_ERROR: 'image_load_error',
} as const satisfies Record<string, EventTypeName>;
