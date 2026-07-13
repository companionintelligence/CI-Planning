/**
 * The identity a credential resolves to, regardless of which path verified it
 * (hashed `x-api-key` in standalone mode; the signed httpOnly session cookie in sso
 * mode — both CI-Portal SSO and local login). Every downstream handler reads the
 * owner via `currentOwnerId()` (lib/context.ts); `requireAuth` is the only place that
 * turns a credential into one of these.
 *
 * CON-1: `ownerId` is a TEXT UUIDv7 (owners.id), never an integer.
 */
export interface VerifiedClaims {
  ownerId: string;
  scopes: string[];
}

/** Read access — every GET/HEAD on the API surface. */
export const SCOPE_READ = 'planning:read';
/** Mutating access — POST/PUT/PATCH/DELETE. Implies read. */
export const SCOPE_WRITE = 'planning:write';
/**
 * Admin access — system-global maintenance surfaces that are NOT owner-scoped
 * (Phase W · W12: the `scheduled_jobs`/`job_runs` operator tables, exposed by the REST
 * `/api/jobs` route + the GraphQL `scheduledJobs`/`runScheduledJob` resolvers; Phase
 * AG adds `/api/google-config` and `/api/accounts`). NOT implied by write: a normal
 * owner mutating their own data does not, by that alone, get to run/inspect the
 * instance's system surfaces. Since Phase AG a session's scopes are derived from
 * `owners.role` (roleToScopes in scopes.ts) — only an `operator` session carries
 * admin; an API key gets admin ONLY if it was explicitly issued with it.
 */
export const SCOPE_ADMIN = 'planning:admin';
