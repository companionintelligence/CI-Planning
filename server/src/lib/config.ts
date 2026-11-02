import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
 * (the OAuth server at hub.ci.computer; U1). When `DISABLE_OIDC=true`,
 * `sso` mode instead serves a **local username/password** login (U2): a signed,
 * httpOnly session cookie replaces the Bearer JWT. `test`/`standalone` ignore
 * `DISABLE_OIDC` entirely, so dev/CI and the headless Docker image are unaffected.
 */
export type AuthMode = 'test' | 'standalone' | 'sso';

/**
 * A connector whose transport is env-selected. `envPinned` = the env named the mode
 * explicitly, so any in-app override is read-only.
 *
 * One shape for every such connector: Google and the CI-Server memory connector had
 * identical value sets behind two different mechanisms (a boot-read field vs a
 * per-call function in connectors/memory.ts), which is why MEMORY_MODE used to be
 * read in two files. It is read here and only here now.
 */
export type ConnectorMode = 'live' | 'fixture' | 'off';
export interface ModeConfig {
  mode: ConnectorMode;
  envPinned: boolean;
}

/**
 * CI-Server memory connector (Phase AA). `mode` and `serverUrl` are GETTERS, not
 * captured values: connectors/memory.ts re-reads the transport mode on every call
 * (its header documents why — the suite toggles MEMORY_MODE / CI_SERVER_URL mid-run
 * and expects the next call to observe it), so the lazy read moves here rather than
 * justifying a second env-reading mechanism. Google is deliberately the opposite:
 * boot-pinned, because services/google-config.ts hot-applies an in-app mode by
 * mutating the singleton and a getter would silently overwrite that.
 */
export interface MemoryConfig extends ModeConfig {
  /** CI_SERVER_URL — the memory API base. Serves double duty: the single-tenant
   *  env-fallback creds base (connectors/memory.ts) and a hard requirement of the
   *  CI-Portal connect flow (routes/memory.ts, 503 when unset). */
  serverUrl?: string;
}

/**
 * PIN, sense 1 of 3 — the OPERATOR ENV PIN: "what did the operator fix by hand,
 * instead of letting the app decide?". One object, so that question has one answer.
 * Replaced three shapes in three placements (`ollamaPinned`, `google.envPinned`,
 * `vapidEnvPinned`) that all expressed this one idea.
 *
 * The two unrelated `pin` nouns in this codebase, for the reader who greps:
 *  - `calibration_combo_pins` — a USER-pinned tag-combo estimate scope
 *    (services/calibration.ts, client/src/components/CalibrationPins.tsx).
 *  - a plan PIN — a task start time locked by an NL instruction (agents/plan.ts
 *    `PlanPin`).
 * See the "pin" entry in ARCHITECTURE.md §Glossary.
 */
export interface PinConfig {
  /** Which model tiers env named explicitly (OLLAMA_FAST/QUALITY/EMBED, plus the
   *  OLLAMA_SMALL/MEDIUM aliases). A pinned tier is used verbatim; an unpinned one
   *  falls back to auto-selection from what's installed (lib/models.ts). */
  ollama: { fast: boolean; quality: boolean; embed: boolean };
  /** GOOGLE_MODE named the mode explicitly ⇒ the in-app Google setup is read-only.
   *  A read-only mirror: `config.google.envPinned` is the storage, because
   *  services/google-config.ts and its tests own that sub-config. */
  readonly google: boolean;
  /** BOTH VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are set ⇒ env pins the keypair and
   *  the auto-generation in services/vapid-config.ts is a no-op. */
  vapid: boolean;
}

