import { store } from '../db/store.js';
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

async function readValue(key: string): Promise<string | null> {
  const row = await store().prepare(`SELECT value FROM app_config WHERE key = ?`).get<{ value: string }>(key);
  return row?.value ?? null;
}

async function writeValue(key: string, value: string): Promise<void> {
  await store()
    .prepare(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(key, value);
}

async function deleteValue(key: string): Promise<void> {
  await store().prepare(`DELETE FROM app_config WHERE key = ?`).run(key);
}

/**
 * FTUE · T12 (#348) — fixture mode serves committed sample data as real tasks to
 * EVERY owner on the deployment (a single global `app_config` row, not per-owner), so
 * it needs the same production opt-in `config.ts`'s boot guard enforces for
 * `GOOGLE_MODE=fixture`. Shared by `saveGoogleConfig` (the write path) AND
 * `hydrateGoogleConfig` (the read/boot path) — an earlier version of this file only
 * gated the write path, which left a real gap: a DB carrying a persisted
 * `google_mode='fixture'` row (e.g. copied/promoted from a non-production
 * environment where fixture mode was legitimately enabled) would silently reactivate
 * fixture ingest on every later production boot, since `hydrateGoogleConfig` only
 * ever checked `config.google.envPinned` — never `NODE_ENV`/`CP_ALLOW_FIXTURE`
 * directly — before trusting whatever was already in the table.
 */
function fixtureForbiddenInProduction(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.CP_ALLOW_FIXTURE !== 'true';
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
async function openStoredSecret(): Promise<string | null> {
  const raw = await readValue(KEY_CLIENT_SECRET);
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

export async function readAppGoogleConfig(): Promise<AppGoogleConfig> {
  return {
    enabled: (await readValue(KEY_ENABLED)) === '1',
    clientId: await readValue(KEY_CLIENT_ID),
    hasClientSecret: (await readValue(KEY_CLIENT_SECRET)) !== null,
    mode: (await readValue(KEY_MODE)) === 'fixture' ? 'fixture' : null,
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
export async function saveGoogleConfig(input: {
  clientId?: string;
  clientSecret?: string | null;
  enabled: boolean;
  mode?: 'live' | 'fixture';
}): Promise<SaveGoogleConfigResult> {
  if (config.google.envPinned) return { ok: false, error: 'env_pinned' };

  if (input.enabled && input.mode === 'fixture') {
    if (fixtureForbiddenInProduction()) {
      return { ok: false, error: 'fixture_forbidden_in_production' };
    }
    await store().transaction(async () => {
      await writeValue(KEY_ENABLED, '1');
      await writeValue(KEY_MODE, 'fixture');
    });
    await hydrateGoogleConfig();
    return { ok: true, state: await googleConfigState() };
  }

  const clientId = (input.clientId ?? (await readAppGoogleConfig()).clientId ?? '').trim();
  if (input.enabled && !clientId) return { ok: false, error: 'client_id_required' };
  // KEK gates ENABLING (token storage needs it) and any secret write (sealing needs it).
  if ((input.enabled || typeof input.clientSecret === 'string') && !kekAvailable()) {
    return { ok: false, error: 'kek_required' };
  }

  await store().transaction(async () => {
    await writeValue(KEY_ENABLED, input.enabled ? '1' : '0');
    await deleteValue(KEY_MODE); // leaving (or never entering) fixture mode
    if (clientId) await writeValue(KEY_CLIENT_ID, clientId);
    else await deleteValue(KEY_CLIENT_ID);
    if (typeof input.clientSecret === 'string' && input.clientSecret.trim()) {
      const sealed = seal(input.clientSecret.trim(), loadKek());
      const blob: SealedSecretBlob = { ...sealed, key_version: config.kek.currentVersion };
      await writeValue(KEY_CLIENT_SECRET, JSON.stringify(blob));
    } else if (input.clientSecret === null) {
      await deleteValue(KEY_CLIENT_SECRET);
    }
  });

  await hydrateGoogleConfig();
  return { ok: true, state: await googleConfigState() };
}

/**
 * Apply the stored app config to the config singleton. Called at boot (after
 * migrations) and after every save. No-op when GOOGLE_MODE is env-pinned. When the
 * app config is disabled/absent, the env-derived client id/secret and 'off' mode are
 * restored, so disabling round-trips cleanly.
 *
 * A persisted `mode='fixture'` row is only honored when `fixtureForbiddenInProduction()`
 * says no — a stale fixture row surviving into a production boot is refused (falls
 * through to the live/off branches below) rather than trusted blindly; the row itself
 * is left untouched (not auto-deleted) so a legitimate demo-appliance boot that's
 * merely missing `CP_ALLOW_FIXTURE` this one time isn't destructively "healed."
 */
export async function hydrateGoogleConfig(): Promise<void> {
  if (config.google.envPinned) return;
  const app = await readAppGoogleConfig();
  const wantsFixture = app.enabled && app.mode === 'fixture';
  const fixtureAllowed = wantsFixture && !fixtureForbiddenInProduction();
  if (wantsFixture && !fixtureAllowed) {
    logger.warn(
      'google-config: a persisted mode=fixture row exists but NODE_ENV=production without CP_ALLOW_FIXTURE — refusing to activate it (fixture mode ingests committed sample data as real tasks for every owner). Set CP_ALLOW_FIXTURE=true to explicitly allow it, or clear it from Settings → Connections.',
    );
  }
  if (fixtureAllowed) {
    config.google.clientId = undefined;
    config.google.clientSecret = undefined;
    config.google.mode = 'fixture';
    logger.info('google-config: in-app fixture mode active (mode=fixture)');
  } else if (app.enabled && app.clientId) {
    config.google.clientId = app.clientId;
    config.google.clientSecret = (await openStoredSecret()) ?? undefined;
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
export async function googleConfigState(): Promise<GoogleConfigState> {
  const app = await readAppGoogleConfig();
  return {
    // Derived from the ALREADY-HYDRATED config.google.mode, not re-derived from the raw
    // app_config row — so a fixture row that hydrateGoogleConfig refused to honor (a
    // production boot with no CP_ALLOW_FIXTURE) correctly reports source:'off' instead
    // of the misleading 'app' a naive re-derivation from `app.mode === 'fixture'` would
    // give, even though config.google.mode itself already (correctly) says 'off'.
    source: config.google.envPinned ? 'env' : config.google.mode !== 'off' ? 'app' : 'off',
    mode: config.google.mode,
    envPinned: config.google.envPinned,
    kekAvailable: kekAvailable(),
    clientId: config.google.envPinned ? (config.google.clientId ?? null) : app.clientId,
    hasClientSecret: config.google.envPinned ? Boolean(config.google.clientSecret) : app.hasClientSecret,
    enabled: app.enabled,
    redirectUri: config.google.redirectUri,
  };
}
