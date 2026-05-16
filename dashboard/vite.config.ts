import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// CF Web Analytics site_tag — 按 vite mode 区分 prod / staging。
// token 不是 secret（公开写在浏览器源码里就是给浏览器看的），可以提交进仓库。
// 运维细节见 docs/operations.md §11，OPS handoff 2026-05-16。
// dev / staging mode 都用 staging token，避免 dev 流量污染 prod 统计。
const CF_BEACON_TOKENS: Record<string, string> = {
  production: '857fab927a70440bb19c685c8f85094f',
  staging: '9e6f987fd43d45d8ae74c134ad8a0e4e',
  development: '9e6f987fd43d45d8ae74c134ad8a0e4e',
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'inject-cf-beacon',
      transformIndexHtml(html: string): string {
        const token = CF_BEACON_TOKENS[mode] ?? CF_BEACON_TOKENS.staging
        const tag = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${token}"}'></script>`
        return html.replace('</head>', `    ${tag}\n  </head>`)
      },
    },
  ],
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
    },
  },
}))
