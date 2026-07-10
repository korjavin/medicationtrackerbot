import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['web/static/js/tests/**/*.test.js', 'web/cloud/js/tests/**/*.test.js'],
    setupFiles: ['web/static/js/tests/helpers/setup.js'],
    restoreMocks: true,
    clearMocks: true,
    pool: 'threads',
    // scrypt in backup-crypto.test.js is CPU-bound and takes 2.0-2.8s per case;
    // the 5s default has no margin under thread contention on a loaded runner.
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/frontend',
      reporter: ['text', 'json-summary'],
      include: ['web/static/js/**/*.js'],
      exclude: ['web/static/js/tests/**']
    }
  }
});
