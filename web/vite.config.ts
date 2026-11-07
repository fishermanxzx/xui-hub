import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// 开发:vite 在 5174,/api 代理到后端 8788。生产:build 出 dist/,由后端托管。
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: { '/api': 'http://127.0.0.1:8788' },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
