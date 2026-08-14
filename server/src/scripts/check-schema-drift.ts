/**
 * Schema drift check — asserts that Drizzle's `schema.ts` (the approved source of
 * truth) still matches what the raw-SQL migration runner actually produces.
 *
 * WHY THIS EXISTS: the two representations had silently diverged — tables lived only
 * in the migrations and were missing from `schema.ts`. This check makes that class of
 * drift something a command reports, instead of something a reviewer has to notice by eye.
 *
 * ⚠️ IT CURRENTLY FAILS, AND THAT IS THE POINT. As of 2026-08-14 it reports **16 tables**
 * present in the migrations but absent from `schema.ts` (`daily_plan`, `objectives`,
 * `reflections`, `triality_log`, `connection_prefs`, …) plus **44 non-fatal warnings** —
 * 24 PRIMARY KEY and 20 NOT NULL mismatches, spread across ~20 tables, concentrated in the
 * composite-PK join tables (`entity_tags`, `entity_categories`, `task_dependencies`,
 * `tag_directions`, …) where `schema.ts` models the key differently from the migration.
 * When this script was first written the missing-table count was 11, so the gap is
 * widening, not stable. It is landed as a DIAGNOSTIC: run it to see the drift. Do NOT wire
 * it into CI until the backlog it reports is cleared, or the build goes red on a
 * pre-existing problem this script only measures.
 *
 * HOW IT WORKS: apply every migration to a throwaway DB, introspect the result,
 * and diff table/column presence against the tables declared in `schema.ts`.
 * Type-affinity and default expressions are intentionally NOT compared (SQLite
 * affinity ↔ Drizzle dataType mapping is fuzzy and would produce false positives);
 * NOT NULL and primary-key membership are reported as warnings, not failures.
 *
 * Run: `pnpm --filter server db:check-drift`  (exits non-zero on drift)
 */
import type BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { openDb } from '../db/open.js';
import { runMigrations } from '../db/migrate.js';
import * as schema from '../db/schema.js';

// Tables that exist in the DB by construction but are not (and should not be)
// modelled in Drizzle.
const IGNORE = new Set(['schema_migrations']);

interface ColInfo { name: string; notNull: boolean; pk: boolean }

function drizzleTables(): Map<string, Map<string, ColInfo>> {
  const out = new Map<string, Map<string, ColInfo>>();
  for (const value of Object.values(schema)) {
    if (!is(value, SQLiteTable)) continue;
    const cfg = getTableConfig(value);
    const cols = new Map<string, ColInfo>();
    for (const c of cfg.columns) {
      cols.set(c.name, { name: c.name, notNull: c.notNull, pk: c.primary });
    }
    out.set(cfg.name, cols);
  }
  return out;
}

function dbTables(db: BetterSqlite3.Database): Map<string, Map<string, ColInfo>> {
  const out = new Map<string, Map<string, ColInfo>>();
  const names = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of names) {
    if (IGNORE.has(name)) continue;
    // PRAGMA takes an identifier, not a bindable parameter, so the name has to be
    // interpolated — quoted as an IDENTIFIER with embedded quotes doubled. These names come
    // from sqlite_master rather than user input, so this is robustness, not a boundary: a
    // table named e.g. `it"s` would otherwise produce a syntax error that reads as drift.
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const info = db.prepare(`PRAGMA table_info(${quoted})`).all() as {
      name: string; notnull: number; pk: number;
    }[];
    const cols = new Map<string, ColInfo>();
    for (const c of info) cols.set(c.name, { name: c.name, notNull: !!c.notnull, pk: c.pk > 0 });
    out.set(name, cols);
  }
  return out;
}

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'drift-'));
  const dbPath = join(dir, 'fresh.db');
  // Route through openDb, not `new BetterSqlite3(...)`: it sets `foreign_keys = ON`, which
  // every writable open site is required to do (see db/open.ts). This is not hygiene here —
  // several migrations are `manual` precisely so they can toggle FKs for a table rebuild, and
  // `rebuildTable` restores `foreign_keys = ON` unconditionally when it finishes. Opening raw
  // meant the run STARTED with FKs off (SQLite's default) and silently flipped to on at the
  // first rebuild, so migrations were applied under a mix of FK states that production never
  // sees — in a script whose whole job is to report what the migrations produce.
  const db = openDb(dbPath);

  const errors: string[] = [];
  const warnings: string[] = [];
  try {
    runMigrations(db);
    const live = dbTables(db);
    const model = drizzleTables();

    // Table-level presence (both directions).
    for (const t of live.keys()) {
      if (!model.has(t)) errors.push(`Table "${t}" exists in migrations but is MISSING from schema.ts`);
    }
    for (const t of model.keys()) {
      if (!live.has(t)) errors.push(`Table "${t}" is declared in schema.ts but does NOT exist after migrations`);
    }

    // Column-level presence + NOT NULL / PK sanity for shared tables.
    for (const [t, liveCols] of live) {
      const modelCols = model.get(t);
      if (!modelCols) continue;
      for (const c of liveCols.keys()) {
        if (!modelCols.has(c)) errors.push(`Column "${t}.${c}" exists in migrations but is MISSING from schema.ts`);
      }
      for (const c of modelCols.keys()) {
        if (!liveCols.has(c)) errors.push(`Column "${t}.${c}" is declared in schema.ts but does NOT exist after migrations`);
      }
      for (const [c, lc] of liveCols) {
        const mc = modelCols.get(c);
        if (!mc) continue;
        if (mc.notNull !== lc.notNull) warnings.push(`NOT NULL mismatch on "${t}.${c}": migrations=${lc.notNull} schema.ts=${mc.notNull}`);
        if (mc.pk !== lc.pk) warnings.push(`PRIMARY KEY mismatch on "${t}.${c}": migrations=${lc.pk} schema.ts=${mc.pk}`);
      }
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  if (warnings.length) {
    console.warn(`\n⚠  ${warnings.length} NOT NULL / PK warning(s) (not fatal):`);
    for (const w of warnings) console.warn('   - ' + w);
  }
  if (errors.length) {
    console.error(`\n✗ Schema drift detected — ${errors.length} error(s):`);
    for (const e of errors) console.error('   - ' + e);
    console.error('\nFix: update server/src/db/schema.ts to match the migrations (Drizzle is the source of truth).');
    process.exit(1);
  }
  console.log('✓ schema.ts matches the migration-produced schema (tables + columns).');
}

main();
