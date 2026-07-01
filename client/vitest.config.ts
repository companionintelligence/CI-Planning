import { defineConfig } from 'vitest/config';
import solid from 'vite-plugin-solid';

// Two vitest projects, run together by `pnpm --filter client test`:
//
//   • unit — the PURE grid/date/star math (PR-1). Node env, no DOM, no Solid
//     plugin. The grid converter is host-timezone-dependent by design (it maps a
//     UTC instant to a *local* column minute), so we pin TZ to a DST-observing
//     zone to make the spring-forward assertion deterministic regardless of where
//     the suite runs. Behaviour is UNCHANGED from the original single-config setup.
//
//   • dom — SolidJS component tests (jsdom). Loads vite-plugin-solid so JSX
//     compiles + reacts, and dedupes Solid so signals actually re-render the DOM.
//     See the two gotchas below.
//
// GOTCHA 1 — Solid dedupe. The classic Solid+vitest failure is TWO copies of
// solid-js loaded at once: the component's reactive graph and the test's live in
// different module instances, so signals update but the rendered DOM never
// re-runs — a naive test then passes for the WRONG reason (false green).
// `server.deps.inline` forces Solid through vitest's single transform pipeline so
// exactly one instance exists. The `reactivity-smoke.test.tsx` canary exists
// precisely to fail loudly if this ever regresses.
//
// GOTCHA 2 — resolve conditions. Solid ships a `development` build (with the
// reactive dev runtime component tests need) and a `browser` build. Without these
// export conditions vitest resolves the server/production build and rendering
// misbehaves under jsdom.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          env: {
            TZ: 'America/Los_Angeles',
          },
        },
      },
      {
        // vite-plugin-solid only applies inside this project so the node `unit`
        // project keeps compiling plain .ts with no JSX transform.
        //
        // GOTCHA 3 — disable HMR. Left on, the plugin injects solid-refresh
        // (`import ... from '/@solid-refresh'`) which vitest's loader rejects with
        // `The argument 'filename' must be a file URL … Received 'file:///@solid-refresh'`.
        // Tests don't hot-reload, so turn it off.
        plugins: [solid({ hot: false })],
        resolve: {
          conditions: ['development', 'browser'],
        },
        test: {
          name: 'dom',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./vitest.setup.ts'],
          env: {
            TZ: 'America/Los_Angeles',
          },
          server: {
            deps: {
              // Dedupe Solid — CRITICAL. See GOTCHA 1 above.
              inline: [/solid-js/, /@solidjs/],
            },
          },
        },
      },
    ],
  },
});