// RETIRED (see the CIPORTAL_* set): AUTH_JWKS_URL, AUTH_ISSUER, AUTH_AUDIENCE and
// AUTH_CONTRACT_VERSION were parsed into this object but read by NO code path — the JWKS
// endpoint and the expected `iss` both come from CI-Portal discovery, and the live `aud`
// check uses the OIDC client_id. Four config fields that look like security controls but
// enforce nothing are worse than absent ones: they invite an operator to "harden" the
// deployment by setting them and get no protection at all. Removed rather than wired up,
// because each already has a real, consulted equivalent. `kekB64` (CP_KEK_B64) has now
// gone the same way for the same reason: it was parsed here and read nowhere, because
// lib/crypto (loadKek/rotateKek) reads process.env.CP_KEK_B64 directly — it must resolve
// a key before this module exists. CP_KEK_B64 itself is unchanged.
/**
 * B2 — self-serve local sign-up policy (`AUTH_SIGNUP`). `invite` (the default, and the
 * CI-Hub manifest's value) opens `POST /api/auth/signup` only to someone holding a
 * single-use invite code an operator minted in Settings → Accounts; `open` needs no
 * code; `off` removes the endpoint (404) and the /signup page. Meaningful only under
 * `AUTH_MODE=sso`. Companion Portal sign-up (B1) is independent of this: whenever the
 * portal is on, the login screen's sign-up affordance is the portal itself.
 */
export type AuthSignupPolicy = 'open' | 'invite' | 'off';

export interface AuthConfig {
  mode: AuthMode;
  autoProvision: boolean;  // first unknown SSO `sub` → provision owner row vs 403
  rateLimit: { windowMs: number; issueMax: number };
  // U2 — local username/password mode (only when mode === 'sso' && disableOidc):
  disableOidc: boolean;    // true ⇒ local login instead of JWKS Bearer verification
  defaultUsername?: string; // seeds the first local owner on boot if none exist
  defaultPassword?: string; // required to seed that owner; boot fails closed without a login path
  sessionSecret?: string;   // Koa app.keys secret signing the local-login session cookie
  resetTokenTtlMs: number;  // V: password-reset token lifetime (default 60 min)
  signup: AuthSignupPolicy; // B2: local self-serve sign-up — open | invite (default) | off
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
 *
 * `mode` + `envPinned` come from {@link ModeConfig} — the shape the memory connector
 * shares. Unlike memory's, both are captured ONCE at boot: services/google-config.ts
 * hot-applies an operator's in-app setup by mutating them at runtime.
 */
export interface GoogleConfig extends ModeConfig {
  clientId?: string;
  clientSecret?: string;
  authUri: string;
  tokenUri: string;
  revokeUri: string;
  redirectUri: string;
  publicBaseUrl: string;
  scopes: { identity: string[]; gmail: string[]; calendar: string[] };
  /** When true, /start requests the Gmail scope in addition to Calendar. */
  enableGmail: boolean;
  mcp: { command: string; timeoutMs: number; retries: number };
}

/**
 * Companion Portal (CI-Portal) OIDC consumer config (U1). Companion Planning is an
 * OAuth 2.1 + PKCE Relying Party of the portal — the same consumer role Companion
 * Memory, CI-Import Tools and CI-Hub play. The portal is a public Cloudflare Worker;
 * the code exchange runs over plain HTTPS (Tailscale only matters for the browser's
 * redirect host). Endpoint values come from the portal's discovery document
 * (`/.well-known/openid-configuration`); only the issuer and client id are configured.
 * Portal ORIGINS (discovery base is `<origin>/api/auth`):
 *   production  https://hub.ci.computer                ← the default below
 *   staging     https://hub.companionintel.com
 *   dev         https://hub.companionintelligence.com
 *   local       https://hub.ci.localhost
 * On a CI-Hub appliance the Hub injects the paired portal's issuer into
 * CIPORTAL_ISSUER (marketplace manifest `hub_integration.oidc`), so the default only
 * matters for self-host installs. This set REPLACED the
 * older generic AUTH_JWKS_URL/AUTH_ISSUER/AUTH_AUDIENCE/AUTH_CONTRACT_VERSION vars,
 * which have now been retired (see the note above AuthConfig).
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
  /** The version a fresh seal() writes; await loadKek() with no arg returns this key. */
  currentVersion: number;
}

