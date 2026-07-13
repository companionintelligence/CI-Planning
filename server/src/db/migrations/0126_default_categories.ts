import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0126_default_categories';

/**
 * Default Time Block Categories become Personal / Professional / Social (owner
 * ruling 2026-07-12), replacing 0069's family/social/me. Per owner:
 *
 *   - `me` (base category) is RENAMED to `personal` — id preserved, so
 *     time_blocks.category_id, tag_categories, and tag_prefs rows follow along.
 *   - `family` is DEMOTED to a regular, deletable category (is_base=0); any
 *     blocks/intentions referencing it are untouched.
 *   - `professional` is seeded as a new base category (+ tag_prefs, chart-2).
 *   - `social` stays (re-seeded if an owner somehow lacks it).
 *
 * Collision posture mirrors 0069: a target name that already exists as a
 * NON-category tag fails loudly rather than promote/clobber. Idempotent: the
 * rename is skipped when `personal` already exists; inserts are guarded or
 * OR IGNORE (tag_prefs is UNIQUE(owner_id, tag_id)).
 */

const NEW_BASE: readonly (readonly [string, string])[] = [
  ['personal', 'chart-5'],      // color carried over from 'me' where renamed
  ['professional', 'chart-2'],
  ['social', 'chart-3'],
];

export function up(db: Database): void {
  const owners = db.prepare(`SELECT id FROM owners`).all() as { id: string }[];
  const byName = db.prepare(`SELECT id, kind, is_base FROM tags WHERE owner_id = ? AND name = ?`);
  const setBase = db.prepare(`UPDATE tags SET is_base = ? WHERE id = ?`);
  const insTag = db.prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (?, ?, ?, 'category', 1)`);
  const insPref = db.prepare(
    `INSERT OR IGNORE INTO tag_prefs (id, owner_id, tag_id, kind, color_token, default_minutes)
     VALUES (?, ?, ?, 'category', ?, 60)`,
  );
  type Row = { id: string; kind: string; is_base: number } | undefined;

  for (const o of owners) {
    // 1 — me → personal (id-preserving rename, so every FK reference follows).
    const me = byName.get(o.id, 'me') as Row;
    const personal = byName.get(o.id, 'personal') as Row;
    if (personal && personal.kind !== 'category') {
      throw new Error(`0126: 'personal' already exists as kind='${personal.kind}' for owner ${o.id}; rename that tag before migrating.`);
    }
    if (me?.kind === 'category') {
      if (!personal) db.prepare(`UPDATE tags SET name = 'personal', is_base = 1 WHERE id = ?`).run(me.id);
      // Both exist (re-run / user-created 'personal'): the loop below promotes
      // 'personal'; retire 'me' from the base set but keep the row + references.
      else setBase.run(0, me.id);
    }

    // 2 — family: out of the base set, data kept.
    const family = byName.get(o.id, 'family') as Row;
    if (family?.kind === 'category' && family.is_base) setBase.run(0, family.id);

    // 3 — ensure the new base trio exists with prefs.
    for (const [name, color] of NEW_BASE) {
      const existing = byName.get(o.id, name) as Row;
      if (existing) {
        if (existing.kind !== 'category') {
          throw new Error(`0126: base category name '${name}' already exists as kind='${existing.kind}' for owner ${o.id}; rename that tag before migrating.`);
        }
        if (!existing.is_base) setBase.run(1, existing.id);
        insPref.run(newId(), o.id, existing.id, color);
      } else {
        const nid = newId();
        insTag.run(nid, o.id, name);
        insPref.run(newId(), o.id, nid, color);
      }
    }
  }
}
