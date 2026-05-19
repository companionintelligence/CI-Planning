import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['server/test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['server/test/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 15_000,
          hookTimeout: 15_000,
          singleThread: true,
        },
      },
    ],
  },
});
