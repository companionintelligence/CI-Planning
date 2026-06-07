# Companion Planning (ci-planning) — CI marketplace container.
# pnpm monorepo: builds the SolidJS client into server/public, then runs the Koa
# server (via tsx) which serves the built PWA + /api on the Hub internalPort (3848).
# Published as ghcr.io/companionintelligence/ci-planning.

FROM node:22-bookworm-slim

# better-sqlite3 is a native module — needs a build toolchain at install time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app

# Install workspace deps (client + server). Copy manifests first for layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY client/package.json ./client/
COPY server/package.json ./server/
RUN pnpm install --frozen-lockfile

# Build the SolidJS client (vite outDir → server/public); the server runs via tsx.
COPY . .
RUN pnpm --filter client build

ENV NODE_ENV=production \
    PORT=3848 \
    DB_PATH=/data/companion.db
RUN mkdir -p /data
EXPOSE 3848

WORKDIR /app/server
CMD ["pnpm", "start"]
