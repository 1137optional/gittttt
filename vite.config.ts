import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const SERVER_URL = process.env.GITTTTT_SERVER_URL ?? 'http://localhost:3001';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./client', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: SERVER_URL, changeOrigin: true },
      '/events': { target: SERVER_URL, changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
});
