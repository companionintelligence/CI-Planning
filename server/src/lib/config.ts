import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Parse a positive integer env var, falling back when it's unset, non-numeric, or ≤ 0. */
function positiveIntOr(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Auth mode (Phase I). `test` injects a fixed system owner with no credentials so
 * the existing suite + local dev run unchanged — it is hard-rejected at boot under
 * NODE_ENV=production (fail closed). `standalone` requires a hashed `x-api-key`
 * (public Docker image). `sso` verifies a JWKS-signed Bearer JWT from CI-Portal
 * (the OAuth server at hub.companionintelligence.com; U1). When `DISABLE_OIDC=true`,
 * `sso` mode instead serves a **local username/password** login (U2): a signed,
 * httpOnly session cookie replaces the Bearer JWT. `test`/`standalone` ignore
 * `DISABLE_OIDC` entirely, so dev/CI and the headless Docker image are unaffected.
 */
export type AuthMode = 'test' | 'standalone' | 'sso';

export interface AuthConfig {
  mode: AuthMode;
  jwksUrl?: string;        // DEPRECATED/unused — SSO JWKS comes from CIPORTAL_ISSUER discovery, not this var
  issuer?: string;         // DEPRECATED/unused — expected `iss` comes from the discovered CI-Portal doc, not this var
  audience: string;        // LEGACY/unused — live aud check uses the OIDC client_id, not this value
  contractVersion: string; // RESERVED — populated but NOT asserted; no JWT contract-version check is wired
  autoProvision: boolean;  // first unknown SSO `sub` → provision owner row vs 403
  kekB64?: string;         // 32-byte base64 KEK for the connection-token store (PR4)
  rateLimit: { windowMs: number; max: number; issueMax: number };
  // U2 — local username/password mode (only when mode === 'sso' && disableOidc):
  disableOidc: boolean;    // true ⇒ local login instead of JWKS Bearer verification
  defaultUsername?: string; // seeds the first local owner on boot if none exist
  defaultPassword?: string; // required to seed that owner; boot fails closed without a login path
  sessionSecret?: string;   // Koa app.keys secret signing the local-login session cookie
  resetTokenTtlMs: number;  // V: password-reset token lifetime (default 60 min)
}

/**
 * Outbound email (V — password reset). SMTP via nodemailer when configured; when
 * `host` is unset the mail adapter falls back to a console/JSON transport that LOGS the
 * message instead of sending it, keeping dev + the test suite fully offline (mirrors
 * the GOOGLE_MODE=fixture / AUTH_MODE=test convenience). `appBaseUrl` is the base the
 * reset link is built against (defaults to PUBLIC_BASE_URL).
 */
export interface MailConfig {
  host?: string;
  port: number;
  secure: boolean;      // true ⇒ implicit TLS (465); false ⇒ STARTTLS/plain (587/25)
  user?: string;
  pass?: string;
  from: string;         // From: header
  appBaseUrl: string;   // base URL for reset links (${appBaseUrl}/reset-password?token=…)
}

/**
 * Google connector config (Wave 0). The SINGLE source of truth for OAuth endpoints,
 * scopes, MCP transport, and live/fixture/off mode — later WPs consume this block; they
 * do NOT re-derive these values from env. `mode: 'off'` (the default) means no Google
 * integration at all; `fixture` is an explicit dev/demo opt-in that serves committed
 * sample data; `live` is the real per-owner OAuth connector.
 */
export interface GoogleConfig {
  clientId?: string;
  clientSecret?: string;
  authUri: string;
  tokenUri: string;
  revokeUri: string;
  redirectUri: string;
  publicBaseUrl: string;
  scopes: { gmail: string[]; calendar: string[] };
  /** When true, /start requests the Gmail scope in addition to Calendar. */
  enableGmail: boolean;
  mcp: { command: string; timeoutMs: number; retries: number };
  mode: 'live' | 'fixture' | 'off';
  /** True when GOOGLE_MODE was set explicitly in the environment — env is then
   *  authoritative and the in-app (app_config) Google setup is read-only. */
  envPinned: boolean;
}

/**
 * CI-Portal OIDC consumer config (U1). Companion Planning is an OAuth 2.1 + PKCE
 * Relying Party of CI-Portal (hub.companionintelligence.com, reachable over
 * Tailscale) — the same consumer role CI-Import Tools and CI-Hub play. Endpoint
 * values come from CI-Portal's discovery document
 * (`/.well-known/openid-configuration`) or the CI-Portal team; there are NO
 * invented defaults — a deployment must set them explicitly. Deliberately separate
 * from the older generic AUTH_JWKS_URL/AUTH_ISSUER vars (kept for now; repoint or
 * retire is the dev team's call — flagged in docs, not silently decided here).
 */
export interface CiPortalConfig {
  // Discovery-driven (matches CI-Import-Tools, the sibling consumer): the only
  // required config is `issuer` + `clientId`; the authorize/token/jwks endpoints and
  // the expected token `iss` are read from `<issuer>/.well-known/openid-configuration`
  // at runtime. NOTE (better-auth): CI-Portal serves discovery at `…/api/auth` but the
  // id_token `iss` claim is the BARE ORIGIN — so `issuer` here is the discovery URL,
  // and the callback validates `iss` against the discovery doc's `issuer`, never this
  // string. (See routes/auth.ts + lib/auth/oidcDiscovery.ts.)
  issuer?: string;
  clientId?: string;      // our registered client id at CI-Portal (public PKCE)
  clientSecret?: string;  // only if CI-Portal registers us as a confidential client
  redirectUri: string;
  /** AA0b — the memory connector's OAuth callback (offline_access refresh flow). */
  memoryRedirectUri: string;
  scopes: string;
  // Optional endpoint overrides — normally left unset (discovered). Set to bypass
  // discovery (air-gapped deploys, or a provider without a discovery document).
  authorizeUri?: string;
  tokenUri?: string;
  jwksUri?: string;
}

/** GraphQL surface (Phase W). Additive to REST; mounted at /api/graphql. */
export interface GraphqlConfig {
  /** Reject a query whose estimated cost exceeds this (the ComplexityPlugin analog). */
  maxComplexity: number;
}

/** Sync engine toggles (Wave 0). */
export interface SyncConfig {
  /** When false, the sync layer never pushes local changes back to providers. */
  writeback: boolean;
  /** Master kill switch: when true, syncAll/syncConnector no-op and outbound queueing/deletes are skipped. */
  disabled: boolean;
}

/** Key-encryption-key versioning (Wave 0) — drives crypto.loadKek/rotateKek. */
export interface KekConfig {
  /** The version a fresh seal() writes; loadKek() with no arg returns this key. */
  currentVersion: number;
}

export interface Config {
  port: number;
  // Behind a trusted reverse proxy / TLS terminator (e.g. CI-Hub's tunnel)? Enables Koa
  // app.proxy so ctx.protocol honors X-Forwarded-Proto (⇒ Secure cookies over external
  // HTTPS) and ctx.ip is the real client IP (⇒ correct per-IP login rate-limiting).
  // Default false — safe when the app is directly reachable (don't trust spoofable XFF).
  trustProxy: boolean;
  dbPath: string;
  ollamaUrl: string;
  ollamaSmallModel: string;
  ollamaMediumModel: string;
  ollamaEmbedModel: string;
  staticDir: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  /** True when BOTH VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set — env pins the keypair
   *  and the auto-generation in services/vapid-config.ts is a no-op. */
  vapidEnvPinned: boolean;
  snapshotRetain: number;
  auth: AuthConfig;
  ciportal: CiPortalConfig;
  mail: MailConfig;
  graphql: GraphqlConfig;
  google: GoogleConfig;
  sync: SyncConfig;
  kek: KekConfig;
}

// Default data dir (used only when DB_PATH is not set, e.g. local dev on macOS).
const defaultDataDir = join(homedir(), 'Library', 'Application Support', 'CompanionPlanning');

// Resolve relative to this file: server/src/lib/config.ts → server/public
const _dir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(_dir, '..', '..'); // server/src/lib → server/src → server

const dbPath = process.env.DB_PATH ?? join(defaultDataDir, 'companion.db');
// Ensure the directory containing the DB exists (better-sqlite3 won't create it).
mkdirSync(dirname(dbPath), { recursive: true });

// Derived once so the redirect-uri default can reference it.
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3848';
// Fail-closed default: unset (or unrecognized) GOOGLE_MODE means NO Google integration.
// Fixture mode — canned sample emails/events — must be an explicit opt-in, never a
// default a real deployment can hit by omission. When GOOGLE_MODE is unset, an
// operator-saved in-app Google client (app_config, hydrated after boot by
// services/google-config.ts) may flip the mode to 'live' at runtime; an explicit env
// value pins the mode and makes the in-app setup read-only.
const googleEnvPinned = process.env.GOOGLE_MODE === 'live' || process.env.GOOGLE_MODE === 'fixture';
const googleMode: 'live' | 'fixture' | 'off' =
  process.env.GOOGLE_MODE === 'live' ? 'live'
  : process.env.GOOGLE_MODE === 'fixture' ? 'fixture'
  : 'off';

export const config: Config = {
  port: Number(process.env.PORT ?? 3848),
  trustProxy: process.env.TRUST_PROXY === 'true',
  dbPath,
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  // Defaults are real, currently-pullable Ollama tags. They are only a fallback:
  // set OLLAMA_SMALL/MEDIUM/EMBED in server/.env to any model from `ollama list`.
  // If a configured model isn't pulled, generate/embed throw an actionable error.
  ollamaSmallModel: process.env.OLLAMA_SMALL ?? 'qwen2.5:0.5b',
  ollamaMediumModel: process.env.OLLAMA_MEDIUM ?? 'gemma3n:e4b',
  ollamaEmbedModel: process.env.OLLAMA_EMBED ?? 'nomic-embed-text',
  staticDir: join(packageRoot, 'public'),
  // Web Push (Phase H). Keys are AUTO-GENERATED on first boot and persisted to app_config
  // (services/vapid-config.ts hydrates them into this singleton after migrations), so push
  // works out of the box — no manual `npx web-push generate-vapid-keys` needed. Setting
  // BOTH env vars pins an explicit keypair and takes precedence. Never commit real keys.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@companion.local',
  vapidEnvPinned: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  snapshotRetain: Number(process.env.SNAPSHOT_RETAIN ?? 7),
  auth: {
    mode: (process.env.AUTH_MODE as AuthMode) ?? 'test',
    jwksUrl: process.env.AUTH_JWKS_URL,
    issuer: process.env.AUTH_ISSUER,
    audience: process.env.AUTH_AUDIENCE ?? 'companion-planning',
    contractVersion: process.env.AUTH_CONTRACT_VERSION ?? '1',
    autoProvision: process.env.AUTH_AUTO_PROVISION === 'true',
    kekB64: process.env.CP_KEK_B64,
    rateLimit: {
      windowMs: Number(process.env.AUTH_RATE_WINDOW_MS ?? 60_000),
      max: Number(process.env.AUTH_RATE_MAX ?? 60),
      issueMax: Number(process.env.AUTH_RATE_ISSUE_MAX ?? 5),
    },
    disableOidc: process.env.DISABLE_OIDC === 'true',
    defaultUsername: process.env.AUTH_DEFAULT_USERNAME,
    defaultPassword: process.env.AUTH_DEFAULT_PASSWORD,
    sessionSecret: process.env.SESSION_SECRET,
    resetTokenTtlMs: Number(process.env.AUTH_RESET_TOKEN_TTL_MS ?? 3_600_000), // 60 min
  },
  ciportal: {
    // Real CI-Portal discovery issuer (confirmed against CI-Import-Tools). Overridable
    // for the fixture portal / other providers. The token `iss` claim is validated
    // against the DISCOVERED doc's issuer, not this URL (see the interface note).
    issuer: process.env.CIPORTAL_ISSUER ?? 'https://hub.companionintelligence.com/api/auth',
    clientId: process.env.CIPORTAL_CLIENT_ID, // must be registered with CI-Portal; no default
    clientSecret: process.env.CIPORTAL_CLIENT_SECRET,
    redirectUri: process.env.CIPORTAL_REDIRECT_URI ?? `${publicBaseUrl}/api/auth/ciportal/callback`,
    // AA0b — the memory connector's OWN callback (distinct from the login redirect;
    // both must be registered with CI-Portal). The connector flow requests
    // `offline_access` so it gets a refresh token to self-refresh its CI-Server bearer.
    memoryRedirectUri:
      process.env.CIPORTAL_MEMORY_REDIRECT_URI ?? `${publicBaseUrl}/api/memory/ciportal/callback`,
    scopes: process.env.CIPORTAL_SCOPES ?? 'openid profile email',
    // Optional overrides — normally discovered from the issuer.
    authorizeUri: process.env.CIPORTAL_AUTHORIZE_URI,
    tokenUri: process.env.CIPORTAL_TOKEN_URI,
    jwksUri: process.env.CIPORTAL_JWKS_URI,
  },
  mail: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.MAIL_FROM ?? 'Companion Planning <no-reply@companion.local>',
    appBaseUrl: process.env.APP_BASE_URL ?? publicBaseUrl,
  },
  graphql: {
    // Guard against a non-numeric / non-positive override: a NaN limit would make
    // `complexity > NaN` always false and silently disable the limiter.
    maxComplexity: positiveIntOr(process.env.GRAPHQL_MAX_COMPLEXITY, 1000),
  },
  google: {
    clientId: process.env.CP_GOOGLE_CLIENT_ID,
    clientSecret: process.env.CP_GOOGLE_CLIENT_SECRET,
    // Real Google endpoints, but env-overridable so tests can point them at a stub.
    authUri: process.env.CP_GOOGLE_AUTH_URI ?? 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUri: process.env.CP_GOOGLE_TOKEN_URI ?? 'https://oauth2.googleapis.com/token',
    revokeUri: process.env.CP_GOOGLE_REVOKE_URI ?? 'https://oauth2.googleapis.com/revoke',
    redirectUri: process.env.CP_OAUTH_REDIRECT_URI ?? `${publicBaseUrl}/api/oauth/google/callback`,
    publicBaseUrl,
    scopes: {
      gmail: ['https://www.googleapis.com/auth/gmail.readonly'],
      calendar: ['https://www.googleapis.com/auth/calendar.events'],
    },
    // Gmail is a restricted scope (OAuth verification + CASA), so it's opt-in and
    // gated separately from the calendar loop. Lives in the config singleton (not a
    // raw process.env read in oauth.ts) so WP8's Gmail go-live consumes one flag.
    enableGmail: process.env.CP_GOOGLE_ENABLE_GMAIL === 'true',
    mcp: {
      // Default to the BUNDLED Calendar MCP server (README §google-cloud-setup §7) so a
      // live connection works out of the box — previously the empty default meant an
      // OAuth-connected account whose every sync failed with McpUnavailable until the
      // operator discovered CP_MCP_COMMAND. Relative to the server package dir (the
      // Dockerfile WORKDIR, the launchd WorkingDirectory, and `pnpm --filter server`
      // all run there). Only consulted in live mode.
      command: process.env.CP_MCP_COMMAND ?? 'node_modules/.bin/tsx src/scripts/mcp-google-server.ts',
      timeoutMs: Number(process.env.CP_MCP_TIMEOUT_MS ?? 30_000),
      retries: Number(process.env.CP_MCP_RETRIES ?? 3),
    },
    mode: googleMode,
    envPinned: googleEnvPinned,
  },
  sync: {
    // Outbound write-back is OFF by default — pull-only is the safe posture (Phase J).
    writeback: process.env.CP_SYNC_WRITEBACK === 'true',
    disabled: process.env.CP_SYNC_DISABLED === 'true',
  },
  kek: {
    currentVersion: Number(process.env.CP_KEK_VERSION ?? 1),
  },
};