export interface Config {
  port: number;
  // Behind a trusted reverse proxy / TLS terminator (e.g. CI-Hub's tunnel)? Enables Koa
  // app.proxy so ctx.protocol honors X-Forwarded-Proto (⇒ Secure cookies over external
  // HTTPS) and ctx.ip is the real client IP (⇒ correct per-IP login rate-limiting).
  // Default false — safe when the app is directly reachable (don't trust spoofable XFF).
  trustProxy: boolean;
  /** Browser origins allowed to make cross-origin requests to /api (CORS). The client is
   *  normally same-origin (koa-static in prod, the Vite proxy in dev), so this is empty
   *  by default — no browser origin needs cross-origin access out of the box. Set
   *  CORS_ALLOWED_ORIGINS (comma-separated) for a deployment that legitimately serves
   *  the SPA from a different origin than the API. Never '*': the API sits behind
   *  requireAuth and a wildcard would let any page that gets a browser to attach valid
   *  credentials read authenticated JSON cross-origin. */
  corsOrigins: string[];
  /** Track D2 — security headers. `extraConnectSrc`: additional origins the browser
   *  may call (CSP `connect-src`) beyond the app itself and the Sentry DSN origin,
   *  from CSP_EXTRA_CONNECT_SRC (space/comma-separated). Empty by default. */
  security: { extraConnectSrc: string[] };
  dbPath: string;
  /** Postgres connection string (schema port). Absent ⇒ the SQLite store is used.
   *  Both backends coexist; the port is not a supported deployment yet
   *  (server/db/postgres/README.md). */
  databaseUrl?: string;
  /** Which backend db/store.ts serves. Default 'sqlite'. Flipping this to 'postgres'
   *  IS the cutover. The call sites already use the facade; what keeps it opt-in is the
   *  Postgres baseline, which stops at migration 0147. Requires databaseUrl; boot fails
   *  closed otherwise rather than silently serving a store the data is not in. */
  storeBackend: 'sqlite' | 'postgres';
  ollamaUrl: string;
  ollamaFastModel: string;
  ollamaQualityModel: string;
  ollamaEmbedModel: string;
  staticDir: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  snapshotRetain: number;
  /** Every env-pinned decision in the app, in one object. See {@link PinConfig}. */
  pins: PinConfig;
  auth: AuthConfig;
  ciportal: CiPortalConfig;
  mail: MailConfig;
  graphql: GraphqlConfig;
  google: GoogleConfig;
  memory: MemoryConfig;
  sync: SyncConfig;
  kek: KekConfig;
}

// Default data dir (used only when DB_PATH is not set, e.g. local dev on macOS).
const defaultDataDir = join(homedir(), 'Library', 'Application Support', 'CompanionPlanning');

// Resolve relative to this file: server/src/lib/config.ts → server/public
const _dir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(_dir, '..', '..'); // server/src/lib → server/src → server

const dbPath = process.env.DB_PATH ?? join(defaultDataDir, 'companion.db');
const databaseUrl = process.env.DATABASE_URL;
const storeBackend = process.env.STORE_BACKEND === 'postgres' ? 'postgres' as const : 'sqlite' as const;
// Ensure the directory containing the DB exists (better-sqlite3 won't create it).
mkdirSync(dirname(dbPath), { recursive: true });

/**
 * Session secret (U2) — signs the login session cookie, and `AUTH_MODE=sso` refuses to
 * boot without one. An explicit `SESSION_SECRET` is authoritative: an operator pins it
 * deliberately, and any multi-replica deployment MUST pin it so every replica verifies
 * the same cookies.
 *
 * When it is unset, generate one ONCE and persist it beside the database on the app's own
 * data volume. This is the same "auto-provision an appliance secret" contract
 * `services/vapid-config.ts` already uses for the VAPID keypair: a container/marketplace
 * install boots without the operator having to invent and paste a random string, which is
 * otherwise the difference between a working install and a crash-loop.
 *
 * Stability is the whole point — regenerating would silently sign every existing user out,
 * so an existing readable file always wins, including when a concurrent boot wins the
 * create race (`flag: 'wx'` → re-read rather than clobber).
 *
 * Filesystem, not the DB: config.ts is evaluated before the database module exists
 * (`db/index.ts` imports config), so there is no table to write to yet.
 *
 * If the data dir is read-only the generate fails and this returns undefined — deliberately
 * leaving the `AUTH_MODE=sso requires SESSION_SECRET` guard below to report the real
 * problem, rather than silently serving unsigned (forgeable) session cookies.
 */
