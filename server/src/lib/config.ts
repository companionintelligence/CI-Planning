import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Auth mode (Phase I). `test` injects a fixed system owner with no credentials so
 * the existing suite + local dev run unchanged — it is hard-rejected at boot under
 * NODE_ENV=production (fail closed). `standalone` requires a hashed `x-api-key`
 * (public Docker image). `sso` verifies a JWKS-signed Bearer JWT (CI-Server hub).
 */
export type AuthMode = 'test' | 'standalone' | 'sso';

export interface AuthConfig {
  mode: AuthMode;
  jwksUrl?: string;        // required when mode === 'sso' (PR2)
  issuer?: string;         // documented contract value (PR2)
  audience: string;        // expected JWT `aud`
  contractVersion: string; // pinned versioned-contract assertion (PR2)
  autoProvision: boolean;  // first unknown SSO `sub` → provision owner row vs 403
  kekB64?: string;         // 32-byte base64 KEK for the connection-token store (PR4)
  rateLimit: { windowMs: number; max: number; issueMax: number };
}

/**
 * Google connector config (Wave 0). The SINGLE source of truth for OAuth endpoints,
 * scopes, MCP transport, and live/fixture mode — later WPs consume this block; they
 * do NOT re-derive these values from env. `mode: 'fixture'` (the default) keeps the
 * test suite + local dev fully offline.
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
  mode: 'live' | 'fixture';
}

/** Sync engine toggles (Wave 0). */
export interface SyncConfig {
  /** When false, the sync layer never pushes local changes back to providers. */
  writeback: boolean;
  /** Master kill switch for the sync agent. */
  disabled: boolean;
}

/** Key-encryption-key versioning (Wave 0) — drives crypto.loadKek/rotateKek. */
export interface KekConfig {
  /** The version a fresh seal() writes; loadKek() with no arg returns this key. */
  currentVersion: number;
}

export interface Config {
  port: number;
  dbPath: string;
  ollamaUrl: string;
  ollamaSmallModel: string;
  ollamaMediumModel: string;
  ollamaEmbedModel: string;
  staticDir: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  snapshotRetain: number;
  auth: AuthConfig;
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
const googleMode: 'live' | 'fixture' = process.env.GOOGLE_MODE === 'live' ? 'live' : 'fixture';

export const config: Config = {
  port: Number(process.env.PORT ?? 3848),
  dbPath,
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  // Defaults are real, currently-pullable Ollama tags. They are only a fallback:
  // set OLLAMA_SMALL/MEDIUM/EMBED in server/.env to any model from `ollama list`.
  // If a configured model isn't pulled, generate/embed throw an actionable error.
  ollamaSmallModel: process.env.OLLAMA_SMALL ?? 'qwen2.5:0.5b',
  ollamaMediumModel: process.env.OLLAMA_MEDIUM ?? 'gemma3n:e4b',
  ollamaEmbedModel: process.env.OLLAMA_EMBED ?? 'nomic-embed-text',
  staticDir: join(packageRoot, 'public'),
  // Web Push (Phase H). Generate once: `npx web-push generate-vapid-keys`.
  // Absent keys ⇒ push disabled (in-app SSE still delivers). Never commit real keys.
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@companion.local',
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
      command: process.env.CP_MCP_COMMAND ?? '',
      timeoutMs: Number(process.env.CP_MCP_TIMEOUT_MS ?? 30_000),
      retries: Number(process.env.CP_MCP_RETRIES ?? 3),
    },
    mode: googleMode,
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

// Fail closed (Wave 0): GOOGLE_MODE=live without OAuth credentials would silently fall
// back to broken auth flows. Require the client id + redirect uri up front. These guards
// never fire under the test harness (default mode is 'fixture').
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
