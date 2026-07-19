import { sqlite } from '../db/index.js';
import { config } from '../lib/config.js';
import { seal, open, loadKek } from '../lib/crypto/index.js';
import { logger } from '../lib/logger.js';

/**
 * In-app Google connection setup (ship-readiness follow-up).
 *
 * Lets an operator configure the Google OAuth client from Settings → Connections —
 * no env vars, no restart. The client id lives in `app_config` in the clear (it is
 * public by OAuth design); the client secret is KEK-sealed (AES-256-GCM, same
 * infrastructure as `connection_tokens`) and is never returned by any endpoint.
 *
 * Precedence: an explicit `GOOGLE_MODE` env (config.google.envPinned) is authoritative
 * — hydration then never touches the singleton and the PUT route refuses with 409.
 * Otherwise a saved-and-enabled app config flips the live mode on at runtime by
 * mutating the config singleton (every consumer — oauth routes, connectors, ingest —
 * reads it at call time, so no restart is needed).
 *
 * A KEK (CP_KEK_B64) is REQUIRED to enable the in-app setup at all: even a secret-less
 * (Desktop/loopback) client must store OAuth tokens at the callback, and those are
 * KEK-sealed — enabling without a KEK would let the user complete a Google consent
 * screen only to crash at token storage.
 */

const KEY_ENABLED = 'google_enabled';
const KEY_CLIENT_ID = 'google_client_id';
const KEY_CLIENT_SECRET = 'google_client_secret'; // KEK-sealed JSON blob, never plaintext
// FTUE · T12 (#348) — set to 'fixture' to run the FTUE "Try with sample data" path
// without a real OAuth client or a KEK. Absent/anything else ⇒ derive live/off from
// clientId as before. Cleared on every non-fixture save so switching away is clean.
const KEY_MODE = 'google_mode';

// The env-derived values captured at module load, restored when in-app config is
// disabled (so toggling the app config off cleanly returns to the env posture).
const ENV_CLIENT_ID = process.env.CP_GOOGLE_CLIENT_ID;
const ENV_CLIENT_SECRET = process.env.CP_GOOGLE_CLIENT_SECRET;

interface SealedSecretBlob {
  iv: string;
  authTag: string;
  ciphertext: string;
  key_version: number;
}