function resolveSessionSecret(): string | undefined {
  const pinned = process.env.SESSION_SECRET;
  if (pinned) return pinned;

  const file = join(dirname(dbPath), '.session-secret');
  const read = (): string | undefined => {
    try {
      return readFileSync(file, 'utf8').trim() || undefined;
    } catch {
      return undefined; // not created yet (or unreadable)
    }
  };

  const existing = read();
  if (existing) return existing;

  try {
    const generated = randomBytes(32).toString('base64');
    // 'wx' = create-exclusive: a parallel boot that got there first keeps its secret.
    writeFileSync(file, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return generated;
  } catch {
    return read(); // lost the race → use the winner's; read-only dir → undefined
  }
}

// Derived once so the redirect-uri default can reference it.
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3848';

// CORS allowlist (see Config.corsOrigins). Empty by default: the SPA is same-origin in
// every stock deployment path, so no browser origin needs a cross-origin exemption
// unless an operator explicitly names one.
const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
// Fail-closed default: unset (or unrecognized) GOOGLE_MODE means NO Google integration.
// Fixture mode — canned sample emails/events — must be an explicit opt-in, never a
// default a real deployment can hit by omission. When GOOGLE_MODE is unset, an
// operator-saved in-app Google client (app_config, hydrated after boot by
// services/google-config.ts) may flip the mode to 'live' at runtime; an explicit env
// value pins the mode and makes the in-app setup read-only.
const googleEnvPinned = process.env.GOOGLE_MODE === 'live' || process.env.GOOGLE_MODE === 'fixture';
const googleMode: ConnectorMode =
  process.env.GOOGLE_MODE === 'live' ? 'live'
  : process.env.GOOGLE_MODE === 'fixture' ? 'fixture'
  : 'off';

/**
 * The memory connector's mode, resolved from env on EVERY read (see {@link MemoryConfig}).
 * Same fail-closed default as Google: unset — or unrecognized — means the transport is
 * off, never a fixture a real deployment can hit by omission.
 */
function memoryModeFromEnv(): ConnectorMode {
  if (process.env.MEMORY_MODE === 'live') return 'live';
  if (process.env.MEMORY_MODE === 'fixture') return 'fixture';
  return 'off';
}

/**
 * The three Ollama model tiers as env configures them.
 *
 * The names below are last-resort defaults only. These tags are NOT installed on most
 * machines, so when a tier is unpinned lib/models.ts auto-selects from what the device
 * actually has and these are reached only while the installed set is still unknown
 * (pre-probe/offline). Set OLLAMA_FAST/QUALITY/EMBED to pin a tier to a specific
 * `ollama list` entry — a pin is used verbatim, and generate/embed then throw an
 * actionable error if it turns out not to be pulled.
 *
 * `OLLAMA_SMALL` / `OLLAMA_MEDIUM` are the tiers' former names and stay accepted as
 * aliases: operators have them in live `.env` files and in docker-compose.yml. The new
 * name wins when both are set, and either one counts as a pin.
 *
 * Takes `env` so the alias rule is testable without re-evaluating this module.
 */
export function ollamaModelsFromEnv(env: NodeJS.ProcessEnv = process.env): {
  fastModel: string;
  qualityModel: string;
  embedModel: string;
  pinned: { fast: boolean; quality: boolean; embed: boolean };
} {
  const fast = env.OLLAMA_FAST ?? env.OLLAMA_SMALL;
  const quality = env.OLLAMA_QUALITY ?? env.OLLAMA_MEDIUM;
  const embed = env.OLLAMA_EMBED;
  return {
    fastModel: fast ?? 'qwen2.5:0.5b',
    qualityModel: quality ?? 'gemma3n:e4b',
    embedModel: embed ?? 'nomic-embed-text',
    pinned: { fast: !!fast, quality: !!quality, embed: !!embed },
  };
}

const ollamaModels = ollamaModelsFromEnv();

export const config: Config = {
  port: Number(process.env.PORT ?? 3848),
  trustProxy: process.env.TRUST_PROXY === 'true',
  corsOrigins,
  security: {
    extraConnectSrc: (process.env.CSP_EXTRA_CONNECT_SRC ?? '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  },
  dbPath,
  databaseUrl,
  storeBackend,
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  // Tier defaults, env pins and the legacy OLLAMA_SMALL/MEDIUM aliases — see
  // ollamaModelsFromEnv above.
  ollamaFastModel: ollamaModels.fastModel,
  ollamaQualityModel: ollamaModels.qualityModel,
  ollamaEmbedModel: ollamaModels.embedModel,
  staticDir: join(packageRoot, 'public'),
  // Web Push (Phase H). Keys are AUTO-GENERATED on first boot and persisted to app_config
  // (services/vapid-config.ts hydrates them into this singleton after migrations), so push
  // works out of the box — no manual `npx web-push generate-vapid-keys` needed. Setting
  // BOTH env vars pins an explicit keypair and takes precedence. Never commit real keys.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@companion.local',
  snapshotRetain: Number(process.env.SNAPSHOT_RETAIN ?? 7),
  // Operator env pins — one shape, one place. See PinConfig for the three unrelated
  // meanings of "pin" in this codebase.
  pins: {
    // Tier pins and the legacy OLLAMA_SMALL/MEDIUM aliases — see ollamaModelsFromEnv.
    ollama: ollamaModels.pinned,
    // Mirrors config.google.envPinned rather than copying it: google-config.ts flips
    // that sub-config at runtime, and a copy here would go stale the moment it did.
    get google(): boolean {
      return config.google.envPinned;
    },
    vapid: Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  },
  auth: {
    mode: (process.env.AUTH_MODE as AuthMode) ?? 'test',
    autoProvision: process.env.AUTH_AUTO_PROVISION === 'true',
    rateLimit: {
      windowMs: Number(process.env.AUTH_RATE_WINDOW_MS ?? 60_000),
      issueMax: Number(process.env.AUTH_RATE_ISSUE_MAX ?? 5),
    },
    disableOidc: process.env.DISABLE_OIDC === 'true',
    defaultUsername: process.env.AUTH_DEFAULT_USERNAME,
    defaultPassword: process.env.AUTH_DEFAULT_PASSWORD,
    sessionSecret: resolveSessionSecret(),
    resetTokenTtlMs: Number(process.env.AUTH_RESET_TOKEN_TTL_MS ?? 3_600_000), // 60 min
    // Validated below (unknown values fail boot, like AUTH_MODE). Unset ⇒ invite-only:
    // the safe default for a reachable deployment — nobody can mint themselves an
    // account without an operator's code.
    signup: (process.env.AUTH_SIGNUP as AuthSignupPolicy | undefined) ?? 'invite',
  },
  ciportal: {
    // The PRODUCTION portal's discovery base. Until 2026-10-21 this defaulted to
    // hub.companionintelligence.com, which is the portal's DEV zone — a self-host install
    // that trusted the default pointed at the wrong identity provider. Overridable for
    // staging/dev, the fixture portal, or another provider. The token `iss` claim is
    // validated against the DISCOVERED doc's issuer, not this URL (see the interface note).
    issuer: process.env.CIPORTAL_ISSUER ?? 'https://hub.ci.computer/api/auth',
    // Registered with CI-Portal as a first-party PUBLIC (PKCE, no secret) client —
    // CI-Portal PR #444, `PUBLIC_CLIENTS` in apps/hono-app/.../createAuth.ts. This is a
    // fixed first-party identity, not per-deployment config, so it defaults like
    // `issuer` does rather than being an invented value every operator must discover.
    // Overridable for a fixture portal or a differently-registered fork.
    clientId: process.env.CIPORTAL_CLIENT_ID ?? 'ci-planning',
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
      // OIDC identity. REQUIRED, not optional: the callback resolves the connected
      // account solely from the id_token's `email` claim, and Google only returns an
      // id_token when `openid` is requested. Without these two the token response
      // carries no identity at all and every connect dies on
      // `could_not_verify_account_identity` — the flow can never complete.
      identity: ['openid', 'email'],
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
  // CI-Server memory connector — the same ModeConfig shape as google, but LAZY: every
  // property re-reads env on access. connectors/memory.ts used to own this read; folding
  // it in here as a getter keeps its documented per-call behavior byte for byte while
  // leaving exactly one file that touches MEMORY_MODE / CI_SERVER_URL.
  memory: {
    get mode(): ConnectorMode {
      return memoryModeFromEnv();
    },
    // Env is the ONLY way to set the memory mode — there is no in-app equivalent of the
    // Google setup to be read-only against — so this is true exactly when the connector
    // is on. It exists to satisfy ModeConfig, and is deliberately NOT in `config.pins`:
    // pins answers "what did the operator fix by hand instead of letting the app
    // decide?", and here the app never decides.
    get envPinned(): boolean {
      return memoryModeFromEnv() !== 'off';
    },
    get serverUrl(): string | undefined {
      return process.env.CI_SERVER_URL;
    },
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

// Fail closed: an unrecognized AUTH_MODE (a typo like `ssoo`) otherwise casts through
// unchecked at config.ts and boots a running-but-unloggable service — the request auth
// safely defaults to the standalone api-key path, but every login route 404s and no owner
// is seeded, with no signal to the operator. Reject it at boot instead, matching the
// fail-fast the other AUTH_MODE guards use. (An UNSET AUTH_MODE became 'test' above and is
// handled by the production guard below.)
const VALID_AUTH_MODES: AuthMode[] = ['test', 'standalone', 'sso'];
if (!VALID_AUTH_MODES.includes(config.auth.mode)) {
  throw new Error(
    `AUTH_MODE='${config.auth.mode}' is not a valid mode — set AUTH_MODE to one of: test, standalone, sso`,
  );
}

// Fail closed: the credential-free `test` owner path must never run in production.
// Same shape of guard for AUTH_SIGNUP (B2): a typo like `invit` must not silently
// become "no sign-up" (or, worse, be read as permissive by a later consumer).
const VALID_SIGNUP_POLICIES: AuthSignupPolicy[] = ['open', 'invite', 'off'];
if (!VALID_SIGNUP_POLICIES.includes(config.auth.signup)) {
  throw new Error(
    `AUTH_SIGNUP='${config.auth.signup}' is not a valid sign-up policy — set AUTH_SIGNUP to one of: open, invite, off`,
  );
}

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
    'AUTH_MODE=sso (OIDC enabled) requires CIPORTAL_CLIENT_ID (registered with Companion Portal) and CIPORTAL_ISSUER ' +
      '(defaults to https://hub.ci.computer/api/auth; endpoints are discovered from it) ' +
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

/**
 * Fail closed: a connector's fixture mode serves committed sample data as if it were the
 * user's own. In production that is fake data leaking into a real task list, so refuse to
 * boot unless the operator explicitly accepts it (CP_ALLOW_FIXTURE=true).
 *
 * One helper for every connector mode — the Google and memory guards were the same
 * fourteen lines twice, and the next connector would have made it three.
 *
 * `whatItServes` carries the entire connector-specific middle of the message (what
 * fixture data leaks into, and the two ways out). The two messages this replaced are
 * reproduced BYTE FOR BYTE: they are good copy, and operators grep their logs for them.
 */
function refuseFixtureInProduction(envVar: string, whatItServes: string): void {
  if (
    process.env[envVar] === 'fixture' &&
    process.env.NODE_ENV === 'production' &&
    process.env.CP_ALLOW_FIXTURE !== 'true'
  ) {
    throw new Error(
      `${envVar}=fixture is forbidden in production — ${whatItServes} ` +
        'or set CP_ALLOW_FIXTURE=true to explicitly allow fixtures (demo appliances only).',
    );
  }
}

// Google: fixture mode ingests committed sample emails/events as real tasks.
refuseFixtureInProduction(
  'GOOGLE_MODE',
  'it ingests committed sample data as real tasks. ' +
    'Set GOOGLE_MODE=live (with OAuth credentials), unset it to disable Google integration,',
);

// Memory: MEMORY_MODE=fixture serves the committed sample graph (server/fixtures/memory/)
// as the owner's real CI-Server memory, and memory_suggest auto-promotes those canned
// events into real tasks. Identical mistake class, identical escape hatch.
refuseFixtureInProduction(
  'MEMORY_MODE',
  'it serves committed sample memory data as real suggestions. ' +
    'Set MEMORY_MODE=live (with a CI-Server connection), unset it to disable the memory connector,',
);

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
