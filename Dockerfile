# Companion Planning (ci-planning) — CI marketplace container.
# pnpm monorepo: builds the SolidJS client into server/public, then runs the Koa
# server (via tsx) which serves the built PWA + /api on the Hub internalPort (3848).
# Published as ghcr.io/companionintelligence/ci-planning.

FROM node:26-bookworm-slim

# better-sqlite3 is a native module — needs a build toolchain at install time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Node 26 no longer bundles corepack, so install it before enabling the pnpm
# shim (which honors the pinned packageManager: pnpm@x.y.z in package.json).
RUN npm install -g corepack@latest && corepack enable

WORKDIR /app

# Install workspace deps (client + server). Copy manifests first for layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN pnpm install --frozen-lockfile

# Browser error reporting — OPTIONAL and off by default. Vite INLINES import.meta.env.*
# into the bundle, so the client DSN is a BUILD-time value: it has to be passed here,
# not set in the container's runtime environment where it would do nothing. Unset (the
# default) ⇒ the bundle initialises no Sentry and makes no outbound connection.
# The server half is plain runtime env (SENTRY_DSN) and deliberately is NOT an ARG —
# baking a DSN into the image would take an operator a rebuild to undo. Posture and
# kill switches: docs/operations/error-reporting.md.
#
# ARG (not ENV) on purpose: a build arg is already exported into the environment of the
# RUN below — which is all Vite needs, since it picks up inline VITE_-prefixed vars from
# process.env — and it does not linger in the published image's config the way an ENV
# would.
#   docker build --build-arg VITE_SENTRY_DSN=https://…ingest.us.sentry.io/… .
ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_RELEASE=""
ARG VITE_CI_PLANNING_ENVIRONMENT=""

# Build the SolidJS client (vite outDir → server/public); the server runs via tsx.
COPY . .
RUN pnpm --filter client build

ENV NODE_ENV=production \
    PORT=3848 \
    DB_PATH=/data/companion.db
RUN mkdir -p /data
EXPOSE 3848

# Liveness probe for orchestrators (docker/compose/k8s). Node 26 ships a global
# fetch, so the slim image needs no curl/wget. Hits the public /api/health endpoint
# on the configured PORT; start-period covers first-boot migrations.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3848)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
# Exec tsx directly (not via pnpm) so node is PID 1 and receives SIGTERM —
# otherwise docker stop kills pnpm before the server can shut down gracefully.
#
# --env-file-if-exists=/data/.env: operator overrides live on the persistent volume,
# matching the CI platform convention (CI-OpenClaw's bootstrap-from-hub.sh writes the
# app's .env into its data dir the same way). Real env vars injected by the Hub/Docker
# still win — Node only fills in keys the process environment doesn't already define —
# and the flag is a no-op when the file is absent, so a plain `docker run` is unchanged.
CMD ["node_modules/.bin/tsx", "--env-file-if-exists=/data/.env", "src/index.ts"]
