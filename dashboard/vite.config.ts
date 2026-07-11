import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// 不要在这里手动注入 CF Web Analytics beacon —— ai-feeds.com 这个 zone
// 已开启 Web Analytics zone-level auto-inject，CF 边缘按 UA 自动给所有子域
// （prod / staging / www）注入 beacon，数据统一进 zone 关联的 site_tag。
// 手动注入会冗余且 token 不匹配（OPS handoff 2026-05-16 复盘，详情见
// docs/operations.md §11）。

// Keep the feed prefetch as a parser-inline classic script so it can start while
// the application bundle is still downloading. Vite bundles inline module
// scripts into the app entry, which would silently remove that head start.
// Values are public VITE_* build settings, encoded as JS literals to prevent
// malformed/custom API bases from breaking out of the script.
function inlineJson(value: string | boolean): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function apiHtmlEnvPlugin(apiBase: string, sameOrigin: boolean): Plugin {
  const replacements = new Map([
    ['__AIFEEDS_API_BASE__', inlineJson(apiBase)],
    ['__AIFEEDS_API_SAME_ORIGIN__', inlineJson(sameOrigin)],
  ])
  return {
    name: 'aifeeds-api-html-env',
    transformIndexHtml(html) {
      let transformed = html
      for (const [token, value] of replacements) {
        transformed = transformed.replaceAll(token, value)
      }
      return transformed
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const fileEnv = loadEnv(mode, process.cwd(), 'VITE_')
  const apiBase = process.env.VITE_API_BASE ?? fileEnv.VITE_API_BASE ?? ''
  const sameOrigin = (process.env.VITE_API_SAME_ORIGIN ?? fileEnv.VITE_API_SAME_ORIGIN) === 'true'

  return {
    plugins: [apiHtmlEnvPlugin(apiBase, sameOrigin), react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      // Dev 默认把 /api/* 透传到 staging worker（写操作不污染 prod）。
      // 临时连 prod 验真数据：VITE_API_PROXY=https://api.ai-feeds.com npm run dev
      // 临时连本地 wrangler dev：VITE_API_PROXY=http://localhost:8788 npm run dev
      proxy: {
        '/api': {
          target: process.env.VITE_API_PROXY || 'https://staging-api.ai-feeds.com',
          changeOrigin: true,
          secure: true,
        },
        // /r/* 是 worker 全站 media R2 反代路径(GH README / PH logo / X media /
        // HF figure 都走这条)。漏配会让 vite SPA fallback 返 HTML 导致 dev 看不到图。
        // 同 /api proxy target,通过 VITE_API_PROXY 覆盖(staging / prod / 本地 wrangler dev)。
        '/r': {
          target: process.env.VITE_API_PROXY || 'https://staging-api.ai-feeds.com',
          changeOrigin: true,
          secure: true,
        },
      },
    },
    build: {
      rollupOptions: {
        output: {
          // react 生态拆成独立 chunk：它很少变，发版后浏览器跨版本命中缓存，
          // 回访不用每次重下整包（首屏总量不变，纯为二次/回访提速）。
          manualChunks(id) {
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom)[\\/]/.test(id)) {
              return 'react-vendor'
            }
          },
        },
      },
    },
  }
})
