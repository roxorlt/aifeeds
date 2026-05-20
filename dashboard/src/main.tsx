import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import App from './App.tsx'

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
  const isDeepLink = p.startsWith('/t/') || p.startsWith('/g/') || p.startsWith('/ph/') || p.startsWith('/c/') || p.startsWith('/h/') || p.startsWith('/e/')
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
