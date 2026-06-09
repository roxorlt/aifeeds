// 微信内置浏览器（WeChat WKWebView / Android X5 内核）检测。
// 用途：微信里 Cloudflare Turnstile 人机校验经常过不去，登录 / 订阅流程在微信内
// 需要降级处理（订阅页改为引导关注公众号；登录弹窗提示用系统浏览器打开）。
export function isWeChatBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /MicroMessenger/i.test(navigator.userAgent);
}
