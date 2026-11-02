# Third-party dependencies

Every direct dependency declared in this repository's manifests — both
`dependencies` and `devDependencies` — grouped by licence, alphabetical within
each group. Transitive dependencies are not listed; resolve them with your
package manager's own `licenses` command.

**59 direct dependencies** across 8 licence groups.

Two caveats. Versions are the ones `pnpm-lock.yaml` resolves for the root, `server/` and
`client/` manifests; `@playwright/test`, `playwright` and `@companionintelligence/video-kit`
live outside the workspace (`tests/container/`, `video/`), so their rows show the declared
version. And the list does not yet include the Capacitor packages of the app shells under
`mobile/` (`@capacitor/core`, `@capacitor/android`, `@capacitor/ios`, `@capacitor/cli`) or
the private `@companionintelligence/config` and `@companionintelligence/tokens` packages.

| Licence | Count |
| --- | ---: |
| MIT | 48 |
| Apache-2.0 | 5 |
| BSD-3-Clause | 1 |
| ISC | 1 |
| MIT OR Apache-2.0 | 1 |
| MIT-0 | 1 |
| **MPL-2.0** ⚠️ | 1 |
| first-party (internal) | 1 |

## MIT

1. [`@apollo/server`](https://github.com/apollographql/apollo-server#readme) `5.5.1` — runtime
2. [`@as-integrations/koa`](https://github.com/apollo-server-integrations/apollo-server-integration-koa#readme) `2.0.0` — runtime
3. [`@koa/cors`](https://github.com/koajs/cors) `5.0.0` — runtime
4. [`@koa/router`](https://github.com/koajs/router) `15.6.0` — runtime
5. [`@modelcontextprotocol/sdk`](https://modelcontextprotocol.io) `1.29.0` — runtime
6. [`@node-rs/argon2`](https://github.com/napi-rs/node-rs) `2.0.2` — runtime
7. [`@sentry/browser`](https://github.com/getsentry/sentry-javascript) `10.69.0` — runtime
8. [`@sentry/node`](https://github.com/getsentry/sentry-javascript) `10.69.0` — runtime
9. [`@solidjs/router`](https://github.com/solidjs/solid-router#readme) `0.16.1` — runtime
10. [`better-sqlite3`](http://github.com/WiseLibs/better-sqlite3) `12.10.0` — runtime
11. [`chrono-node`](http://github.com/wanasit/chrono) `2.9.1` — runtime
12. [`croner`](https://croner.56k.guru) `10.0.1` — runtime
13. [`graphql`](https://github.com/graphql/graphql-js) `16.14.2` — runtime
14. [`koa`](https://koajs.com) `3.2.1` — runtime
15. [`koa-bodyparser`](https://github.com/koajs/body-parser) `4.4.1` — runtime
16. [`koa-static`](https://github.com/koajs/static#readme) `5.0.0` — runtime
17. [`pg`](https://github.com/brianc/node-postgres) `8.22.0` — runtime
18. [`solid-js`](https://solidjs.com) `1.9.13` — runtime
19. [`typeorm`](https://typeorm.io) `1.1.0` — runtime
20. [`@graphiql/toolkit`](https://github.com/graphql/graphiql) `0.12.1` — dev
21. [`@solidjs/testing-library`](https://github.com/solidjs/solid-testing-library#readme) `0.8.10` — dev
22. [`@tailwindcss/postcss`](https://tailwindcss.com) `4.3.0` — dev
23. [`@testing-library/jest-dom`](https://github.com/testing-library/jest-dom#readme) `6.9.1` — dev
24. [`@types/better-sqlite3`](https://github.com/DefinitelyTyped/DefinitelyTyped) `7.6.13` — dev
25. [`@types/koa`](https://github.com/DefinitelyTyped/DefinitelyTyped) `3.0.3` — dev
26. [`@types/koa__router`](https://www.npmjs.com/package/@types/koa__router) `12.0.5` — dev
27. [`@types/koa-bodyparser`](https://github.com/DefinitelyTyped/DefinitelyTyped) `4.3.13` — dev
28. [`@types/koa-static`](https://github.com/DefinitelyTyped/DefinitelyTyped) `4.0.4` — dev
29. [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) `25.9.2` — dev
30. [`@types/nodemailer`](https://github.com/DefinitelyTyped/DefinitelyTyped) `8.0.1` — dev
31. [`@types/pg`](https://github.com/DefinitelyTyped/DefinitelyTyped) `8.20.2` — dev
32. [`@types/web-push`](https://github.com/DefinitelyTyped/DefinitelyTyped) `3.6.4` — dev
33. [`autoprefixer`](https://github.com/postcss/autoprefixer#readme) `10.5.0` — dev
34. [`concurrently`](https://github.com/open-cli-tools/concurrently#readme) `10.0.3` — dev
35. [`drizzle-kit`](https://orm.drizzle.team) `0.31.10` — dev
36. [`esbuild`](https://github.com/evanw/esbuild#readme) `0.25.12` — dev
37. [`graphiql`](https://github.com/graphql/graphiql) `5.2.4` — dev
38. [`jsdom`](https://github.com/jsdom/jsdom#readme) `29.1.1` — dev
39. [`monaco-editor`](https://github.com/microsoft/monaco-editor) `0.52.2` — dev
40. [`monaco-graphql`](https://github.com/graphql/graphiql#readme) `1.8.0` — dev
41. [`postcss`](https://postcss.org/) `8.5.15` — dev
42. [`react`](https://react.dev/) `19.2.5` — dev
43. [`react-dom`](https://react.dev/) `19.2.5` — dev
44. [`tailwindcss`](https://tailwindcss.com) `4.3.0` — dev
45. [`tsx`](https://tsx.hirok.io) `4.22.4` — dev
46. [`vite`](https://vite.dev) `8.0.16` — dev
47. [`vite-plugin-solid`](https://github.com/solidjs/vite-plugin-solid#readme) `2.11.12` — dev
48. [`vitest`](https://vitest.dev) `4.1.8` — dev

## Apache-2.0

1. [`drizzle-orm`](https://orm.drizzle.team) `0.45.2` — runtime
2. [`reflect-metadata`](https://github.com/rbuckton/reflect-metadata) `0.2.2` — runtime
3. [`@playwright/test`](https://playwright.dev) `^1.60.0` — dev
4. [`playwright`](https://playwright.dev) `1.62.1` — dev
5. [`typescript`](https://www.typescriptlang.org/) `6.0.3` — dev

## BSD-3-Clause

1. [`rrule`](https://github.com/jakubroztocil/rrule) `2.8.1` — runtime

## ISC

1. [`lucide-solid`](https://lucide.dev) `1.17.0` — runtime

## MIT OR Apache-2.0

1. [`sqlite-vec`](https://github.com/asg017/sqlite-vec#readme) `0.1.9` — runtime

## MIT-0

1. [`nodemailer`](https://nodemailer.com/) `9.0.3` — runtime

## MPL-2.0 ⚠️

> Reciprocal licence — see [NOTICE.md](NOTICE.md).

1. [`web-push`](https://github.com/web-push-libs/web-push#readme) `3.6.7` — runtime

## first-party (internal)

1. [`@companionintelligence/video-kit`](https://github.com/companionintelligence/CI-Planning) `^0.1.0` — dev


---

_Generated by [`scripts/generate-attribution.mjs`](https://github.com/companionintelligence/CI-Engineering/blob/main/scripts/generate-attribution.mjs) for `CI-Planning`. Regenerate rather than editing generated sections by hand._
