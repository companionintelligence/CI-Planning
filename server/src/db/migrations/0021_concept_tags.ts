import type { Database } from 'better-sqlite3';

export const id = '0021_concept_tags';

/**
 * Block Wizard support (PR-A). A canonical, user-editable **Concept-Tag** list lives
 * on `scheduling_prefs.concept_tags` (JSON: `{name, minutes}[]`) — every block starts
 * as a Concept named/tagged from this list, with a default estimated duration. Plus
 * a `note` on `time_blocks` so a Plan/Concept container can carry a saved note.
 *
 * Additive + idempotent. Seeds the canonical defaults for existing prefs rows; new
 * owners fall back to the same defaults client-side until they edit them.
 */
const DEFAULT_CONCEPT_TAGS = [
  { name: 'Work', minutes: 240 },
  { name: 'Relax', minutes: 60 },
  { name: 'Family-Time', minutes: 120 },
  { name: 'Me-Time', minutes: 60 },
  { name: 'Socialize', minutes: 120 },
  { name: 'House-work', minutes: 60 },
  { name: 'Yard-work', minutes: 90 },
  { name: 'Exercise', minutes: 45 },
  { name: 'Meal-prep', minutes: 45 },
];

export function up(db: Database): void {
  const spCols = (db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map((c) => c.name);
  if (!spCols.includes('concept_tags')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN concept_tags TEXT`);
    db.prepare(`UPDATE scheduling_prefs SET concept_tags = ? WHERE concept_tags IS NULL`).run(JSON.stringify(DEFAULT_CONCEPT_TAGS));
  }

  const tbCols = (db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[]).map((c) => c.name);
  if (!tbCols.includes('note')) db.exec(`ALTER TABLE time_blocks ADD COLUMN note TEXT`);
}
