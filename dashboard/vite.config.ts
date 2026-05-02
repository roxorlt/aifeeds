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
    // Dev 默认把 /api/* 透传到 prod worker（同源化，cookie 自然工作）。
    // 想本地起 wrangler dev 时把 VITE_API_PROXY=http://localhost:8788 传进来即可。
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY || 'https://api.ai-feeds.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
