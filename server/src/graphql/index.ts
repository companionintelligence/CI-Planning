import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Koa from 'koa';
import Router from '@koa/router';
import { ApolloServer } from '@apollo/server';
import { koaMiddleware } from '@as-integrations/koa';
import { config } from '../lib/config.js';
import { currentOwnerId } from '../lib/context.js';
import { resolvers } from './resolvers.js';
import { complexityPlugin } from './complexity.js';

// Schema-first: the SDL is the source of truth (kept diff-comparable to CI-Server's
// generated schema.graphql). Loaded relative to this module — the server runs via tsx
// on src/ (dev + prod), so the .graphql sits beside its compiled-away importer.
const _dir = dirname(fileURLToPath(import.meta.url));
const typeDefs = readFileSync(join(_dir, 'schema.graphql'), 'utf8');

export interface GraphqlContext {
  ownerId: string;
}

/**
 * Build + start Apollo and mount it at /api/graphql. Mounted in buildApp AFTER
 * requireAuth, so:
 *   - the endpoint is auth-gated (it's under /api and not in PUBLIC_PREFIXES), and
 *   - the resolver context reads the owner requireAuth already bound in
 *     AsyncLocalStorage — GraphQL never re-derives auth (Decision 5).
 * Additive to REST; nothing existing changes.
 *
 * Scope note: requireAuth maps HTTP method → scope (POST ⇒ planning:write). The route is
 * restricted to POST (below) so it can't be reached by a read-only credential through a
 * GET, and so the scope model stays a single, predictable "GraphQL needs write" until
 * per-operation (query vs mutation) scoping is added. Session modes carry both scopes.
 */
export async function mountGraphql(app: Koa): Promise<void> {
  const server = new ApolloServer<GraphqlContext>({
    typeDefs,
    resolvers,
    introspection: true, // safe: the endpoint is behind requireAuth (private app)
    plugins: [complexityPlugin(() => config.graphql.maxComplexity)],
  });
  await server.start();

  const router = new Router();
  // Cast note: @as-integrations/koa@2 + @apollo/server@5.5.1 surface a spurious
  // "ApolloServer has two declarations of private 'internals'" type error under pnpm,
  // even though a single @apollo/server copy is installed (both symlinks resolve to the
  // same realpath — verified). It's a type-identity artifact only; the middleware
  // receives the real server instance at runtime (proven by graphql.test.ts). Cast to
  // the middleware's own expected server type to satisfy tsc without masking anything.
  const gqlMiddleware = koaMiddleware(server as unknown as Parameters<typeof koaMiddleware>[0], {
    context: async () => ({ ownerId: currentOwnerId() }),
  });
  // POST-only: GraphQL queries + mutations all POST, and this keeps the method→scope
  // mapping unambiguous (a GET would map to planning:read and let a read-only credential in).
  router.post('/api/graphql', gqlMiddleware);
  app.use(router.routes()).use(router.allowedMethods());
}
