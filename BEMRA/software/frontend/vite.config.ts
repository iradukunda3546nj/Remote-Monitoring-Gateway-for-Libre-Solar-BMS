/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  // Same port as dev so the backend's CORS_ORIGINS entry also covers `npm run preview`.
  preview: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Chart-heavy workspaces are lazy-loaded routes, so ECharts lands in their chunks.
    chunkSizeWarningLimit: 900,
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
