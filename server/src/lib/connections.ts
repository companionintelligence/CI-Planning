import { store } from '../db/store.js';
import { open, loadKek } from './crypto/index.js';
import { logger } from './logger.js';
import { revoke } from '../connectors/index.js';
import { MEMORY_PROVIDER } from '../connectors/memory.js';

/**
 * ONE shape for a connection, over the one table that stores them.
 *
 * `connection_tokens` holds every provider's credentials (`google`, `ci_memory`,
 * fixture) and used to be read through two different "deliberately minimal" contracts:
 * `ConnectionHealth` (google-only, decrypted, for GET /api/integrations) and
 * `ConnectionSummary` (all providers, no decrypt, for GET /api/connections). Two minimal
 * contracts over the same rows is one contract too many, so this is the single one.
 *
 * A "connection" is a SETTING surfaced for observability, NOT a new glossary noun. The
 * shape NEVER leaks token material (accessToken/refreshToken/ciphertext/iv/auth_tag/
 * key_version) — see the no-leak guards in connections-unified.test.ts and
 * connections-route.test.ts.
 *
 * `status` is the MAPPED status, never the raw `connection_tokens.status` column: the raw
 * 'active' | 'revoked' | 'error' string used to reach clients through ConnectionSummary
 * and no longer does.
 */
export interface ConnectionRecord {
  /** 'google' | 'ci_memory' | … — whatever the row says. */
  provider: string;
  account: string;
  /**
   * Mapped, never the raw column: revoked/error/undecryptable ⇒ 'inactive'.
   *
   * 'connected' means the stored token was OPENED — not merely that a row exists. Every
   * caller gets that same guarantee, because there is only one code path (see
   * listConnections). It used to be weaker on the no-decrypt path, where an active row
   * reported 'connected' while every call using it failed.
   */
  status: 'connected' | 'expired' | 'inactive';
  /** ISO-8601 (connection_tokens.created_at). */
  createdAt: string;
  /** Access-token expiry (ISO), read out of the opened token. Null when the row is
   *  inactive, when it could not be opened, or when the payload carries no usable expiry. */
  expiresAt: string | null;
  /** finished_at ?? started_at of the most recent sync_calendar run (google only). */
  lastSyncAt: string | null;
  /** job_runs.log of that run when it errored, else null (google only). */
  lastError: string | null;
  /** external_events rows for this (owner, 'google', account). GOOGLE ONLY — absent,
   *  never 0, for other providers, so "no events" and "not an event source" stay
   *  distinguishable. */
  mappedEventCount?: number;
}

interface SafeRow {
  provider: string;
  account: string;
  status: string; // raw column: 'active' | 'revoked' | 'error' — mapped before it leaves
  created_at: string;
}

interface SealedRow {
  provider: string;
  account: string;
  iv: string;
  auth_tag: string;
  ciphertext: string;
}

interface SyncRunRow {
  finished_at: string | null;
  started_at: string | null;
  status: string | null;
  log: string | null;
}

/**
 * Every connection the owner holds, across all providers, ordered by provider then
 * account. Returns [] (never null) when the owner has none. Mode-blind ON PURPOSE: a user
 * whose Google integration is `off` must still see (and be able to drop) the stored token
 * — visibility of stored connections is exactly what this surface is for.
 *
 * status resolution — ONE path, so the answer never depends on which endpoint asked:
 *  - row.status <> 'active'                     → 'inactive' (expiresAt null; never decrypts)
 *  - active, opened, decoded expiry <= now      → 'expired'
 *  - active, opened, otherwise                  → 'connected'
 *  - active, cannot be opened (tamper / missing or rotated KEK) → 'inactive', expiresAt
 *    null, plus a REDACTED warning (never the ciphertext). A bad row must NOT 500 the
 *    endpoint.
 *
 * Every active row is OPENED, deliberately. This used to be opt-in (`withExpiry`), and the
 * opt-out path mapped an active row straight to 'connected' — so a token the app could no
 * longer decrypt read 'connected' from GET /api/connections and 'inactive' from GET
 * /api/integrations, and an operator whose KEK had rotated saw a green badge over a
 * connection that failed on every call. The saving was measured before it was dropped:
 * opening a row costs ~9µs, i.e. ~60µs added to a one-connection list and ~0.45ms to a
 * (wildly unrealistic) fifty-connection one. That is not worth a status that can lie.
 */
