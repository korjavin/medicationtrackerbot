import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['web/static/js/tests/**/*.test.js'],
    restoreMocks: true,
    clearMocks: true
  }
});
