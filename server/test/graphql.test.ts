import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTestServer, type TestServer } from './helpers.js';
import { config } from '../src/lib/config.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W bootstrap — the GraphQL surface at /api/graphql. Proves the end-to-end
 * plumbing the design doc's step 1 calls for: Apollo is mounted on Koa, the resolver
 * context reads the auth-bound owner (currentOwnerId, Decision 5), the custom scalars
 * serialize, the endpoint is auth-gated, and the complexity limiter rejects an
 * over-budget query. Runs in the default `test` auth mode (system owner injected), which
 * ALSO confirms the koaMiddleware cast in graphql/index.ts is sound at runtime — a broken
 * server instance would fail every query here.
 */

let srv: TestServer;

async function gql(query: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => ({})) as { data?: any; errors?: any[] };
  return { status: res.status, body };
}

beforeAll(async () => {
  srv = await startTestServer();
});
afterAll(async () => {
  await srv.close();
});

describe('W — GraphQL bootstrap (/api/graphql)', () => {
  it('resolves `viewer` — auth context flows in and DateTime serializes', async () => {
    const { status, body } = await gql('{ viewer { ownerId serverTime } }');
    expect(status).toBe(200);
    expect(body.errors).toBeUndefined();
    // test mode binds the system owner via requireAuth → currentOwnerId() in the resolver.
    expect(body.data.viewer.ownerId).toBe(SYSTEM_OWNER);
    // DateTime scalar → an ISO-8601 string.
    expect(body.data.viewer.serverTime).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('serves introspection (schema is valid + built)', async () => {
    const { status, body } = await gql('{ __schema { queryType { name } } }');
    expect(status).toBe(200);
    expect(body.data.__schema.queryType.name).toBe('Query');
  });

  it('rejects a query over the complexity budget', async () => {
    const saved = config.graphql.maxComplexity;
    config.graphql.maxComplexity = 1; // `{ viewer { ownerId serverTime } }` costs > 1
    try {
      const { body } = await gql('{ viewer { ownerId serverTime } }');
      expect(body.errors?.[0]?.message).toMatch(/too complex/i);
    } finally {
      config.graphql.maxComplexity = saved;
    }
  });

  it('costs ONLY the executed operation, not every operation in the document', async () => {
    // Two operations; `{ viewer { ownerId serverTime } }` (A) costs 3. With the limit at 3
    // and operationName=A, the request must pass — summing both operations (the old bug)
    // would over-count and reject it.
    const saved = config.graphql.maxComplexity;
    config.graphql.maxComplexity = 3;
    try {
      const res = await fetch(`${srv.url}/api/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query A { viewer { ownerId serverTime } } query B { viewer { ownerId } }',
          operationName: 'A',
        }),
      });
      const body = (await res.json()) as { data?: any; errors?: any[] };
      expect(body.errors).toBeUndefined();
      expect(body.data.viewer.ownerId).toBe(SYSTEM_OWNER);
    } finally {
      config.graphql.maxComplexity = saved;
    }
  });

  it('is POST-only — a GET is rejected (405), closing the method→scope gap', async () => {
    const res = await fetch(`${srv.url}/api/graphql?query=${encodeURIComponent('{ viewer { ownerId } }')}`);
    expect(res.status).toBe(405); // route registered for POST only
  });

  it('is auth-gated: no credential ⇒ 401, never reaching GraphQL', async () => {
    // Flip to sso mode (no session cookie presented) so requireAuth rejects before Apollo.
    const saved = { ...config.auth };
    config.auth.mode = 'sso';
    config.auth.disableOidc = true;
    config.auth.sessionSecret = 'test-session-secret';
    const s = await startTestServer();
    try {
      const res = await fetch(`${s.url}/api/graphql`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ viewer { ownerId } }' }),
      });
      expect(res.status).toBe(401); // gated by requireAuth (not a GraphQL 200-with-errors)
    } finally {
      await s.close();
      Object.assign(config.auth, saved);
    }
  });
});
