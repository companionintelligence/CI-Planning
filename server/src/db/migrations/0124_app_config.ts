import type { Database } from 'better-sqlite3';

export const id = '0124_app_config';

/**
 * Server-global key/value config store (in-app Google connection setup).
 *
 * Holds operator-editable settings that are NOT per-owner (scheduling_prefs) and NOT
 * boot-time env (config.ts): today the Google OAuth client — `google_enabled`,
 * `google_client_id`, and `google_client_secret` (the secret value is a KEK-sealed
 * JSON blob {iv, auth_tag, ciphertext, key_version}, never plaintext). Values are
 * hydrated into the config singleton at boot and on save (services/google-config.ts);
 * explicit env vars always take precedence over rows here.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
