import type { Database } from 'better-sqlite3';

export const id = '0012_settings_models_memory';

/**
 * Settings additions: per-owner Ollama model overrides + Companion Memory sync
 * config, all on `scheduling_prefs`. Additive, idempotent (add-column-if-missing).
 *
 * Model columns are null = "use the env default" (`OLLAMA_FAST`/`QUALITY`/`EMBED`),
 * so existing installs behave exactly as before until a model is picked in Settings.
 * Memory sync is off by default (privacy-first); scope flags default on so enabling
 * sync covers everything unless narrowed.
 */
export function up(db: Database): void {
  const cols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  const add = (name: string, sql: string) => {
    if (!cols.includes(name)) db.exec(sql);
  };

  // Per-owner Ollama model overrides (null ⇒ env default).
  add('fast_model', `ALTER TABLE scheduling_prefs ADD COLUMN fast_model TEXT`);
  add('quality_model', `ALTER TABLE scheduling_prefs ADD COLUMN quality_model TEXT`);
  add('embed_model', `ALTER TABLE scheduling_prefs ADD COLUMN embed_model TEXT`);

  // Companion Memory sync (one-way push; off by default, scopes on by default).
  add('memory_sync_enabled', `ALTER TABLE scheduling_prefs ADD COLUMN memory_sync_enabled INTEGER DEFAULT 0`);
  add('memory_sync_completed', `ALTER TABLE scheduling_prefs ADD COLUMN memory_sync_completed INTEGER DEFAULT 1`);
  add('memory_sync_habits', `ALTER TABLE scheduling_prefs ADD COLUMN memory_sync_habits INTEGER DEFAULT 1`);
  add('memory_sync_reflections', `ALTER TABLE scheduling_prefs ADD COLUMN memory_sync_reflections INTEGER DEFAULT 1`);
  add('memory_account', `ALTER TABLE scheduling_prefs ADD COLUMN memory_account TEXT`);
  add('memory_last_synced_at', `ALTER TABLE scheduling_prefs ADD COLUMN memory_last_synced_at TEXT`);
}
