import { randomBytes, createHash } from 'node:crypto';
import { store } from '../../db/store.js';
import { newId } from '../ids.js';

/**
 * Invite codes for local self-serve sign-up (B2, `AUTH_SIGNUP=invite`) — the
 * `signup_codes` table (0172). An operator mints one in Settings → Accounts and hands
 * it to the person out-of-band; the person creates their OWN account (and password)
 * at /signup with it. Companion Memory's `signup_code` model, kept compatible with the
 * 2026-07-12 ruling that an operator never touches anyone's password.
 *
 * Hashed at rest like reset tokens (lib/auth/resetToken.ts): the raw code is returned
 * from {@link issueSignupCode} exactly once. Codes are single-use: the claim is ONE
 * guarded UPDATE (`WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now`),
 * so two sign-ups racing on the same code can only ever mint one account. Because
 * `provisionOwner` opens its own transaction (and the SQLite store cannot nest them),
 * the sign-up route claims FIRST and {@link releaseSignupCode}s on a provisioning
 * failure — the claim, not the insert, is what makes "consumed once" hold.
 */

/** Operator-facing shape. Never carries the raw code or its hash. */
export interface SignupCodeRecord {
  id: string;
  note: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  /** Display name of the account that used it (null when unused or since deleted). */
  usedByName: string | null;
  revokedAt: string | null;
  /** Derived for the UI: exactly one of these, in precedence order. */
  status: 'active' | 'used' | 'revoked' | 'expired';
}

export const SIGNUP_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // an invite waits in an inbox (matches invite links)

// Human-typeable alphabet — no 0/O, 1/I/L — 32 symbols ⇒ 5 bits each. 12 symbols = 60
// bits of entropy, rendered XXXX-XXXX-XXXX. Normalisation on input (upper-case, strip
// separators) means a code read over the phone survives the transcription.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;

function generateRawCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}`;
}

/** Canonical form of a user-supplied code: upper-case, separators stripped. */
export function normalizeSignupCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashCode(raw: string): string {
  return createHash('sha256').update(normalizeSignupCode(raw)).digest('hex');
}

const nowIso = () => new Date().toISOString();

/**
 * Mint a code. Returns the RAW code (show it to the operator once) and the record.
 * Opportunistically prunes rows nobody can ever use again — expired-and-unused ones
 * older than a day — so the table stays a short list rather than a ledger.
 */
export async function issueSignupCode(opts: { createdBy: string; note?: string | null }): Promise<{ code: string; record: SignupCodeRecord }> {
  const raw = generateRawCode();
  const id = newId();
  const now = Date.now();
  await store()
    .prepare(`DELETE FROM signup_codes WHERE used_at IS NULL AND expires_at <= ?`)
    .run(new Date(now - 24 * 60 * 60 * 1000).toISOString());
  await store()
    .prepare(
      `INSERT INTO signup_codes (id, code_hash, note, created_by, expires_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, hashCode(raw), opts.note?.trim() || null, opts.createdBy, new Date(now + SIGNUP_CODE_TTL_MS).toISOString());
  const record = (await getSignupCode(id))!;
  return { code: raw, record };
}

interface Row {
  id: string; note: string | null; created_at: string; expires_at: string;
  used_at: string | null; used_by_name: string | null; revoked_at: string | null;
}

function toRecord(r: Row): SignupCodeRecord {
  const status: SignupCodeRecord['status'] = r.used_at
    ? 'used'
    : r.revoked_at
      ? 'revoked'
      : new Date(r.expires_at) <= new Date()
        ? 'expired'
        : 'active';
  return {
    id: r.id, note: r.note, createdAt: r.created_at, expiresAt: r.expires_at,
    usedAt: r.used_at, usedByName: r.used_by_name, revokedAt: r.revoked_at, status,
  };
}

const SELECT = `SELECT c.id, c.note, c.created_at, c.expires_at, c.used_at, c.revoked_at,
                       o.name AS used_by_name
                  FROM signup_codes c LEFT JOIN owners o ON o.id = c.used_by`;

export async function getSignupCode(id: string): Promise<SignupCodeRecord | undefined> {
  const r = await store().prepare(`${SELECT} WHERE c.id = ?`).get<Row>(id);
  return r ? toRecord(r) : undefined;
}

/** Every code, newest first (ids are UUIDv7, so id order is creation order). */
export async function listSignupCodes(): Promise<SignupCodeRecord[]> {
  const rows = await store().prepare(`${SELECT} ORDER BY c.id DESC`).all<Row>();
  return rows.map(toRecord);
}

/** Withdraw a code. Idempotent; false when the id is unknown. */
export async function revokeSignupCode(id: string): Promise<boolean> {
  const res = await store()
    .prepare(`UPDATE signup_codes SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?`)
    .run(nowIso(), id);
  return res.changes > 0;
}

/**
 * Atomically claim a code for a sign-up in progress. Returns the row id on success,
 * or null when the code is unknown, already used, revoked, or expired — one answer for
 * all four, so the response can't be used to probe which codes exist. The caller must
 * {@link releaseSignupCode} the id if the account it was claimed for is never created.
 */
export async function claimSignupCode(raw: string): Promise<string | null> {
  const row = await store()
    .prepare(
      `UPDATE signup_codes SET used_at = ?
         WHERE code_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
         RETURNING id`,
    )
    .get<{ id: string }>(nowIso(), hashCode(raw), nowIso());
  return row?.id ?? null;
}

/** Bind a claimed code to the account it created (audit: who used it). */
export async function bindSignupCode(id: string, ownerId: string): Promise<void> {
  await store().prepare(`UPDATE signup_codes SET used_by = ? WHERE id = ?`).run(ownerId, id);
}

/** Undo a claim whose sign-up failed after the claim (e.g. the username was taken). */
export async function releaseSignupCode(id: string): Promise<void> {
  await store().prepare(`UPDATE signup_codes SET used_at = NULL, used_by = NULL WHERE id = ?`).run(id);
}
