# Backing up the learning-evidence tables: investigation and design (2 Nov 2026)

**Status: not built, on purpose.** The request was to add the learning-evidence tables to the JSON export
(`GET /api/export`, `POST /api/import` in `server/src/routes/backup.ts`) because "a restore resets" them. The
investigation showed that premise is mostly wrong and the benefit narrow, and the work was dropped. This file
keeps the findings and the design so nobody has to redo them. Nothing here changes code.

## What the investigation found

- **A restore does not reset these tables today.** The 14 tables below each have one foreign key, `owner_id` to
  `owners(id) ON DELETE CASCADE`, and none to tasks or time blocks. `purgeOwnerData` (`server/src/lib/owners.ts`),
  the teardown the import runs first, names none of them. Run against a migrated scratch database, every one of
  the 14 kept its rows. A restore into the same install therefore leaves them as they are.
- **They are lost only in one case:** the destination owner's tables are empty and the owner id matches the
  backup's. Import returns 403 for any other owner id, and account owners get a new id on each install
  (`lib/owners.ts`), so the case is reachable mainly with `AUTH_MODE=test` (the default), which uses the fixed
  `SYSTEM` owner id. A cross-account restore would need an id-remap feature, which this does not add.
- **The full-database snapshot already carries them.** `lib/backup.ts` (`.backup()`) and `scripts/restore.ts` copy
  every table. Only the JSON export drops them.
- **The change as first asked would regress the common case.** Exporting the 14, purging them and re-inserting
  them rolls a same-install restore of an old backup back: in the test each table went from 4 rows to 2. Restoring
  a version-12 backup (no evidence keys) onto live evidence would delete all 14 tables and still report success.
  The existing round-trip tests all call `resetDb()` between export and import, so they model a fresh database and
  cannot see this.
- **It is not mechanical.**
  - `classification_exemplars.embedding` and `possible_dismissal_exemplars.embedding` are the only BLOB columns in
    the schema. `JSON.stringify` turns a Buffer into `{type:'Buffer',data:[...]}`, binding that throws, and one
    exemplar row makes the whole import return 500 and roll back.
  - A synthetic heavy two-year owner exports about 14.5 MB today and about 40.7 MB with all 14 tables (embeddings
    as base64), against the 20 MB import limit (`app.ts`, `bodyParser({ jsonLimit: '20mb' })`). A typical owner:
    3.4 MB now, 11 MB with all 14. The sizes are synthetic rows times the code's caps, not a production database.

## The 14 tables

| Table | Kind | Why it matters |
| --- | --- | --- |
| `classification_log`, `possible_outcome_log`, `placement_log`, `plan_loop_runs`, `plan_revision_log`, `triality_log` | primary evidence | Events that cannot be regenerated. |
| `classification_accuracy`, `possible_dismissal_rate`, `placement_survival`, `plan_loop_stats` | dated measurement | Computed with that day's data and model; a past day cannot be recomputed. |
| `classification_exemplars`, `possible_dismissal_exemplars`, `placement_preferences`, `triality_weights` | derived state | Rebuilt by the next weekly job; carrying them gives day-one behaviour after a restore. |

`plan_revision_log` has no reader in the code today. Already exported: `estimate_calibration`,
`calibration_history`, `calibration_combo_pins`, `balance_week_log`.

## The design that would work

Invariant: **a restore may add evidence the target lacks and may never delete evidence or make an existing row
older or smaller.**

- **Never purge these tables.** `purgeOwnerData` stays as it is (add a comment saying why), and deleting an owner
  still removes them through the `owners` cascade.
- **Logs and dated measurements:** `INSERT ... ON CONFLICT DO NOTHING`. Not `INSERT OR IGNORE`, which silently
  drops a row that violates NOT NULL and still reports success. Not `INSERT OR REPLACE`, which reverts one-shot
  stamps.
- **One-shot stamps** (`classification_log.final_value`/`corrected_at`, `placement_log.moved_*`,
  `triality_log.outcome`/`outcome_at`): fill in from the backup only where the target is still unstamped, all paired
  columns together, with `AND owner_id = ?` on the update (an unguarded form overwrote another owner's row in a
  scratch check).
- **Derived state:** insert only if the owner has no row in that table, so aged-out exemplars do not return and
  newer bands and weights are not overwritten.
- **Absent or empty key:** a no-op, so every version 6 to 12 backup leaves the evidence untouched.
- **BLOBs:** export as `{"$base64":"..."}`; on import decode only into BLOB-typed columns, with a strict
  pattern and length check (Node's decoder accepts garbage), and answer 400 for anything else. 600 real
  768-dimension vectors round-tripped byte for byte in a scratch run.
- **Version 13**, with `'13'` added to `RESTORABLE_VERSIONS`, so an older build refuses the file instead of
  silently dropping the evidence. Update the version pins in `export-import.test.ts`, `tags-owner.test.ts` and
  `time-blocks-owner.test.ts`.
- **Size:** a finite 64 MB limit on `POST /api/import` only. The global parser (`app.ts:88`) runs before
  `requireAuth` and `koa-bodyparser` skips a body that is already set, so a route-level parser would never run; the
  global one needs a wrapper that skips `POST /api/import`. Export `placement_log` with a filter that drops rows that
  can never count (`fit = 0`, or unmoved with the block gone). No windowing and no trimming of the logs.
- **Not in `OWNER_TABLES`:** a separate `EVIDENCE_TABLES` list, so the generic loop does not select
  `placement_log` twice. Evidence rows must share one key set (`insertRows` takes its columns from the first row).
- **Counts** come from `run().changes`, not `rows.length`.

### Tests the design calls for

Same-install restore of an old dump without `resetDb()` (logs stay, mutated rows keep the newer state, rollups keep
the newer values); fresh-install round trip of all 14 with embeddings byte-equal and NULLs kept; v12 and v8 dumps
leave live evidence untouched; stamp fill-in one-directional, paired and owner-guarded; rollups only into an empty
table; measurement collisions keep the target; BLOB codec strictness and atomicity; a NOT NULL violation aborts the
whole import; tenant isolation; idempotent re-import; the `placement_log` export filter; `purgeOwnerData` and
`deleteOwner` contract; the import body limit through the real app; version handling; and a schema-scan coverage
guard (every `owner_id` table is exported, excluded with a reason, or a named known gap).

## Neighbouring problems found, not part of this

- `balance_week_log` is exported **and** purged on restore (`owners.ts:282`), so a same-install restore already
  rolls it back, and frozen weeks cannot be rebuilt. `estimate_calibration` is purged and replaced the same way.
- `connection_prefs` has an `owner_id` and is in no export, exclusion or purge list. Deleting an owner who has a row
  fails with a foreign-key error (reproduced in a scratch database).
- The audit comment at `routes/backup.ts:121-141` says it covers migrations 0001 to 0114 and lists `auth_states`,
  which has no `owner_id` column.

## Not verified

The guarded stamp update and the whole import with the new tables were run on patched copies of `backup.ts`, not
through the real route. The body-parser wrapper is reasoned from the code, not run. Peak memory of a 40 to 64 MB
import was not measured (wall time was about 1 s), nor browser behaviour for a 15 to 40 MB file. No production
database was inspected. Whether other auth modes keep an owner id across installs was not checked, and that decides
how often the fresh-install case happens. Postgres was not examined (the baseline stops at migration 0147).
