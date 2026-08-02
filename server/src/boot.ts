// The real startup sequence. Loaded via a dynamic import from index.ts so that a boot
// guard which throws during module evaluation (the config.ts env checks fire at import
// time) is caught there and surfaced as one clean `FATAL: <reason>` line instead of a
// raw uncaught-exception stack trace. See index.ts for the wrapper.
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { buildApp } from './app.js';
import { startCronJobs, failInterruptedJobRuns } from './jobs/index.js';
import { pushEnabled } from './lib/push.js';
import { status as ollamaStatus } from './mcp/ollama.js';

// DB is initialised on import (runs setup + seed).
import { sqlite } from './db/index.js';
import { initPg, closePg } from './db/pg.js';
import { runPgMigrations } from './db/migrate-pg.js';
import { setStore, store, createSqliteStore, createPostgresStore } from './db/store.js';
import { recoverStaleFreezeLocks } from './engine/auto-defense.js';
import { ensureLocalAuthBootstrap } from './lib/auth/localBootstrap.js';
import { writePidFile, removePidFile } from './lib/pidfile.js';

// Postgres (schema port). Opt-in via DATABASE_URL while the 386 SQLite call sites move
// file by file — with it unset this is inert and the SQLite path above is unchanged.
//
// Migrating at boot mirrors what the SQLite build did (db/index.ts runs its migrations
// on import), so a container still comes up migrated with no separate deploy step. The
// runner is dbmate-wire-compatible, so an operator who prefers to migrate ahead of the
// deploy can run `dbmate up` and this will simply find nothing pending.
//
// Awaited BEFORE the server listens: a half-migrated schema must never serve traffic.
// A failure here throws, which index.ts turns into one clean `FATAL:` line.
if (config.databaseUrl) {
  const pool = initPg({ connectionString: config.databaseUrl, schema: 'planning' });
  const { applied } = await runPgMigrations(pool, { schema: 'planning' });
  logger.info('Postgres schema ready', { migrationsApplied: applied.length });
}

// Install the data-facade backend (db/store.ts). Call sites migrate to `store()` in a
// pass of their own, with SQLite underneath so the suite stays green; STORE_BACKEND is
// what flips them onto Postgres once that pass is done. Default is sqlite, so this is
// inert until deliberately switched — and it refuses to select postgres without a
// DATABASE_URL rather than silently falling back to a store the data is not in.
if (config.storeBackend === 'postgres') {
  if (!config.databaseUrl) throw new Error('STORE_BACKEND=postgres requires DATABASE_URL');
  setStore(createPostgresStore());
} else {
  setStore(createSqliteStore(sqlite));
}
logger.info('Data store backend', { backend: store().backend });

// Local-auth mode (AUTH_MODE=sso + DISABLE_OIDC): seed the default owner or fail
// closed if there's no way to log in. No-op in every other mode. Awaited before we
// listen so a misconfigured local deployment refuses to start (matches config.ts guards).
await ensureLocalAuthBootstrap();

// Heal any auto blocks left `is_locked` by a reflow that was interrupted before its
// unfreeze could run (pre-fix databases). No-op once clean; reflow no longer freezes.
const recovered = recoverStaleFreezeLocks();
if (recovered > 0) logger.info(`Recovered ${recovered} stale auto-block lock(s) from an interrupted reflow`);

const app = await buildApp();

const server = app.listen(config.port, () => {
  logger.info(`Companion Planning running on http://localhost:${config.port}`);
});

// Claim the database for offline tools (restore.ts refuses to run while we hold it).
// Best-effort: a read-only data dir must not stop the server from booting.
writePidFile(config.dbPath);

// Warm the installed-model cache so the FIRST inference already auto-selects a model that
// is really pulled (lib/models.ts). Deliberately not awaited: Ollama is optional and may
// come up after us — until this resolves, resolution falls back to the configured names,
// and every later status() call refreshes the cache anyway. status() never throws.
void ollamaStatus().then((s) => {
  if (!s.available) {
    logger.info(`Ollama not reachable at ${s.url} — AI features degrade to their deterministic paths.`);
  } else if (!s.ready) {
    logger.warn(
      `Ollama is running but ${s.missingModels.join(', ')} is not installed — ` +
        `AI features stay off. Pull it (\`ollama pull …\`) or pick an installed model in Settings → Models.`,
    );
  } else {
    logger.info(`Ollama ready — small=${s.smallModel} medium=${s.mediumModel} embed=${s.embedModel}`);
  }
});

// Any job_run still marked `running` belongs to a process that no longer exists —
// settle those before the scheduler starts so the Jobs view isn't claiming work is
// in flight that nothing is doing.
failInterruptedJobRuns();
startCronJobs();

// Phase H: VAPID keys are now auto-provisioned at boot (services/vapid-config.ts), so push
// is normally live out of the box. It only stays dormant in two deliberate cases: a
// half-set env keypair (one of VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY), or a stored private key
// whose sealing KEK was removed/rotated. Surface that so an operator knows it's
// unconfigured, not broken — the vapid-config warning above says which case applies.
if (!pushEnabled()) {
  logger.warn('Web Push disabled — no usable VAPID keypair (in-app reminders still work). See the vapid-config warning above; set both VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or unset both to auto-generate.');
}

// Graceful shutdown: docker stop / Hub restarts send SIGTERM. Exit 0 so the
// container stops cleanly instead of surfacing a pnpm ELIFECYCLE failure.
//
// Closing the SQLite handle is the load-bearing part, not a tidy-up. better-sqlite3
// checkpoints the WAL back into the main database file on close; `process.exit()`
// without it leaves a hot `-wal` beside the db as the GUARANTEED post-stop state. That
// is what turns `restore.ts` into a corruption tool (a stale WAL from the OLD database
// replays onto a freshly-copied snapshot), and it is why an operator who does exactly
// the documented thing — stop the server, then restore — is the one who gets bitten.
// Idempotent and never throws, so a double signal or an already-closed handle is safe.
let closed = false;
function closeDb(): void {
  if (closed) return;
  closed = true;
  try {
    sqlite.close(); // checkpoints the WAL into the main db file
  } catch (err) {
    logger.warn(`shutdown: closing the database failed — a -wal file may remain: ${(err as Error).message}`);
  }
  // Drain the Postgres pool too. Not load-bearing the way the SQLite checkpoint is —
  // Postgres recovers from a dropped connection on its own — so it is fire-and-forget:
  // waiting on it would delay the exit the signal handler is racing a timeout to reach.
  void closePg().catch((err) => logger.warn(`shutdown: closing the pg pool failed: ${(err as Error).message}`));
  removePidFile(config.dbPath);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received — shutting down`);
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Open SSE streams keep the server alive; don't wait on them forever. Still
    // checkpoint on this path — it is the one systemd/docker actually hits.
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 3_000).unref();
  });
}
