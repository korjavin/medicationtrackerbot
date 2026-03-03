import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['web/static/js/tests/**/*.test.js'],
    setupFiles: ['web/static/js/tests/helpers/setup.js'],
    restoreMocks: true,
    clearMocks: true,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/frontend',
      reporter: ['text', 'json-summary'],
      include: ['web/static/js/**/*.js'],
      exclude: ['web/static/js/tests/**']
    }
  }
});
