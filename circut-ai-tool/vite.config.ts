import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: { outDir: 'dist', target: 'es2022', sourcemap: false },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8765', '/mcp': 'http://127.0.0.1:8765', '/openapi.json': 'http://127.0.0.1:8765' },
  },
});