// Fail closed: the credential-free `test` owner path must never run in production.
// A misconfigured prod image is a silent auth bypass, so refuse to boot instead.
if (config.auth.mode === 'test' && process.env.NODE_ENV === 'production') {
  throw new Error(
    'AUTH_MODE=test is forbidden in production — set AUTH_MODE=standalone or sso',
  );
}

// Fail closed (U2, widened in U1): BOTH sso sub-modes — CI-Portal SSO and the
// DISABLE_OIDC local fallback — end a login by minting the signed session cookie, so
// AUTH_MODE=sso always requires SESSION_SECRET. Without it, ctx.cookies.set(…, {
// signed: true }) throws at request time — refuse to boot instead of serving an
// unsigned/forgeable session. The companion "no login path" guard (no default
// password + zero local users) is DB-dependent and lives in ensureLocalAuthBootstrap().
if (config.auth.mode === 'sso' && !config.auth.sessionSecret) {
  throw new Error(
    'AUTH_MODE=sso requires SESSION_SECRET (signs the login session cookie)',
  );
}

// Fail closed (U1): production SSO with OIDC enabled but no CI-Portal wiring would
// present a login screen whose only button dead-ends. The endpoints are now DISCOVERED
// from the issuer, so we only require issuer + client_id up front (issuer has a real
// default; client_id must be registered). Non-production is exempt so dev/fixture flows
// can wire it at runtime.
if (
  config.auth.mode === 'sso' &&
  !config.auth.disableOidc &&
  process.env.NODE_ENV === 'production' &&
  (!config.ciportal.clientId || !config.ciportal.issuer)
) {
  throw new Error(
    'AUTH_MODE=sso (OIDC enabled) requires CIPORTAL_CLIENT_ID (registered with CI-Portal) and CIPORTAL_ISSUER ' +
      '(defaults to https://hub.companionintelligence.com/api/auth; endpoints are discovered from it) ' +
      '— or set DISABLE_OIDC=true for local username/password login',
  );
}

