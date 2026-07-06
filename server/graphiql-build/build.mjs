#!/usr/bin/env node
/**
 * One-time (re-run manually when the graphiql pin changes) build of the vendored
 * GraphiQL sandbox bundle. NOT run at server startup or in the test/CI pipeline — the
 * output is checked into `graphiql-assets/` like any other vendored third-party asset
 * (comparable to how a project would vendor a downloaded .min.js). Re-run this script
 * by hand after bumping graphiql/react/react-dom in package.json, then commit the
 * regenerated files.
 *
 * Produces, under ../graphiql-assets/:
 *   sandbox.js / sandbox.css   — the app bundle (React + GraphiQL + fetcher + our
 *                                 Monaco worker wiring), plus GraphiQL's own CSS.
 *   editor.worker.js
 *   json.worker.js
 *   graphql.worker.js         — Monaco's web workers, bundled as separate IIFE entry
 *                                 points (see workers.ts for why).
 *
 * Everything is bundled with `platform: 'browser'`, `format: 'iife'` (no import maps,
 * no bare-specifier resolution at request time — the exact thing that makes the
 * upstream ESM-CDN example reach esm.sh) and zero external `url()`/CDN references
 * (fonts are inlined as base64 by graphiql's own stylesheet already).
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = join(__dirname, '..', 'graphiql-assets');

async function main() {
  // Main app bundle: React + GraphiQL + our fetcher/worker wiring. CSS is extracted
  // automatically by esbuild because entry.tsx does `import 'graphiql/style.css'`.
  await build({
    entryPoints: [join(__dirname, 'entry.tsx')],
    bundle: true,
    minify: true,
    sourcemap: false,
    format: 'iife',
    platform: 'browser',
    target: ['es2020'],
    outfile: join(outdir, 'sandbox.js'),
    // Monaco's codicon icon font (.ttf) is pulled in transitively via its own CSS
    // `url(./codicon.ttf)`. Inline it as a data: URI (same approach graphiql's own
    // style.css already uses for its fonts) so there's no extra same-origin request to
    // wire up AND no chance of it ever resolving off-origin.
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.ttf': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });

  // Monaco's workers, each a standalone IIFE (they run in a Worker global scope, not a
  // module scope — `new Worker(url)` below with no `{ type: 'module' }` matches that).
  const workerEntries = {
    'editor.worker.js': 'monaco-editor/esm/vs/editor/editor.worker.js',
    'json.worker.js': 'monaco-editor/esm/vs/language/json/json.worker.js',
    'graphql.worker.js': 'monaco-graphql/esm/graphql.worker.js',
  };
  for (const [outfileName, entry] of Object.entries(workerEntries)) {
    await build({
      entryPoints: [entry],
      bundle: true,
      minify: true,
      sourcemap: false,
      format: 'iife',
      platform: 'browser',
      target: ['es2020'],
      outfile: join(outdir, outfileName),
      resolveExtensions: ['.js', '.ts'],
      // Bare specifiers ("monaco-editor/esm/...") resolve node_modules-style relative
      // to this cwd, not relative to graphiql-build/ (which has none of its own deps).
      absWorkingDir: join(__dirname, '..'),
    });
  }

  // Sanity: fail the build loudly if anything reaches off-origin AT RUNTIME — catches an
  // accidental CDN import/font/url() regression before it's committed. Same substantive
  // check server/test/graphql-sandbox.test.ts runs against the served HTML+assets
  // (belt + suspenders — this one runs at build time, on the pre-minified source too).
  //
  // A plain "contains an http(s):// string" grep over a bundle this size is too broad:
  // React/Monaco/graphql-language-service legitimately embed http(s) strings that are
  // never dereferenced as network requests —
  //   - DOM/XML *namespace* URIs (createElementNS("http://www.w3.org/2000/svg", ...)
  //     etc.) — spec-mandated identifier strings, not fetched.
  //   - Doc/license/help links surfaced as inert text or an explicit user click-through
  //     (VS Code keybinding help, monaco-editor's own FAQ/LICENSE, prettier/commonmark
  //     doc links, React's "visit this URL for the full error message" hint).
  // What we actually care about is any URL that the BROWSER would auto-load without a
  // click: <script src=, <link href=, fetch(, import(, importScripts(, new Worker(,
  // or an @font-face/background url(). None of those should ever target a non-relative
  // URL in this bundle.
  const autoLoadPattern =
    /(?:fetch\(|importScripts\(|new Worker\(|import\(|<script[^>]*\bsrc=|<link[^>]*\bhref=|url\()\s*["'`]\s*https?:\/\/(?!localhost|127\.0\.0\.1)/gi;
  for (const f of ['sandbox.js', 'sandbox.css']) {
    const path = join(outdir, f);
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue; // sandbox.css only exists if esbuild extracted CSS into that name
    }
    const matches = text.match(autoLoadPattern);
    if (matches) {
      throw new Error(
        `${f} contains ${matches.length} auto-loaded off-origin reference(s) — ` +
          `investigate before vendoring (found: ${[...new Set(matches)].slice(0, 5).join(', ')})`,
      );
    }
  }

  console.log(`GraphiQL sandbox bundle written to ${outdir}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
