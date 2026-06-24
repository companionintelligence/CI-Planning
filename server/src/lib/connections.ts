import { sqlite } from '../db/index.js';
import { open, loadKek } from './crypto/index.js';
import { logger } from './logger.js';

/**
 * WP7 — read-only Google connection health for the Settings "Connections" card.
 *
 * A "connection" is a SETTING surfaced for observability, NOT a new glossary noun.
 * This shape is deliberately MINIMAL and is the locked client/server contract:
 * it exposes ONLY a status, the access-token expiry, a mapped-event count and the
 * latest sync outcome. It NEVER leaks token material (accessToken/refreshToken/
 * ciphertext/iv/auth_tag/key_version) — see the no-leak guard in connections.test.ts.
 */
export interface ConnectionHealth {
  provider: string;                                  // always 'google' in WP7
  account: string;
  status: 'connected' | 'expired' | 'inactive';
  expiresAt: string | null;                          // access-token expiry (ISO); null when inactive / unknown
  mappedEventCount: number;                           // external_events rows for this (owner, provider, account)
  lastSyncAt: string | null;                          // finished_at ?? started_at of the most recent sync_calendar run
  lastError: string | null;                           // job_runs.log of that run when it errored, else null
}

interface TokenRow {
  account: string;
  iv: string;
  auth_tag: string;
  ciphertext: string;
  status: string; // 'active' | 'revoked' | 'error'
}

interface SyncRunRow {
  finished_at: string | null;
  started_at: string | null;
  status: string | null;
  log: string | null;
}

/**
 * Build one ConnectionHealth per (provider='google', account) connection_tokens row
 * for `ownerId`. Returns [] (never null) when the owner has no Google tokens.
 *
 * status resolution:
 *  - row.status <> 'active'              → 'inactive' (expiresAt null; we never decrypt)
 *  - else decrypt ONLY the token's expiresAt:
 *      - decoded expiresAt <= now        → 'expired'
 *      - else                            → 'connected'
 *  - if open() throws (tamper/wrong key) → 'inactive', expiresAt null, log a redacted
 *    warning (NEVER the ciphertext). A bad row must NOT 500 the /api/integrations endpoint.
 */
export function connectionHealth(ownerId: string): ConnectionHealth[] {
  const tokens = sqlite
    .prepare(
      `SELECT account, iv, auth_tag, ciphertext, status
         FROM connection_tokens
        WHERE owner_id = ? AND provider = 'google'
        ORDER BY account ASC`,
    )
    .all(ownerId) as TokenRow[];

  const now = Date.now();

  return tokens.map((row): ConnectionHealth => {
    let status: ConnectionHealth['status'];
    let expiresAt: string | null = null;

    if (row.status !== 'active') {
      // Revoked / error rows are inactive — no decrypt, no expiry.
      status = 'inactive';
    } else {
      try {
        const plain = open(
          { iv: row.iv, authTag: row.auth_tag, ciphertext: row.ciphertext },
          loadKek(),
        );
        const exp = extractExpiresAt(plain);
        expiresAt = exp;
        const expMs = exp ? Date.parse(exp) : NaN;
        // No / unparseable expiry → treat as connected (can't prove it's expired).
        status = Number.isFinite(expMs) && expMs <= now ? 'expired' : 'connected';
      } catch (err) {
        // Decrypt failed (tamper, missing/rotated KEK). Degrade to inactive; never
        // surface or log the ciphertext. logger.redact masks token-shaped fields too.
        logger.warn('connectionHealth: failed to open token; treating as inactive', {
          account: row.account,
          err: (err as Error).message,
        });
        status = 'inactive';
        expiresAt = null;
      }
    }

    const sync = latestSyncRun(ownerId, 'google', row.account);

    return {
      provider: 'google',
      account: row.account,
      status,
      expiresAt,
      mappedEventCount: mappedEventCount(ownerId, row.account),
      lastSyncAt: sync ? sync.finished_at ?? sync.started_at : null,
      lastError: sync && sync.status === 'error' ? sync.log : null,
    };
  });
}

/**
 * Decode `expiresAt` from a sealed token's plaintext. The token JSON shape is owned
 * by WP2 (the OAuth flow); we read defensively across the common field names without
 * assuming the rest of the payload. Returns an ISO string or null.
 *  - number (epoch seconds or millis) → normalized to ISO
 *  - string                            → passed through (assumed ISO)
 */
function extractExpiresAt(plain: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const raw = obj.expiresAt ?? obj.expires_at ?? obj.expiry ?? obj.expiry_date;

  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? raw : null;
  }
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Heuristic: <1e12 is epoch seconds, otherwise millis.
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return new Date(ms).toISOString();
  }
  return null;
}

/** COUNT(*) of external_events mapped to this (owner, 'google', account). */
function mappedEventCount(ownerId: string, account: string): number {
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n
         FROM external_events
        WHERE owner_id = ? AND provider = 'google' AND account = ?`,
    )
    .get(ownerId, account) as { n: number };
  return row.n;
}

/**
 * The most recent sync_calendar job run, joined scheduled_jobs(kind='sync_calendar').
 * NB: job_runs is not owner-scoped (system actor), so the join is by kind only — this
 * mirrors the shared nightly cron. ORDER BY started_at DESC LIMIT 1.
 */
function latestSyncRun(_ownerId: string, _provider: string, _account: string): SyncRunRow | undefined {
  return sqlite
    .prepare(
      `SELECT jr.finished_at, jr.started_at, jr.status, jr.log
         FROM job_runs jr
         JOIN scheduled_jobs sj ON sj.id = jr.job_id
        WHERE sj.kind = 'sync_calendar'
        ORDER BY jr.started_at DESC
        LIMIT 1`,
    )
    .get() as SyncRunRow | undefined;
}
