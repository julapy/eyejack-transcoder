import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Tier A — fast unit tests in jsdom. FFmpeg is mocked (see src/__tests__/helpers/setup.ts);
// these cover the pure pipeline logic: ffmpeg arg arrays, branch classification, image-mode pixel math.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['src/__tests__/helpers/setup.ts'],
    include: ['src/**/*.test.ts'],
    exclude: ['src/__e2e__/**', 'node_modules', 'dist'],
  },
});
