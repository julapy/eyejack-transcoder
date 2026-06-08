import { defineConfig } from 'vite';
import { resolve } from 'path';

// Cross-origin isolation headers — required for FFmpeg WASM (SharedArrayBuffer).
// Applied to both the dev server and the preview server so the standalone
// harness can actually transcode.
const COOP_COEP = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },

  // Dev: serves the standalone transcoder harness from index.html.
  server: {
    port: 3200,
    open: true,
    headers: COOP_COEP,
    // Allow serving media fixtures from a parent directory (via /@fs/…) when this
    // package is embedded in a larger repo, so the harness + agents can transcode
    // real sample media in dev. Harmless when used standalone.
    fs: { allow: [resolve(__dirname, '../..')] },
  },
  preview: {
    port: 3200,
    headers: COOP_COEP,
  },

  // Build: library mode → dist/index.js (the contract web/ imports).
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'EyeJackTranscoder',
      formats: ['es'],
      fileName: 'index',
    },
    outDir: 'dist',
    rollupOptions: {
      // Bundle all deps so the package is self-contained for consumers (web/).
      external: [],
    },
    sourcemap: true,
  },
});
