import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8090', '/mcp': 'http://127.0.0.1:8090' },
  },
  // The typst.ts packages ship wasm-pack shims + large wasm that esbuild's dep
  // pre-bundler mishandles; they are loaded lazily via dynamic import + `?url`.
  optimizeDeps: { exclude: ['@myriaddreamin/typst.ts', '@myriaddreamin/typst-ts-web-compiler', '@myriaddreamin/typst-ts-renderer'] },
  test: {
    projects: [
      { extends: true, test: { name: 'ui', environment: 'jsdom', globals: true, include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], setupFiles: ['./src/test/setup.ts'] } },
      { extends: true, test: { name: 'server', environment: 'node', globals: true, include: ['server/**/*.test.ts'], testTimeout: 20000 } },
    ],
  },
});
