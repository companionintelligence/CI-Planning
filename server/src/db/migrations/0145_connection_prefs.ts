import type { Database } from 'better-sqlite3';

export const id = '0145_connection_prefs';

/**
 * Per-(owner × connection) display config: the colour and background texture the
 * calendar paints events mirrored from that source with.
 *
 * Keyed by (provider, account) — the SAME natural key `connection_tokens` and
 * `external_events` use — deliberately NOT by a FK to connection_tokens.id. Prefs must
 * survive a disconnect/reconnect cycle: `disconnectConnection` hard-deletes the token
 * row, so an FK (or an ON DELETE CASCADE) would silently discard the owner's colour
 * choice every time they re-authorized an account. Re-connecting the same address
 * therefore restores its look. The cost is rows that outlive their connection, which is
 * the intended behaviour and is bounded by the number of accounts a person connects.
 *
 * `color_token` is a CI-Hub token key ('primary', 'tag-7', …), never a hex string —
 * matching tag_prefs/category_prefs, so a theme change re-colours everything at once
 * and no stored value can fall outside the design system.
 *
 * `texture` names a stripe geometry rather than storing CSS, so the rendering (angle,
 * line width, alpha) stays a client concern and can be retuned without a migration.
 * 'none' is the default: an unconfigured connection looks exactly as it does today,
 * so this migration is visually inert until the owner picks something.
 */
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS connection_prefs (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES owners(id),
      provider    TEXT NOT NULL,
      account     TEXT NOT NULL,
      color_token TEXT NOT NULL DEFAULT 'primary',
      texture     TEXT NOT NULL DEFAULT 'none',
      UNIQUE (owner_id, provider, account)
    );
  `);
}
