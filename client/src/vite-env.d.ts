/// <reference types="vite/client" />

// Side-effect CSS imports (e.g. `import './index.css'`) are handled by Vite at
// build time; declare them so `tsc --noEmit` does not flag the import.
declare module '*.css';

// Build-time error-reporting config (lib/telemetry.ts). All optional — with
// VITE_SENTRY_DSN unset the bundle initialises no Sentry at all. Vite inlines these at
// `vite build` time, so in Docker they are BUILD ARGS, not runtime env.
interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string;
  readonly VITE_SENTRY_RELEASE?: string;
  readonly VITE_CI_PLANNING_ENVIRONMENT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
