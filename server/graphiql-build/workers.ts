/**
 * Monaco Editor (used internally by graphiql@5/@graphiql/react) needs Web Workers for
 * syntax highlighting / language features. Upstream ships bundler-specific helpers
 * (`graphiql/setup-workers/vite`, `.../webpack`) that assume a bundler which understands
 * `?worker` import suffixes or `new URL(..., import.meta.url)` — neither applies to our
 * hand-rolled esbuild bundle, so this is our own equivalent of `setup-workers/webpack`:
 * point MonacoEnvironment.getWorker at same-origin worker script URLs that
 * `graphiql-build/build.mjs` bundles as separate entry points (editor/json/graphql
 * workers) into graphiql-assets/*.worker.js, served under /api/graphql/sandbox-assets/.
 */
declare const globalThis: any;

globalThis.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new Worker('/api/graphql/sandbox-assets/json.worker.js');
      case 'graphql':
        return new Worker('/api/graphql/sandbox-assets/graphql.worker.js');
      default:
        return new Worker('/api/graphql/sandbox-assets/editor.worker.js');
    }
  },
};
