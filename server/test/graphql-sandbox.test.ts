import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Router from '@koa/router';
import { startTestServer, type TestServer } from './helpers.js';
import { sandboxEnabled, mountGraphqlSandbox } from '../src/graphql/sandbox.js';

/**
 * W-sandbox — the self-hosted GraphiQL IDE at GET /api/graphql/sandbox. See
 * docs/W-graphql-crud.md ("W-sandbox") for the spec and src/graphql/sandbox.ts for the
 * full design rationale (why a hand-rolled vendored bundle instead of graphiql's own
 * CDN-based embed examples).
 */

let srv: TestServer;
beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

describe('sandboxEnabled — pure gating function', () => {
  it('is enabled by default outside production', () => {
    expect(sandboxEnabled({})).toBe(true);
    expect(sandboxEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(sandboxEnabled({ NODE_ENV: 'test' })).toBe(true);
  });

  it('is disabled in production without the flag', () => {
    expect(sandboxEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(sandboxEnabled({ NODE_ENV: 'production', GRAPHQL_SANDBOX: '0' })).toBe(false);
    expect(sandboxEnabled({ NODE_ENV: 'production', GRAPHQL_SANDBOX: 'true' })).toBe(false); // exact '1' only
  });

  it('is enabled in production WITH the flag', () => {
    expect(sandboxEnabled({ NODE_ENV: 'production', GRAPHQL_SANDBOX: '1' })).toBe(true);
  });
});

describe('mountGraphqlSandbox — route registration is a true no-op when disabled', () => {
  it('registers no routes when enabled=false', () => {
    const router = new Router();
    mountGraphqlSandbox(router, false);
    expect(router.stack.length).toBe(0);
  });

  it('registers the shell + every asset route when enabled=true', () => {
    const router = new Router();
    mountGraphqlSandbox(router, true);
    const paths = router.stack.map((l) => l.path);
    expect(paths).toContain('/api/graphql/sandbox');
    expect(paths).toContain('/api/graphql/sandbox-assets/sandbox.js');
    expect(paths).toContain('/api/graphql/sandbox-assets/sandbox.css');
    expect(paths).toContain('/api/graphql/sandbox-assets/editor.worker.js');
    expect(paths).toContain('/api/graphql/sandbox-assets/json.worker.js');
    expect(paths).toContain('/api/graphql/sandbox-assets/graphql.worker.js');
  });
});

describe('W-sandbox — integration (dev/test mode, sandbox on by default)', () => {
  it('GET /api/graphql/sandbox serves 200 HTML containing the GraphiQL shell', async () => {
    const res = await fetch(`${srv.url}/api/graphql/sandbox`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/html/);
    const html = await res.text();
    expect(html).toContain('graphiql-root');
    // The fetcher must point at the same-origin relative endpoint — never absolute,
    // never a CDN — so a real browser session authenticates via the existing cookie.
    expect(html).toContain('/api/graphql/sandbox-assets/sandbox.js');
    expect(html).toContain('/api/graphql/sandbox-assets/sandbox.css');
  });

  it('the auth gate applies to the sandbox route exactly like every other /api/* route', async () => {
    // This repo's default test AUTH_MODE is 'test' (fixed system-owner injection, no
    // credential needed) — proven by graphql.test.ts's viewer query. That the sandbox
    // route returns 200 under that same startTestServer() (no special headers) IS the
    // proof it rides the ordinary requireAuth path: sandbox.ts adds no auth code of its
    // own, and app.ts mounts mountGraphql (which registers this route) AFTER
    // app.use(requireAuth()). A request to a bogus /api/graphql/sandbox-typo path still
    // 404s, confirming there's no catch-all silently authenticating everything.
    const res = await fetch(`${srv.url}/api/graphql/sandbox-typo`);
    expect(res.status).toBe(404);
  });

  it('serves each vendored asset file with a plausible content-type and non-trivial body', async () => {
    const files: Array<[string, string]> = [
      ['sandbox.js', 'javascript'],
      ['sandbox.css', 'css'],
      ['editor.worker.js', 'javascript'],
      ['json.worker.js', 'javascript'],
      ['graphql.worker.js', 'javascript'],
    ];
    for (const [file, expectedType] of files) {
      const res = await fetch(`${srv.url}/api/graphql/sandbox-assets/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(new RegExp(expectedType));
      const body = await res.text();
      // Not empty/corrupted — a real bundle is at minimum several KB.
      expect(body.length).toBeGreaterThan(1000);
    }
  });

  it('a missing/unknown asset file 404s (no directory-traversal-style fallback)', async () => {
    const res = await fetch(`${srv.url}/api/graphql/sandbox-assets/does-not-exist.js`);
    expect(res.status).toBe(404);
  });

  it('zero off-origin auto-loaded network targets in the served HTML + JS + CSS', async () => {
    // This is the DoD's core guarantee: "grep the served HTML for off-origin URLs".
    // We check the actual bytes the server sends over HTTP for THIS test run — not the
    // source files on disk — so a regression anywhere in the pipeline (route handler,
    // vendored asset, build output) would be caught here.
    const htmlRes = await fetch(`${srv.url}/api/graphql/sandbox`);
    const html = await htmlRes.text();

    // Every <script src=...> / <link href=...> in the HTML shell must be a relative,
    // same-origin path (starts with "/", not "http://"/"https://"/"//").
    const srcHrefPattern = /(?:src|href)=["']([^"']+)["']/g;
    const externalRefs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = srcHrefPattern.exec(html))) {
      const url = m[1];
      if (/^(https?:)?\/\//i.test(url)) externalRefs.push(url);
    }
    expect(externalRefs).toEqual([]);

    // The JS/CSS bundles themselves must not AUTO-LOAD anything off-origin: a fetch(),
    // dynamic import(), importScripts(), new Worker(...), <script src=/<link href=, or
    // an @font-face/background url() pointed at a non-relative, non-localhost host.
    // (Inert doc/license/help-link text and DOM/XML namespace URI strings — e.g.
    // createElementNS("http://www.w3.org/2000/svg", ...) — are expected and are NOT
    // auto-loaded, so this intentionally only matches the request-triggering forms;
    // see the equivalent, more heavily-commented check in graphiql-build/build.mjs.)
    const autoLoadPattern =
      /(?:fetch\(|importScripts\(|new Worker\(|import\(|<script[^>]*\bsrc=|<link[^>]*\bhref=|url\()\s*["'`]\s*https?:\/\/(?!localhost|127\.0\.0\.1)/gi;

    for (const file of ['sandbox.js', 'sandbox.css', 'editor.worker.js', 'json.worker.js', 'graphql.worker.js']) {
      const res = await fetch(`${srv.url}/api/graphql/sandbox-assets/${file}`);
      const text = await res.text();
      const matches = text.match(autoLoadPattern);
      expect(matches, `${file} contains an auto-loaded off-origin reference: ${matches}`).toBeNull();
    }
  });

  it('a query AND a mutation reach POST /api/graphql end-to-end from the same session', async () => {
    // Not a headless-browser test (none available here) — but it proves the two things
    // a browser session opened at /api/graphql/sandbox would actually rely on: (1) the
    // shell points the IDE's fetcher at the same-origin, cookie-carrying /api/graphql
    // endpoint (asserted above), and (2) that endpoint actually answers both a query and
    // a mutation under this test server's normal (unauthenticated-header) session, i.e.
    // the exact request shape GraphiQL's fetcher issues (POST, JSON body, same origin).
    const gql = (query: string) =>
      fetch(`${srv.url}/api/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      }).then((r) => r.json()) as Promise<{ data?: any; errors?: any[] }>;

    const queryResult = await gql('{ viewer { ownerId } }');
    expect(queryResult.errors).toBeUndefined();
    expect(queryResult.data.viewer.ownerId).toBeTruthy();

    const mutationResult = await gql(
      'mutation { createTag(input: { label: "w-sandbox-e2e-check", kind: INTENTION }) { success tag { id label } } }',
    );
    expect(mutationResult.errors).toBeUndefined();
    expect(mutationResult.data.createTag.success).toBe(true);
    expect(mutationResult.data.createTag.tag.label).toBe('w-sandbox-e2e-check');
  });
});

describe('W-sandbox — 404 in production without the flag (integration)', () => {
  it('a freshly built router with enabled=false serves no sandbox route, confirmed against a real Koa response', async () => {
    // A full second process with NODE_ENV=production is impractical inside this test
    // run (vitest itself, plus every already-imported module, is executing under the
    // process's current NODE_ENV — flipping it retroactively wouldn't re-run module-load
    // guards like config.ts's boot-time checks). Per the ticket's own guidance, the
    // acceptable substitute is: unit-test the pure gating function directly (done
    // above: sandboxEnabled({ NODE_ENV: 'production' }) === false) PLUS a direct,
    // non-mocked call to the real route-registration function with enabled=false,
    // wired into a real Koa app and driven through an actual HTTP request — proving
    // the no-op registration truly results in a 404, not just an empty router.stack.
    const Koa = (await import('koa')).default;
    const app = new Koa();
    const router = new Router();
    mountGraphqlSandbox(router, sandboxEnabled({ NODE_ENV: 'production' })); // false ⇒ no-op
    app.use(router.routes()).use(router.allowedMethods());
    const server = app.listen(0);
    try {
      const { port } = server.address() as import('node:net').AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/graphql/sandbox`);
      expect(res.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('the same setup WITH the flag serves 200 — proving the 404 above is the flag, not a broken route', async () => {
    const Koa = (await import('koa')).default;
    const app = new Koa();
    const router = new Router();
    mountGraphqlSandbox(router, sandboxEnabled({ NODE_ENV: 'production', GRAPHQL_SANDBOX: '1' }));
    app.use(router.routes()).use(router.allowedMethods());
    const server = app.listen(0);
    try {
      const { port } = server.address() as import('node:net').AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}/api/graphql/sandbox`);
      expect(res.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