export async function listConnections(ownerId: string): Promise<ConnectionRecord[]> {
  // The list SELECT names only safe columns — no iv / auth_tag / ciphertext / key_version.
  // The sealed columns are fetched separately, by the one helper that needs them.
  const rows = await store()
    .prepare(
      `SELECT provider, account, status, created_at
         FROM connection_tokens
        WHERE owner_id = ?
        ORDER BY provider, account`,
    )
    .all<SafeRow>(ownerId);
  if (rows.length === 0) return [];

  // Nothing to open when every row is already revoked/errored — those never decrypt.
  const hasActive = rows.some((r) => r.status === 'active');
  const sealed = hasActive ? await sealedByAccount(ownerId) : new Map<string, SealedRow>();
  const counts = rows.some((r) => r.provider === 'google') ? await mappedEventCounts(ownerId) : null;
  // One sync_calendar lookup for the whole list: the query is keyed by job kind, not by
  // account (job_runs is not owner-scoped — a system actor runs the shared nightly cron),
  // so it returned the same row for every account when it ran per row.
  const sync = counts ? await latestSyncRun() : null;
  const now = Date.now();

  // ONE KEK load for the whole list (an env decode, not per-row work). A missing or
  // malformed KEK is a deployment fault, not N row faults, so it warns once here and the
  // per-row catch below is left for genuinely per-row failures (tamper, wrong key).
  let kek: Buffer | null = null;
  if (hasActive) {
    try {
      kek = await loadKek();
    } catch (err) {
      logger.warn('listConnections: no usable KEK; every active connection reports inactive', {
        err: (err as Error).message,
      });
    }
  }

  const out: ConnectionRecord[] = [];
  for (const row of rows) {
    let status: ConnectionRecord['status'];
    let expiresAt: string | null = null;

    if (row.status !== 'active') {
      // Revoked / error rows are inactive — no decrypt, no expiry.
      status = 'inactive';
    } else if (!kek) {
      // Warned once above. An unopenable row is never reported as usable.
      status = 'inactive';
    } else {
      const tok = sealed.get(`${row.provider}\u0000${row.account}`);
      try {
        if (!tok) throw new Error('sealed token row disappeared');
        const exp = extractExpiresAt(
          open({ iv: tok.iv, authTag: tok.auth_tag, ciphertext: tok.ciphertext }, kek),
        );
        expiresAt = exp;
        const expMs = exp ? Date.parse(exp) : NaN;
        // No / unparseable expiry → treat as connected (can't prove it's expired).
        status = Number.isFinite(expMs) && expMs <= now ? 'expired' : 'connected';
      } catch (err) {
        // This row would not open (tamper, or a KEK that loaded but is the wrong one).
        // Degrade to inactive; never surface or log the ciphertext. logger.redact masks
        // token-shaped fields too.
        logger.warn('listConnections: failed to open token; treating as inactive', {
          account: row.account,
          err: (err as Error).message,
        });
        status = 'inactive';
        expiresAt = null;
      }
    }

    const isGoogle = row.provider === 'google';
    out.push({
      provider: row.provider,
      account: row.account,
      status,
      createdAt: row.created_at,
      expiresAt,
      lastSyncAt: isGoogle && sync ? sync.finished_at ?? sync.started_at : null,
      lastError: isGoogle && sync && sync.status === 'error' ? sync.log : null,
      // Google only, and ABSENT rather than 0 elsewhere.
      ...(isGoogle ? { mappedEventCount: counts?.get(row.account) ?? 0 } : {}),
    });
  }
  return out;
}

/** The owner's sealed token columns, keyed by provider\0account. Active rows only —
 *  inactive rows are never decrypted. */
