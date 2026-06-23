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
}

// Default data dir (used only when DB_PATH is not set, e.g. local dev on macOS).
const defaultDataDir = join(homedir(), 'Library', 'Application Support', 'CompanionPlanning');

// Resolve relative to this file: server/src/lib/config.ts → server/public
const _dir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(_dir, '..', '..'); // server/src/lib → server/src → server

const dbPath = process.env.DB_PATH ?? join(defaultDataDir, 'companion.db');
// Ensure the directory containing the DB exists (better-sqlite3 won't create it).
mkdirSync(dirname(dbPath), { recursive: true });

export const config: Config = {
  port: Number(process.env.PORT ?? 3848),
  dbPath,
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  // Defaults match models installed on the host. Override via env for other rigs.
  ollamaSmallModel: process.env.OLLAMA_SMALL ?? 'qwen2.5:0.5b',
  ollamaMediumModel: process.env.OLLAMA_MEDIUM ?? 'gemma4:e4b',
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
};

// Fail closed: the credential-free `test` owner path must never run in production.
// A misconfigured prod image is a silent auth bypass, so refuse to boot instead.
if (config.auth.mode === 'test' && process.env.NODE_ENV === 'production') {
  throw new Error(
    'AUTH_MODE=test is forbidden in production — set AUTH_MODE=standalone or sso',
  );
}

// Fail closed: SSO mode must pin both the JWKS source and the issuer. `jose` only
// checks `iss` when an issuer value is passed, so a missing AUTH_ISSUER would
// silently disable issuer pinning and accept any token signed by a key in the
// JWKS — cross-service token confusion. Refuse to boot without both.
if (config.auth.mode === 'sso' && (!config.auth.jwksUrl || !config.auth.issuer)) {
  throw new Error('AUTH_MODE=sso requires AUTH_JWKS_URL and AUTH_ISSUER');
}
