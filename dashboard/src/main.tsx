import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { installApiTiming } from './lib/telemetry/vitals'

// Seed history so cold deep-links into item detail paths don't trap the back
// button. Stack becomes ['/', '/<deep>'] → back returns to feed.
// Runs only at fresh page load (main.tsx); SPA in-app nav never re-enters here.
//
// PM 2026-05-20 反馈:hf paper deeplink (/h/<id>) 漏在列表里,冷启动 history
// 只有 1 条 → TweetDrawer close() 走 fallback navigate('/', {replace:true})
// → replace 不触发 popstate → URL effect 不跑 → drawer state 没清 → backdrop
// 残留全屏覆盖 → 用户"返回频道流但黑遮罩没法操作"。补 /h/ 进列表后,
// 冷启动会 seed ['/', '/h/<id>'],close → navigate(-1) → popstate → state 清。
// /e/ (huodongxing event deeplink) 同样漏在列表里,顺手补上。
{
  const p = window.location.pathname
  // /search 冷启动直达时也 seed，保证返回键回 feed 不出站（同 /t/ /g/ 等深链逻辑）。
  // 注意 pathname 不含 query，`/search?q=x` 的 pathname 仅为 `/search`，精确匹配即可。
  const isDeepLink = p.startsWith('/t/') || p.startsWith('/g/') || p.startsWith('/ph/') || p.startsWith('/c/') || p.startsWith('/h/') || p.startsWith('/e/') || p.startsWith('/o/') || p === '/search' || p.startsWith('/search/')
  if (isDeepLink) {
    const target = window.location.pathname + window.location.search + window.location.hash
    window.history.replaceState({}, '', '/')
    window.history.pushState({}, '', target)
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)

// App 的 telemetry effect 先完成初始化；load 后再用 buffered Resource Timing
// 一次性补收首屏 API，避免 observer 回调早于 queue 初始化而静默丢样本。
const installApiObserver = () => { installApiTiming() }
if (document.readyState === 'complete') setTimeout(installApiObserver, 0)
else window.addEventListener('load', installApiObserver, { once: true })

// Service Worker:壳缓存,回访打开零网络秒出(public/sw.js)。load 之后才注册,
// 不跟首屏抢任何资源。kill switch 两道:
// 1) 全员紧急停用:发版往 index.html 加 <script>window.__SW_OFF=true</script>
//    (SW 导航时总会后台拉新壳,所以这个 flag 一个访问周期内就能传达到所有用户)
// 2) 单机停用:localStorage 设 aifeeds_sw_off = 1
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    let off = (window as unknown as { __SW_OFF?: boolean }).__SW_OFF === true
    try {
      off = off || localStorage.getItem('aifeeds_sw_off') === '1'
    } catch {
      /* 隐私模式读不了 localStorage,忽略 */
    }
    if (off) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => regs.forEach((r) => r.unregister()))
        .catch(() => {})
      if (window.caches) {
        caches
          .keys()
          .then((ks) => ks.forEach((k) => { if (k.startsWith('aifeeds-')) caches.delete(k) }))
          .catch(() => {})
      }
      return
    }
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* 注册失败(老 webview 不支持等)→ 一切照旧,无 SW 行为 */
    })
  })
}
