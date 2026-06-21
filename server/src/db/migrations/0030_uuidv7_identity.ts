import type { Database } from 'better-sqlite3';
import { newId, SYSTEM_OWNER_ID } from '../../lib/ids.js';

export const id = '0030_uuidv7_identity';
// Runs outside the runner's auto-transaction: a PK-type rebuild needs
// foreign_keys=OFF (DROP TABLE under FK-on would cascade-delete children), and
// that PRAGMA is a silent no-op inside a transaction.
export const manual = true;

/**
 * CON-1 — move every entity PK + FK from INTEGER autoincrement to TEXT **UUIDv7**.
 * See docs/con-1-uuidv7-design.md. Proven by the behavior baseline
 * (server/test/baseline.characterization.test.ts): the read-API + engine goldens
 * must stay green (ids are normalized to referent tokens, so int→uuid is invisible)
 * and the schema-shape golden proves no table/column is lost.
 *
 * SQLite can't retype a PK in place, so each table is **rebuilt**: read its live
 * DDL, retype only the id/FK columns to TEXT, copy rows translating every id
 * through a per-table old→uuid map, then restore its indexes. foreign_keys is OFF
 * for the duration (one transaction); `foreign_key_check` gates the result.
 */

interface Spec {
  t: string;
  /** has a surrogate `id` PK (gets its own old→uuid map) */
  hasId: boolean;
  /** fk column -> referent table whose id-map remaps it */
  fks: Record<string, string>;
}

// Dependency order isn't required (FK off during the rebuild), but parents-first
// keeps the REFERENCES targets present and the diff readable.
const TABLES: Spec[] = [
  { t: 'owners', hasId: true, fks: {} },
  { t: 'tags', hasId: true, fks: {} },
  { t: 'scheduled_jobs', hasId: true, fks: {} },
  { t: 'tasks', hasId: true, fks: { parent_id: 'tasks', recurrence_parent_id: 'tasks', owner_id: 'owners' } },
  { t: 'possible_tasks', hasId: true, fks: { proposed_owner_id: 'owners', promoted_task_id: 'tasks' } },
  { t: 'pattern_types', hasId: true, fks: { owner_id: 'owners' } },
  { t: 'patterns', hasId: true, fks: { owner_id: 'owners', type_id: 'pattern_types' } },
  { t: 'time_blocks', hasId: true, fks: { task_id: 'tasks', parent_block_id: 'time_blocks' } },
  { t: 'block_templates', hasId: true, fks: { owner_id: 'owners' } },
  { t: 'time_entries', hasId: true, fks: { task_id: 'tasks', owner_id: 'owners', block_id: 'time_blocks' } },
  { t: 'scheduling_prefs', hasId: true, fks: { owner_id: 'owners' } },
  { t: 'job_runs', hasId: true, fks: { job_id: 'scheduled_jobs' } },
  // Composite-key / junction tables — no surrogate id; only FK columns retype.
  { t: 'task_dependencies', hasId: false, fks: { task_id: 'tasks', depends_on_id: 'tasks' } },
  { t: 'pattern_tasks', hasId: false, fks: { pattern_id: 'patterns', task_id: 'tasks' } },
  { t: 'flight_plan', hasId: false, fks: { owner_id: 'owners', task_id: 'tasks', source_pattern_id: 'patterns' } },
  { t: 'task_tags', hasId: false, fks: { task_id: 'tasks', tag_id: 'tags' } },
  { t: 'possible_task_tags', hasId: false, fks: { possible_task_id: 'possible_tasks', tag_id: 'tags' } },
  { t: 'daily_summaries', hasId: false, fks: { owner_id: 'owners' } },
];

export function up(db: Database): void {
  // Idempotency: if tasks.id is already TEXT, the rebuild has run. Forward-only
  // (not expand/contract — a column can't be two PK types at once).
  const idType = (db.prepare(`SELECT type FROM pragma_table_info('tasks') WHERE name = 'id'`).get() as
    | { type: string }
    | undefined)?.type;
  if (idType && idType.toUpperCase() === 'TEXT') return;

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      // Pass 1 — assign a fresh UUIDv7 to every existing id, per table.
      const maps: Record<string, Map<unknown, string>> = {};
      for (const s of TABLES) {
        if (!s.hasId) continue;
        const m = new Map<unknown, string>();
        for (const r of db.prepare(`SELECT id FROM ${s.t}`).all() as { id: unknown }[]) {
          // The legacy single owner (integer 1) maps to the fixed sentinel so
          // currentOwnerId() resolves; everything else gets a fresh uuid.
          m.set(r.id, s.t === 'owners' && (r.id === 1 || r.id === '1') ? SYSTEM_OWNER_ID : newId());
        }
        maps[s.t] = m;
      }

      // Pass 2 — rebuild each table with TEXT id/FK columns and remapped rows.
      for (const s of TABLES) {
        const retype = [...(s.hasId ? ['id'] : []), ...Object.keys(s.fks)];

        // Transform the live DDL: point at <t>__new, retype id/FK cols to TEXT,
        // drop AUTOINCREMENT, and make the surrogate id NOT NULL (a TEXT PK can
        // otherwise hold NULL — we want a missed insert to fail loudly).
        const ddl = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name = ?`).get(s.t) as {
          sql: string;
        }).sql;
        let nd = ddl.replace(/CREATE TABLE\s+(IF NOT EXISTS\s+)?["'`]?[A-Za-z_][A-Za-z0-9_]*["'`]?/i, `CREATE TABLE "${s.t}__new"`);
        for (const c of retype) nd = nd.replace(new RegExp(`(\\b${c}\\b)\\s+INTEGER`, 'i'), '$1 TEXT');
        nd = nd.replace(/\s+AUTOINCREMENT/gi, '');
        if (s.hasId) nd = nd.replace(/\bid\b\s+TEXT\s+PRIMARY\s+KEY/i, 'id TEXT PRIMARY KEY NOT NULL');
        db.exec(nd);

        // Preserve indexes (partial / unique / composite) verbatim; a rebuild
        // drops them. Auto-indexes from PK/UNIQUE have sql IS NULL and recreate
        // with the table.
        const indexes = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL`).all(s.t) as {
          sql: string;
        }[]).map((r) => r.sql);

        // Copy rows, remapping the id + every FK through the maps.
        const cols = (db.prepare(`PRAGMA table_info(${s.t})`).all() as { name: string }[]).map((c) => c.name);
        const rows = db.prepare(`SELECT * FROM ${s.t}`).all() as Record<string, unknown>[];
        if (rows.length) {
          const ins = db.prepare(`INSERT INTO ${s.t}__new (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
          for (const row of rows) {
            const vals = cols.map((c) => {
              const v = row[c];
              if (v == null) return v;
              if (s.hasId && c === 'id') return maps[s.t].get(v);
              const ref = s.fks[c];
              if (ref) {
                const mapped = maps[ref].get(v);
                if (mapped === undefined) throw new Error(`0030: dangling FK ${s.t}.${c} -> ${ref}:${String(v)}`);
                return mapped;
              }
              return v;
            });
            ins.run(...vals);
          }
        }

        db.exec(`DROP TABLE ${s.t};`);
        db.exec(`ALTER TABLE ${s.t}__new RENAME TO ${s.t};`);
        for (const ix of indexes) db.exec(ix);
      }

      // Atomic gate: no dangling references after the remap.
      const problems = db.prepare('PRAGMA foreign_key_check').all();
      if (problems.length) throw new Error(`0030: foreign_key_check found ${problems.length} violation(s)`);
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
