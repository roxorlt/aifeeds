import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
})
