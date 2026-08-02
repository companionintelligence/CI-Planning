import { config } from '../config.js';
import { logger } from '../logger.js';
import { hashPassword, localOwnerCount } from './password.js';
import { provisionOwner } from '../owners.js';

/**
 * Local-auth boot bootstrap (U2). Runs once at startup, only in local-login mode
 * (`AUTH_MODE=sso && DISABLE_OIDC=true`); a no-op in every other mode, so dev/CI and
 * the headless Docker image are untouched.
 *
 * If no local owner exists yet:
 *   - `AUTH_DEFAULT_PASSWORD` set  → seed one (`AUTH_DEFAULT_USERNAME`, default 'admin').
 *   - otherwise                    → **throw** (fail closed): booting local mode with no
 *     way to ever log in is a worse footgun than not starting, matching the existing
 *     AUTH_MODE/GOOGLE_MODE boot guards in config.ts. (SESSION_SECRET is guarded there.)
 *
 * Idempotent: once a local owner exists, does nothing (a restart never reseeds, and
 * changing AUTH_DEFAULT_PASSWORD later does not rewrite an existing owner's hash).
 */
export async function ensureLocalAuthBootstrap(): Promise<void> {
  if (!(config.auth.mode === 'sso' && config.auth.disableOidc)) return;

  if ((await localOwnerCount()) > 0) return;

  if (!config.auth.defaultPassword) {
    throw new Error(
      'DISABLE_OIDC=true with no local owners and no AUTH_DEFAULT_PASSWORD — there is no way to log in. ' +
        'Set AUTH_DEFAULT_USERNAME + AUTH_DEFAULT_PASSWORD to seed the first owner.',
    );
  }

  const username = config.auth.defaultUsername ?? 'admin';
  const passwordHash = await hashPassword(config.auth.defaultPassword);
  // The founding admin (Phase AG): the first seeded owner is the operator — every
  // later account is created BY an operator via /api/accounts and defaults to member.
  provisionOwner({ name: username, username, passwordHash, role: 'operator' });
  logger.info(`Seeded default local owner '${username}' (AUTH_DEFAULT_USERNAME). Change its password after first login.`);
}