function readValue(key: string): string | null {
  const row = sqlite.prepare(`SELECT value FROM app_config WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeValue(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(key, value);
}

function deleteValue(key: string): void {
  sqlite.prepare(`DELETE FROM app_config WHERE key = ?`).run(key);
}

/** Whether a KEK is configured (and decodes) — the gate for enabling in-app setup. */
export function kekAvailable(): boolean {
  try {
    loadKek();
    return true;
  } catch {
    return false;
  }
}

/** Decrypt the stored client secret, or null (absent / KEK missing / rotated away). */
function openStoredSecret(): string | null {
  const raw = readValue(KEY_CLIENT_SECRET);
  if (!raw) return null;
  try {
    const blob = JSON.parse(raw) as SealedSecretBlob;
    return open(
      { iv: blob.iv, authTag: blob.authTag, ciphertext: blob.ciphertext },
      loadKek(blob.key_version),
    );
  } catch (err) {
    logger.warn('google-config: failed to open stored client secret', {
      err: (err as Error).message,
    });
    return null;
  }
}

export interface AppGoogleConfig {
  enabled: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  /** Persisted fixture-mode override; null = derive live/off from clientId as before. */
  mode: 'fixture' | null;
}

export function readAppGoogleConfig(): AppGoogleConfig {
  return {
    enabled: readValue(KEY_ENABLED) === '1',
    clientId: readValue(KEY_CLIENT_ID),
    hasClientSecret: readValue(KEY_CLIENT_SECRET) !== null,
    mode: readValue(KEY_MODE) === 'fixture' ? 'fixture' : null,
  };
}

export type SaveGoogleConfigResult =
  | { ok: true; state: GoogleConfigState }
  | { ok: false; error: 'env_pinned' | 'kek_required' | 'client_id_required' | 'fixture_forbidden_in_production' };

/**
 * Save the in-app Google client and re-hydrate the config singleton.
 * `clientSecret`: string = replace; null = clear; undefined = keep existing.
 * `mode: 'fixture'` (FTUE · T12) is a separate, minimal branch: it needs neither a
 * client id nor a KEK — it's a local demo path, not a real OAuth client — and never
 * touches the stored client id/secret, so switching back to `live` later restores them
 * untouched. It DOES need the same production guard `config.ts` enforces at boot for
 * `GOOGLE_MODE=fixture` (fixture mode serves committed sample data as real tasks to
 * EVERY owner on the deployment — this is a single global `app_config` row, not
 * per-owner) — without this check, an operator's own "Try with sample data" onboarding
 * click could flip a live production deployment into demo mode with no confirmation.
 */
export function saveGoogleConfig(input: {
  clientId?: string;
  clientSecret?: string | null;
  enabled: boolean;
  mode?: 'live' | 'fixture';
}): SaveGoogleConfigResult {
  if (config.google.envPinned) return { ok: false, error: 'env_pinned' };

  if (input.enabled && input.mode === 'fixture') {
    if (process.env.NODE_ENV === 'production' && process.env.CP_ALLOW_FIXTURE !== 'true') {
      return { ok: false, error: 'fixture_forbidden_in_production' };
    }
    sqlite.transaction(() => {
      writeValue(KEY_ENABLED, '1');
      writeValue(KEY_MODE, 'fixture');
    })();
    hydrateGoogleConfig();
    return { ok: true, state: googleConfigState() };
  }

  const clientId = (input.clientId ?? readAppGoogleConfig().clientId ?? '').trim();
  if (input.enabled && !clientId) return { ok: false, error: 'client_id_required' };
  // KEK gates ENABLING (token storage needs it) and any secret write (sealing needs it).
  if ((input.enabled || typeof input.clientSecret === 'string') && !kekAvailable()) {
    return { ok: false, error: 'kek_required' };
  }

  sqlite.transaction(() => {
    writeValue(KEY_ENABLED, input.enabled ? '1' : '0');
    deleteValue(KEY_MODE); // leaving (or never entering) fixture mode
    if (clientId) writeValue(KEY_CLIENT_ID, clientId);
    else deleteValue(KEY_CLIENT_ID);
    if (typeof input.clientSecret === 'string' && input.clientSecret.trim()) {
      const sealed = seal(input.clientSecret.trim(), loadKek());
      const blob: SealedSecretBlob = { ...sealed, key_version: config.kek.currentVersion };
      writeValue(KEY_CLIENT_SECRET, JSON.stringify(blob));
    } else if (input.clientSecret === null) {
      deleteValue(KEY_CLIENT_SECRET);
    }
  })();

  hydrateGoogleConfig();
  return { ok: true, state: googleConfigState() };
}

/**
 * Apply the stored app config to the config singleton. Called at boot (after
 * migrations) and after every save. No-op when GOOGLE_MODE is env-pinned. When the
 * app config is disabled/absent, the env-derived client id/secret and 'off' mode are
 * restored, so disabling round-trips cleanly.
 */
export function hydrateGoogleConfig(): void {
  if (config.google.envPinned) return;
  const app = readAppGoogleConfig();
  if (app.enabled && app.mode === 'fixture') {
    config.google.clientId = undefined;
    config.google.clientSecret = undefined;
    config.google.mode = 'fixture';
    logger.info('google-config: in-app fixture mode active (mode=fixture)');
  } else if (app.enabled && app.clientId) {
    config.google.clientId = app.clientId;
    config.google.clientSecret = openStoredSecret() ?? undefined;
    config.google.mode = 'live';
    logger.info('google-config: in-app Google client active (mode=live)', {
      clientId: app.clientId.slice(0, 12) + '…',
      hasSecret: app.hasClientSecret,
    });
  } else {
    config.google.clientId = ENV_CLIENT_ID;
    config.google.clientSecret = ENV_CLIENT_SECRET;
    config.google.mode = 'off';
  }
}

export interface GoogleConfigState {
  /** Where the effective mode comes from. */
  source: 'env' | 'app' | 'off';
  mode: 'live' | 'fixture' | 'off';
  envPinned: boolean;
  kekAvailable: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  enabled: boolean;
  /** The redirect URI to register in the Google Cloud console. */
  redirectUri: string;
}

/** The admin GET shape — never includes the secret value. */
export function googleConfigState(): GoogleConfigState {
  const app = readAppGoogleConfig();
  return {
    source: config.google.envPinned ? 'env' : app.enabled && (app.mode === 'fixture' || app.clientId) ? 'app' : 'off',
    mode: config.google.mode,
    envPinned: config.google.envPinned,
    kekAvailable: kekAvailable(),
    clientId: config.google.envPinned ? (config.google.clientId ?? null) : app.clientId,
    hasClientSecret: config.google.envPinned ? Boolean(config.google.clientSecret) : app.hasClientSecret,
    enabled: app.enabled,
    redirectUri: config.google.redirectUri,
  };
}
