import { defineConfig } from 'vite';

// The client is a single vanilla TypeScript entry. 3Dmol.js is split into
// its own chunk so the first paint does not wait for about 1 MB of WebGL
// code; main.ts imports it dynamically once a result is shown.
export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('3dmol')) return '3dmol';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8140',
      '/mcp': 'http://127.0.0.1:8140',
      '/openapi.json': 'http://127.0.0.1:8140',
    },
  },
});
