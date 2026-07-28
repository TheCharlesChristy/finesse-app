import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.js so the PWA/Tailwind plugins don't run for tests.
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./src/__tests__/setup.js'],
    include: ['src/__tests__/**/*.test.{js,jsx}'],
    restoreMocks: true,
  },
});
