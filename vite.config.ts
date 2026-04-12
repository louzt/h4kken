import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: 'public',
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/ws': { target: 'ws://localhost:3000', ws: true, rewriteWsOrigin: true },
      '/api': 'http://localhost:3000',
    },
  },
});
