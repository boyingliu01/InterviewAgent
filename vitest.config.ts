import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    exclude: ['node_modules/', 'dist/', 'coverage/'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'coverage/',
        '**/*.config.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        'src/index.ts',
        'scripts/',
        'src/server.ts',
      ],
    },
    globals: true,
    environment: 'node',
    hookTimeout: 10000,
    testTimeout: 10000,
    fileParallelism: true,
  },
});
