/**
 * W-sandbox entry point — bundled ONCE (offline, by `graphiql-build/build.mjs`) into
 * `graphiql-assets/sandbox.js`, which is what actually ships to the browser. This file
 * itself is never sent to a client and never runs on the server; it only exists so
 * esbuild has TypeScript/JSX to compile.
 *
 * Why a hand-rolled bundle instead of `graphiql`'s documented embed path — see the long
 * comment in `server/src/graphql/sandbox.ts` for the full investigation. Short version:
 * graphiql@5's own README now points at an ESM-CDN example that resolves bare imports
 * (`react`, `graphiql`, `@graphiql/react`, ...) through `esm.sh?standalone` at request
 * time — i.e. it reaches an external host on every page load. That's exactly what the
 * app's local-first guarantee forbids (same reason Apollo's hosted Sandbox is rejected).
 * The old no-build UMD bundle (`graphiql/graphiql.min.js`) that this ticket's brief
 * asked us to check for was removed after graphiql@2 — only pre-2 majors (pinned to
 * graphql@15, incompatible with this workspace's forced graphql@16.14.2 override) still
 * ship it. So: install the real `graphiql`/`react`/`react-dom`/`@graphiql/toolkit`
 * packages as normal pinned dependencies, and produce ONE small local bundle ourselves
 * with esbuild — checked in under graphiql-assets/, not rebuilt at server start.
 */
import './workers.js'; // must run before `graphiql` mounts Monaco — see workers.ts
import React from 'react';
import { createRoot } from 'react-dom/client';
import { GraphiQL } from 'graphiql';
import { createGraphiQLFetcher } from '@graphiql/toolkit';
import 'graphiql/style.css';

// Same-origin relative URL — never absolute, never a CDN. The browser sends the
// existing session cookie automatically, so a logged-in owner's queries/mutations
// authenticate with zero extra wiring (requireAuth already gates POST /api/graphql).
const fetcher = createGraphiQLFetcher({ url: '/api/graphql' });

function App() {
  return React.createElement(GraphiQL, {
    fetcher,
    defaultEditorToolsVisibility: true,
  });
}

const container = document.getElementById('graphiql-root');
if (!container) throw new Error('#graphiql-root not found');
createRoot(container).render(React.createElement(App));
