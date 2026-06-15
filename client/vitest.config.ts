import { defineConfig } from 'vitest/config';

// Lightweight config for the PURE grid/date math (PR-1). The grid converter is
// host-timezone-dependent by design (it maps a UTC instant to a *local* column
// minute), so we pin TZ to a DST-observing zone to make the spring-forward
// assertion deterministic regardless of where the suite runs.
// Full SolidJS component tests (jsdom) are deferred to PR2/PR3.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      TZ: 'America/Los_Angeles',
    },
  },
});
