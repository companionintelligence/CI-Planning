import { hash, hashSync, verify, Algorithm } from '@node-rs/argon2';
import { sqlite } from '../../db/index.js';
import { SYSTEM_OWNER_ID } from '../ids.js';

/**
 * Local-login password hashing (U2). Argon2**id** per I-identity-auth.md's explicit
 * guidance ("if local passwords are kept at all… use argon2id; do not introduce
 * bcrypt"). We use `@node-rs/argon2` (prebuilt NAPI binaries) rather than the
 * node-gyp `argon2` package — same algorithm, but no compiler toolchain at install,
 * which matters given this repo's native-build constraints (see the better-sqlite3
 * build allow-list in pnpm-workspace.yaml).
 *
 * Scope note: the login LOGIC here only *runs* under `mode === 'sso' && disableOidc`
 * (requireAuth dispatch + the /api/auth/login handler gate on it). But the MODULE is
 * imported unconditionally — routes/auth.ts (mounted for every mode via mountRoutes)
 * and localBootstrap.ts both import it — so importing it loads the `@node-rs/argon2`
 * native binary AND computes the decoy hash below at boot in EVERY mode, including
 * test/standalone. That's deliberate operational coupling: a platform without a
 * working argon2 binary fails at startup regardless of AUTH_MODE (@node-rs ships
 * prebuilts for the supported targets; CI runs on Node 22 with them). Don't assume
 * non-local deployments skip this file.
 */

// argon2id with library defaults (m=19MiB, t=2, p=1 in @node-rs/argon2 v2) — OWASP-
// aligned and encoded self-describingly in the `$argon2id$…` string, so a later
// parameter bump verifies old hashes transparently.
const OPTS = { algorithm: Algorithm.Argon2id } as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  // @node-rs/argon2 throws on a malformed hash string; treat that as "no match"
  // rather than a 500 — a corrupt/rogue password_hash must fail closed, not crash.
  return verify(hashed, plain).catch(() => false);
}

// A fixed, valid argon2id hash (of a value nothing hashes to) used as constant-work
// decoy. Computed once at load via hashSync so login can always run exactly one
// verify — see verifyLoginPassword. hashSync is fine here: one ~12ms op at startup.
const DECOY_HASH = hashSync('cp-local-login-decoy-never-a-real-password', OPTS);

/**
 * Verify a login attempt in constant work. ALWAYS runs exactly one argon2id verify —
 * against the owner's real hash, or the decoy when the owner is unknown or is
 * OIDC-only (`passwordHash` null) — so response timing can't reveal whether a
 * username exists (enumeration-oracle mitigation). Returns true only on a genuine
 * match against a real, non-null hash.
 */
export async function verifyLoginPassword(
  passwordHash: string | null | undefined,
  plain: string,
): Promise<boolean> {
  const ok = await verifyPassword(passwordHash ?? DECOY_HASH, plain);
  return passwordHash != null && ok;
}

export interface LocalOwnerRow {
  id: string;
  password_hash: string | null;
}

/**
 * Resolve a username to its owner for local login. **Excludes the SYSTEM_OWNER
 * sentinel** (N-SENTINEL, U0): the sentinel's auth columns are NULL, so it could
 * never match a real username here — but excluding it explicitly is a hard guard so
 * no future change (or a row hand-seeded with the sentinel id) can let an external
 * login take over the single-owner dev/test identity. Returns undefined if unknown.
 */
export function findOwnerByUsername(username: string): LocalOwnerRow | undefined {
  return sqlite
    .prepare(
      `SELECT id, password_hash FROM owners WHERE username = ? AND id <> ? LIMIT 1`,
    )
    .get(username, SYSTEM_OWNER_ID) as LocalOwnerRow | undefined;
}

/**
 * Count owners who can ACTUALLY log in locally — both `username` AND `password_hash`
 * set — excluding the sentinel. This drives the boot seeding/fail-closed decision, so
 * it must match verifyLoginPassword's precondition exactly: a row with a username but a
 * NULL password_hash can never authenticate (verify always fails against the decoy), so
 * counting it as a "local owner" would let the boot guard skip seeding AND skip failing
 * closed, leaving no usable login path. Count only genuinely-usable accounts.
 */
export function localOwnerCount(): number {
  return (
    sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM owners
           WHERE username IS NOT NULL AND password_hash IS NOT NULL AND id <> ?`,
      )
      .get(SYSTEM_OWNER_ID) as { n: number }
  ).n;
}
