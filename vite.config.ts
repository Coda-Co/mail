/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port and a static build in dist/.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**', '**/crates/**', '**/target/**'] } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    outDir: 'dist',
    target: ['es2021', 'chrome105', 'safari15'],
    sourcemap: false,
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
