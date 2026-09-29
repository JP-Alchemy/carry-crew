import { defineConfig } from 'vite';

const server = process.env.CARRY_SERVER ?? 'http://localhost:8787';

export default defineConfig({
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    target: 'es2020',
  },
  server: {
    host: true,
    proxy: {
      '/api': server,
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
    },
  },
});