async function sealedByAccount(ownerId: string): Promise<Map<string, SealedRow>> {
  const rows = await store()
    .prepare(
      `SELECT provider, account, iv, auth_tag, ciphertext
         FROM connection_tokens
        WHERE owner_id = ? AND status = 'active'`,
    )
    .all<SealedRow>(ownerId);
  return new Map(rows.map((r) => [`${r.provider}\u0000${r.account}`, r]));
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

/** COUNT(*) of external_events per (owner, 'google', account), in one grouped query. */
async function mappedEventCounts(ownerId: string): Promise<Map<string, number>> {
  const rows = await store()
    .prepare(
      `SELECT account, COUNT(*) AS n
         FROM external_events
        WHERE owner_id = ? AND provider = 'google'
        GROUP BY account`,
    )
    .all<{ account: string; n: number }>(ownerId);
  return new Map(rows.map((r) => [r.account, r.n]));
}

/**
 * The most recent sync_calendar job run, joined scheduled_jobs(kind='sync_calendar').
 * NB: job_runs is not owner-scoped (system actor), so the join is by kind only — this
 * mirrors the shared nightly cron. ORDER BY started_at DESC LIMIT 1.
 */
async function latestSyncRun(): Promise<SyncRunRow | undefined> {
  return store()
    .prepare(
      `SELECT jr.finished_at, jr.started_at, jr.status, jr.log
         FROM job_runs jr
         JOIN scheduled_jobs sj ON sj.id = jr.job_id
        WHERE sj.kind = 'sync_calendar'
        ORDER BY jr.started_at DESC
        LIMIT 1`,
    )
    .get<SyncRunRow>();
}

/**
 * Disconnect one (owner, provider, account): best-effort revoke at the provider, then
 * hard-delete the connection_tokens row AND any pending outbound_queue rows for it (I12,
 * so a re-connect starts clean). Returns true iff a connection_tokens row was deleted.
 *
 * Revoke is Google-only — it is the sole provider with a revocation endpoint (ci_memory
 * / fixture have none and are simply dropped locally). Revoke is best-effort: a decrypt
 * or network failure is warn-logged (redacted) and never blocks the local delete.
 *
 * The ONE disconnect implementation, behind the ONE disconnect route
 * (DELETE /api/connections/:provider/:account). POST /api/memory/disconnect delegates
 * here too, so a memory connection drops identically however it is dropped.
 */
export async function disconnectConnection(
  ownerId: string,
  provider: string,
  account: string,
): Promise<boolean> {
  if (provider === 'google') {
    // Best-effort revoke using the stored refresh token (decrypted just-in-time).
    const tokRow = await store()
      .prepare(
        'SELECT iv, auth_tag, ciphertext FROM connection_tokens WHERE owner_id = ? AND provider = ? AND account = ?',
      )
      .get<{ iv: string; auth_tag: string; ciphertext: string }>(ownerId, provider, account);
    if (tokRow) {
      try {
        const decoded = JSON.parse(
          open({ iv: tokRow.iv, authTag: tokRow.auth_tag, ciphertext: tokRow.ciphertext }, await loadKek()),
        ) as { refreshToken?: string; accessToken?: string };
        const token = decoded.refreshToken || decoded.accessToken;
        if (token) await revoke(token);
      } catch (err) {
        logger.warn('Could not decrypt token for revoke (continuing)', { err: (err as Error).message });
      }
    }
  }

  const delTokens = await store()
    .prepare('DELETE FROM connection_tokens WHERE owner_id = ? AND provider = ? AND account = ?')
    .run(ownerId, provider, account);
  await store()
    .prepare('DELETE FROM outbound_queue WHERE owner_id = ? AND provider = ? AND account = ?')
    .run(ownerId, provider, account);

  // Memory's display label lives in scheduling_prefs.memory_account, not on the row, so
  // dropping the row must clear it here — otherwise GET /api/memory/status would keep
  // reporting `connected` for a connection that no longer exists. This is what made
  // memory's own disconnect route provider-specific; now every path clears it.
  if (provider === MEMORY_PROVIDER && delTokens.changes > 0) {
    await store()
      .prepare('UPDATE scheduling_prefs SET memory_account = NULL WHERE owner_id = ?')
      .run(ownerId);
  }

  return delTokens.changes > 0;
}
