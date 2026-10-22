import { config } from '../config.js';
import { logger } from '../logger.js';
import { hashPassword, localOwnerCount } from './password.js';
import { provisionOwner } from '../owners.js';

/**
 * Local-auth boot bootstrap (U2, extended by A3). Runs once at startup in `sso` mode —
 * BOTH sub-modes — and is a no-op in `test`/`standalone`, so dev/CI and the headless
 * Docker image are untouched.
 *
 * If no local owner (username + password) exists yet:
 *   - `AUTH_DEFAULT_PASSWORD` set  → seed one (`AUTH_DEFAULT_USERNAME`, default 'admin')
 *     as the **operator**. Under DISABLE_OIDC this is the install's only login; under
 *     OIDC it is the **break-glass** operator — a local account that can still sign in
 *     (POST /api/auth/login) and manage accounts if the portal is unreachable or the
 *     portal-claimed operator is gone. CI-Hub's marketplace install supplies the pair
 *     either way.
 *   - otherwise, under DISABLE_OIDC → **throw** (fail closed): booting local mode with no
 *     way to ever log in is a worse footgun than not starting, matching the
 *     AUTH_MODE/GOOGLE_MODE boot guards in config.ts. (SESSION_SECRET is guarded there.)
 *   - otherwise, under OIDC → nothing: the portal is the login path, and the first portal
 *     login claims the operator role (routes/auth.ts, provisionOwner's
 *     `claimOperatorIfNone`).
 *
 * Idempotent: once a local owner exists, does nothing (a restart never reseeds, and
 * changing AUTH_DEFAULT_PASSWORD later does not rewrite an existing owner's hash).
 */
export async function ensureLocalAuthBootstrap(): Promise<void> {
  if (config.auth.mode !== 'sso') return;

  if ((await localOwnerCount()) > 0) return;

  if (!config.auth.defaultPassword) {
    if (config.auth.disableOidc) {
      throw new Error(
        'DISABLE_OIDC=true with no local owners and no AUTH_DEFAULT_PASSWORD — there is no way to log in. ' +
          'Set AUTH_DEFAULT_USERNAME + AUTH_DEFAULT_PASSWORD to seed the first owner.',
      );
    }
    logger.info('No local owners and no AUTH_DEFAULT_PASSWORD — Companion Portal is the login path; the first portal login becomes the operator.');
    return;
  }

  const username = config.auth.defaultUsername ?? 'admin';
  const passwordHash = await hashPassword(config.auth.defaultPassword);
  // The founding admin (Phase AG): the first seeded owner is the operator — every
  // later account is created BY an operator via /api/accounts and defaults to member.
  // Explicit role, so this never depends on the A3 claim and always wins over a portal
  // login that races boot.
  await provisionOwner({ name: username, username, passwordHash, role: 'operator' });
  logger.info(
    config.auth.disableOidc
      ? `Seeded default local owner '${username}' (AUTH_DEFAULT_USERNAME). Change its password after first login.`
      : `Seeded break-glass local operator '${username}' (AUTH_DEFAULT_USERNAME) alongside Companion Portal login. Change its password after first login.`,
  );
}
