import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import type Koa from 'koa';
import Router from '@koa/router';

/**
 * W-sandbox — a self-hosted, vendored GraphiQL developer IDE at
 * `GET /api/graphql/sandbox`, run against the existing `POST /api/graphql` endpoint.
 * See docs/W-graphql-crud.md ("W-sandbox") for the locked spec. Registered by
 * `mountGraphql()` in graphql/index.ts, in the SAME place `POST /api/graphql` is
 * registered — i.e. after `app.use(requireAuth())` in app.ts, so this route is
 * auth-gated automatically (it is NOT in requireAuth's PUBLIC_PREFIXES) with zero new
 * auth code. GET maps to the `planning:read` scope, which every authenticated session
 * already carries.
 *
 * ── Why this is a hand-rolled esbuild bundle, not graphiql's documented embed path ──
 * The spec requires self-hosted, vendored assets with ZERO external requests (Apollo's
 * hosted Sandbox — embed.apollo.dev — is explicitly rejected for the same reason). The
 * obvious-looking options don't satisfy that:
 *
 *   1. The classic no-build UMD bundle (`graphiql/graphiql.min.js` + `.min.css`, loaded
 *      via plain <script>/<link> tags next to separately-vendored React UMD builds) —
 *      what this ticket's brief specifically asked us to check for — was REMOVED after
 *      graphiql@2. It only survives in graphiql@1.x and earlier, which pin
 *      `graphql: ^15.x` — incompatible with this workspace's forced
 *      `graphql@16.14.2` override (pnpm-workspace.yaml). Not usable.
 *   2. graphiql@5's own README now recommends an "ESM-based CDN" example instead. But
 *      that "CDN" isn't just a static file host — the example's <script type="importmap">
 *      resolves every bare specifier (react, graphiql, @graphiql/react, ...) through
 *      `esm.sh/pkg?standalone`, i.e. a bundling proxy the BROWSER calls at request time.
 *      That is exactly the off-origin request the local-first guarantee forbids, just
 *      one dependency further removed than embed.apollo.dev. Rejected for the same
 *      reason.
 *   3. So: install `graphiql`, `react`, `react-dom`, `@graphiql/toolkit` as normal
 *      *pinned* dependencies (server/package.json — versions locked, not floating
 *      ranges resolved by a CDN), and bundle them ourselves, once, offline, with
 *      esbuild (already a workspace devDependency via drizzle-kit/tsx/vite — see
 *      `onlyBuiltDependencies` in pnpm-workspace.yaml). The bundle is produced by
 *      `graphiql-build/build.mjs` (source, not shipped) and its OUTPUT is committed
 *      under `graphiql-assets/` (shipped, vendored — analogous to checking in a
 *      downloaded .min.js). It is never rebuilt at server startup; re-run the build
 *      script by hand after bumping the graphiql/react pins and commit the result.
 *
 * GraphiQL v5 uses Monaco Editor internally, which needs Web Workers for language
 * features. Upstream ships bundler-specific glue for that (`setup-workers/vite`,
 * `.../webpack`) — neither applies to a hand-rolled esbuild bundle, so
 * `graphiql-build/workers.ts` is our own equivalent, and the three worker scripts are
 * bundled as separate same-origin-served entry points (see build.mjs).
 *
 * Verified zero off-origin auto-loaded references: build.mjs's own post-build check,
 * plus server/test/graphql-sandbox.test.ts's grep of the actually-served HTML/JS/CSS.
 */

const _dir = dirname(fileURLToPath(import.meta.url));
// server/src/graphql/sandbox.ts → server/src/graphql → server/src → server → graphiql-assets
const assetsDir = join(_dir, '..', '..', 'graphiql-assets');

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// Fixed, known set of vendored files — deliberately NOT a generic static-file mount.
// koa-static (already a server dependency, used elsewhere for the client build) serves
// a whole directory tree by path; here we have exactly 5 fixed files, so a small
// explicit allowlist is simpler and avoids conflating this asset root with the
// client's SPA static root (server/public, mounted separately in app.ts).
const ASSET_FILES = [
  'sandbox.js',
  'sandbox.css',
  'editor.worker.js',
  'json.worker.js',
  'graphql.worker.js',
] as const;

function sandboxHtml(): string {
  // The fetcher inside entry.tsx (bundled into sandbox.js) points at the relative,
  // same-origin `/api/graphql` — never an absolute URL, never a CDN. The browser
  // attaches the existing session cookie automatically, so queries/mutations run as
  // the logged-in owner with no extra wiring.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>GraphQL Sandbox — Companion Planning</title>
    <link rel="stylesheet" href="/api/graphql/sandbox-assets/sandbox.css" />
    <style>
      body { margin: 0; }
      #graphiql-root { height: 100vh; }
    </style>
  </head>
  <body>
    <div id="graphiql-root">Loading GraphiQL…</div>
    <script src="/api/graphql/sandbox-assets/sandbox.js"></script>
  </body>
</html>
`;
}

/**
 * Non-production is on by default; production requires opting in with
 * `GRAPHQL_SANDBOX=1`. Mirrors the codebase's established fail-closed prod posture
 * (e.g. config.ts's `AUTH_MODE=test is forbidden in production` guard) but inverted:
 * here the SAFE default is "on" (a read/write GraphQL IDE for a private, single-tenant,
 * self-hosted planning app is low-risk — it just reuses the session the browser
 * already has), so production is the side that needs an explicit flag, not dev.
 *
 * Deliberately a small, pure, exported function — NOT folded once into the `config`
 * singleton at module-load — so tests can exercise both branches by passing an env
 * object directly, without needing a second process (config.ts's object is built once
 * at import time; mutating process.env.NODE_ENV afterwards wouldn't change it).
 */
export function sandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' || env.GRAPHQL_SANDBOX === '1';
}

/**
 * Registers the sandbox HTML shell + its vendored asset files on `router`, but only
 * when `enabled` is true. When false, this is a no-op — no route is registered, so
 * `GET /api/graphql/sandbox*` falls through to Koa's normal "nothing matched" 404
 * (there is no catch-all for /api/* paths; app.ts's static-SPA fallback explicitly
 * excludes anything starting with /api). That "don't register" behavior is exactly
 * what the DoD's "route 404s in production without the flag" requires — no explicit
 * 404 handler needed.
 *
 * Exported separately from mountGraphql so a test can call it directly with
 * `enabled=false` and assert the router gains no routes, without booting a second
 * process just to flip NODE_ENV.
 */
export function mountGraphqlSandbox(router: Router, enabled: boolean): void {
  if (!enabled) return;

  router.get('/api/graphql/sandbox', (ctx: Koa.Context) => {
    ctx.type = 'html';
    ctx.body = sandboxHtml();
  });

  for (const file of ASSET_FILES) {
    router.get(`/api/graphql/sandbox-assets/${file}`, (ctx: Koa.Context) => {
      const path = join(assetsDir, file);
      if (!existsSync(path)) {
        ctx.status = 404;
        return;
      }
      ctx.type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
      ctx.body = readFileSync(path);
    });
  }
}