// Fail fast (U1): the CIPORTAL_*_URI endpoint overrides are all-or-nothing — set all
// three to bypass discovery, or none to use it. A PARTIAL set is almost always a typo
// that would silently fall back to discovery (ignoring the vars that were set), so
// refuse to boot with a clear message instead.
{
  const overridesSet = [
    config.ciportal.authorizeUri,
    config.ciportal.tokenUri,
    config.ciportal.jwksUri,
  ].filter(Boolean).length;
  if (overridesSet > 0 && overridesSet < 3) {
    throw new Error(
      'CIPORTAL_AUTHORIZE_URI, CIPORTAL_TOKEN_URI and CIPORTAL_JWKS_URI are all-or-nothing: set all three to ' +
        'override discovery, or leave all unset to discover from CIPORTAL_ISSUER — not a partial subset.',
    );
  }
}

// Warn (don't fail): a production local-login deployment with no SMTP can't actually
// deliver password-reset links — the mail adapter falls back to logging them, which is
// useless to a remote user. Reset is optional infrastructure, so this is a warning, not a
// boot guard. console.warn (not the logger) to avoid an import cycle this early.
if (
  config.auth.mode === 'sso' &&
  config.auth.disableOidc &&
  process.env.NODE_ENV === 'production' &&
  !config.mail.host
) {
  console.warn(
    '[config] Local login is enabled but SMTP is not configured (SMTP_HOST unset) — ' +
      'password-reset emails will be logged, not sent. Set SMTP_* + MAIL_FROM to enable delivery.',
  );
}

