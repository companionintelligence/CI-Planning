import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Router from '@koa/router';
import { startTestServer, type TestServer } from './helpers.js';
import { sandboxEnabled, mountGraphqlSandbox } from '../src/graphql/sandbox.js';
import { config } from '../src/lib/config.js';

/** Off-origin "importmap → bare specifier" CDN pattern (graphiql@5's own README-
 * recommended embed, explicitly rejected in sandbox.ts's design rationale): a
 * `<script type="importmap">` mapping a bare specifier to a remote host IS the
 * violation on its own — any later `import 'somepkg'` anywhere resolves through it,
 * whether or not a consuming bare import is textually visible in this same response.
 * The `fetch(`/`<script src=`/etc. pattern below can't see this (an importmap tag has
 * no `src=`/`href=` attribute; its URLs sit inside inline JSON body text) — a future
 * graphiql/react bump that silently reverts to that pattern must fail HERE. */
function importMapViolations(text: string): string[] {
  const hits: string[] = [];
  const pattern = /<script[^>]*\btype=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text))) {
    if (/https?:\/\/(?!localhost|127\.0\.0\.1)/i.test(m[1])) hits.push(m[0].slice(0, 200));
  }
  return hits;
}

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

  it('is auth-gated: no credential ⇒ 401, exactly like POST /api/graphql', async () => {
    // The shared `srv` in this describe block runs under this repo's default `test`
    // AUTH_MODE (fixed system-owner injection, NO credential check at all — see
    // requireAuth.ts) — a 200 there proves nothing about auth, and a 404 on a typo'd
    // path only proves Koa routing works. Mirror graphql.test.ts's real auth-gating
    // test instead: flip to `sso` mode with no session cookie presented, so
    // requireAuth actually has something to reject.
    const saved = { ...config.auth };
    config.auth.mode = 'sso';
    config.auth.disableOidc = true;
    config.auth.sessionSecret = 'test-session-secret';
    const s = await startTestServer();
    try {
      const shellRes = await fetch(`${s.url}/api/graphql/sandbox`);
      expect(shellRes.status).toBe(401);
      // The vendored-asset routes ride the SAME router/middleware chain — confirm they
      // aren't an accidental unauthenticated side door to the bundle.
      const assetRes = await fetch(`${s.url}/api/graphql/sandbox-assets/sandbox.js`);
      expect(assetRes.status).toBe(401);
    } finally {
      await s.close();
      Object.assign(config.auth, saved);
    }
  });

  it('an unmatched sandbox-adjacent path 404s (no catch-all silently authenticating everything)', async () => {
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
    expect(importMapViolations(html), 'served HTML contains an off-origin import map').toEqual([]);

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
      expect(importMapViolations(text), `${file} contains an off-origin import map`).toEqual([]);
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

describe('W-sandbox — production gating via the REAL buildApp()/mountGraphql() call site', () => {
  // The two tests above call mountGraphqlSandbox()/sandboxEnabled() directly — they
  // prove those functions behave correctly in isolation, but NOT that
  // graphql/index.ts's real call site (`mountGraphqlSandbox(router, sandboxEnabled());`)
  // actually wires them together. A bug there — a hardcoded `true`, or reading the
  // wrong env — would leave every test above green while the real server always
  // serves the sandbox in production. These go through startTestServer() ->
  // buildApp() -> mountGraphql() -> the real zero-arg sandboxEnabled() call, under a
  // genuinely mutated process.env — the actual boot-time path.
  //
  // Why mutating process.env.NODE_ENV here is safe: config.ts's fail-closed boot
  // guards (e.g. "AUTH_MODE=test is forbidden in production") run ONCE at module-
  // import time, already evaluated before this test file ever runs — flipping
  // process.env afterward doesn't re-trigger them. sandbox.ts's sandboxEnabled() was
  // deliberately written to read process.env live (not from that frozen config
  // snapshot) specifically so this test is possible without a second process.
  it('NODE_ENV=production, no flag: the real server 404s /api/graphql/sandbox', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    const savedFlag = process.env.GRAPHQL_SANDBOX;
    process.env.NODE_ENV = 'production';
    delete process.env.GRAPHQL_SANDBOX;
    let s: TestServer | undefined;
    try {
      s = await startTestServer();
      const res = await fetch(`${s.url}/api/graphql/sandbox`);
      expect(res.status).toBe(404);
    } finally {
      await s?.close();
      process.env.NODE_ENV = savedNodeEnv;
      if (savedFlag === undefined) delete process.env.GRAPHQL_SANDBOX;
      else process.env.GRAPHQL_SANDBOX = savedFlag;
    }
  });

  it('NODE_ENV=production WITH GRAPHQL_SANDBOX=1: the real server serves it', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    const savedFlag = process.env.GRAPHQL_SANDBOX;
    process.env.NODE_ENV = 'production';
    process.env.GRAPHQL_SANDBOX = '1';
    let s: TestServer | undefined;
    try {
      s = await startTestServer();
      const res = await fetch(`${s.url}/api/graphql/sandbox`);
      expect(res.status).toBe(200);
    } finally {
      await s?.close();
      process.env.NODE_ENV = savedNodeEnv;
      if (savedFlag === undefined) delete process.env.GRAPHQL_SANDBOX;
      else process.env.GRAPHQL_SANDBOX = savedFlag;
    }
  });
});