// Fail closed: fixture mode serves committed sample emails/events as if they were the
// user's own data. In production that is fake data leaking into a real task list, so
// refuse to boot unless the operator explicitly accepts it (CP_ALLOW_FIXTURE=true).
if (
  config.google.mode === 'fixture' &&
  process.env.NODE_ENV === 'production' &&
  process.env.CP_ALLOW_FIXTURE !== 'true'
) {
  throw new Error(
    'GOOGLE_MODE=fixture is forbidden in production — it ingests committed sample data as real tasks. ' +
      'Set GOOGLE_MODE=live (with OAuth credentials), unset it to disable Google integration, ' +
      'or set CP_ALLOW_FIXTURE=true to explicitly allow fixtures (demo appliances only).',
  );
}

// Fail closed (Wave 0): GOOGLE_MODE=live without OAuth credentials would silently fall
// back to broken auth flows. Require the client id + redirect uri up front. These guards
// never fire under the test harness (test env sets GOOGLE_MODE=fixture explicitly).
if (config.google.mode === 'live' && (!config.google.clientId || !config.google.redirectUri)) {
  throw new Error(
    'GOOGLE_MODE=live requires CP_GOOGLE_CLIENT_ID and a redirect URI (CP_OAUTH_REDIRECT_URI or PUBLIC_BASE_URL)',
  );
}

// A live Google connector behind the credential-free `test` owner in production is the
// same silent-bypass hazard as the AUTH_MODE guard above — refuse to boot.
if (
  config.google.mode === 'live' &&
  config.auth.mode === 'test' &&
  process.env.NODE_ENV === 'production'
) {
  throw new Error(
    'GOOGLE_MODE=live with AUTH_MODE=test is forbidden in production — set AUTH_MODE=standalone or sso',
  );
}
