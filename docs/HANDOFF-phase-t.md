# Handoff — Phase T (multi-tenant) NEARLY DONE: T0–T4 + T1 + T2 merged → only T5 (with Phase U) remains

**Updated 2026-07-02** (supersedes the T0/T3/T4-done version). A session-continuity handoff. Read this, then `git fetch origin main` and **re-verify the head** before doing anything (Gotcha #1). Companion to [T-multi-tenant-users.md](T-multi-tenant-users.md) (design + decisions), [T-multitenant-tickets.md](T-multitenant-tickets.md) (ticket board T0–T5 + ranked gaps/faults — but see the ⚠️ staleness note below), and [recap_state_A-S.md](recap_state_A-S.md) (§8 = MT ledger; §5 = auth ledger for U).

---

## 1. Current state (verify, don't trust)

- **`main` migration head: `0100_tags_owner_id`.** Verify: `git fetch origin main && ls server/src/db/migrations/ | grep -E '^[0-9]{4}_' | sort | tail -1` → `0100_tags_owner_id.ts`.
- **Phase T order: `T0 → T3 ∥ T4 → T1 → T2 → T5`. All owner-LESS tables are now owner-scoped — only T5 remains, and T5 is the schema half of Phase U (not a standalone build).**
- Owner decisions (locked 2026-07-02): **#1 Option A** — tenant = user; `owners` **is** the user table; no `tenants`/`memberships`. **#2 keep `owners`** (no rename to `users`). **#3 exact `owners` auth columns** — deferred to Phase U (T5 reserves them jointly with U).
- ⚠️ **Local dev env CANNOT run the DB test suite.** Node **v24.3.0**; `better-sqlite3` won't load (repo wants Node ≥26). Locally you get `pnpm --filter server exec tsc --noEmit` + the no-DB vitest files (`owner-literals.test.ts`, `context-strict.test.ts`). **CI is the gate for every DB test — expect to iterate on CI.**

---

## 2. What shipped (ALL merged to `main`)

| Ticket | PR | Migration | Summary |
|---|---|---|---|
| **T0** scaffolding | #218 | — | `currentOwnerId()` throws outside `runWithOwner` in non-test; `requireAuth` honors `x-test-owner` in test mode; `createOwner()`/`SECOND_OWNER_ID`/`resetDb()` prune non-system owners; grep-gate widened (`owner-literals.test.ts`). |
| **T3** cron fan-out | #220 | — | `startCronJobs` fans owner-scoped kinds over `SELECT id FROM owners` via `runScheduledJob`; global kinds (`review_day`/`fire_reminders`/`snapshot_db`/`prune_sync_events`) run once; manual `/run` stays single-owner. |
| **T4** sync_events FK | #219 | `0098` | `sync_events.owner_id` → real FK (`rebuildTable`, no cascade). `possible_tasks.proposed_owner_id` documented, not renamed. |
| **T1** time_blocks | #222 | `0099` | `time_blocks.owner_id NOT NULL REFERENCES owners(id) ON DELETE CASCADE`, **single-pass hand-written rebuild** with the `COALESCE(task-owner, single-owner)` backfill inlined in `INSERT..SELECT` (F-REBUILD: `rebuildTable` can't populate a new NOT NULL col in one pass); all 6 indexes + `ix_time_blocks_owner_start`; `foreign_key_check`. **~30 readers/writers** owner-scoped. **F-REFLOW** (`auto-defense.snapshotAutoBlocks`) + **G-RECUR** (`blocks-recur` template SELECT) fixed. `backup.ts` gate (F-ETAGS UNION, `EXPORT_VERSION '4'→'5'`). `apply.ts` block owner-check (**L Gap 5**). |
| **T2** tag axis | #223 | `0100` | `tags.owner_id NOT NULL` + **`UNIQUE(owner_id, name)` replacing the global `UNIQUE(name)`** (F-TAGUNIQUE), single-owner backfill. By-NAME resolution (`resolveTagId`/`findTag`/`makeTag` + `syncEntityTags`/`syncLeveledEntityTags`) threads owner; by-ID taxonomy funcs stay owner-agnostic — **ownership enforced at the `routes/tags.ts` boundary** (404 foreign). LLM vocab readers (`tasks`/`auto-tag`/`plan`/`ingest`) were cross-tenant prompt leaks, now scoped. `backup.ts` (tags→`OWNER_TABLES`, junctions scope-via-parent, owner-scoped tags wipe, `EXPORT_VERSION '5'→'6'`) — **this COMPLETES entity_tags restore-isolation**. |

**As-built migration numbers: T1 = `0099`, T2 = `0100`** (the ticket board still says T1=`0098`/T2=`0099` — stale, see §5).

---

## 3. NEXT (and LAST) — T5: `owners` auth columns + `GLOSSARY`, JOINTLY WITH PHASE U

Full spec: [T-multitenant-tickets.md](T-multitenant-tickets.md) ticket **T5** + [T-multi-tenant-users.md](T-multi-tenant-users.md) §0 decision #3. **T5 is not a standalone ticket — it's the schema groundwork for Phase U (OIDC + local auth). Do it when you start U, coordinating the exact column set.** Login/token behavior is U's, not T5's.

- **`owners` today** = `id`, `name`, `email`, `last_auto_run_id` (`schema.ts:8-13`); one row — the `SYSTEM_OWNER_ID` sentinel (`00000000-0000-7000-8000-000000000001`, seeded `'Liam'`).
- **T5 adds** (all nullable; confirm the final set with U before writing): `external_subject TEXT UNIQUE` (OIDC `sub`), `username TEXT UNIQUE`, `password_hash TEXT` (argon2id). Additive `ALTER ADD COLUMN` — **no rebuild needed** (unlike T1/T2). Next migration number after `0100` — verify head first.
- **`GLOSSARY.md`**: define **owner ≡ user** (decision #2 makes this canon).
- **N-SENTINEL**: the sentinel row will have NULL auth columns — **U's auto-provision/login must EXCLUDE it** (a real signup can't reproduce its zero-timestamp id, so no collision, but never treat the sentinel as a login identity).
- **G-BASETAG (now a CONCRETE blocker T1+T2 created)**: base tags (`home`/`work`/`community` + `family`/`social`/`me`, `is_base=1`) are seeded **once globally** (migrations 0036/0069) and — after 0100's backfill — all belong to the SYSTEM owner. **A newly-provisioned 2nd owner gets ZERO base tags → Auto silently places nothing for them, and they have no Home/Work/Community.** Owner-creation (T5/U) MUST seed per-owner base tags. This is the single most important cross-cutting follow-up; wire it into whatever creates a new owner.

**Everything else in Phase T is done.** The owner-less tables (`time_blocks`, the tag axis, `scheduled_jobs` runner, `sync_events`) are all scoped. Client needs zero changes (N-CLIENT — it sends no `owner_id`, refetches on import).

---

## 4. Conventions (confirmed across T0–T2)

- **Migrations** `server/src/db/migrations/NNNN_name.ts`, forward-only + idempotent, **registered in `migrations/index.ts`** (`import * as mNNNN from './NNNN_name.js'` — note `.js` — + append to `MIGRATIONS`). A NOT-NULL/UNIQUE/retype change = a rebuild: `export const manual = true`, hand-write the 12-step (create `_new`, `INSERT..SELECT` with any backfill INLINED, drop, rename, recreate indexes), add `PRAGMA foreign_key_check` yourself. T1's `0099` + T2's `0100` are the reference examples. **T5 is additive (`ALTER ADD COLUMN`) — no rebuild.**
- **The `baseline.characterization` golden** (`server/test/__snapshots__/…`) captures table + column names in **physical (PRAGMA) order**. Adding a column changes it. **You can't regenerate it locally (Node 24)** — hand-edit the `.snap`: the committed file IS the ground truth for the current physical column order; insert the new column at the position your `createNewSql` places it. (An agent's reconstructed column order is often LOGICAL, not physical — trust the `.snap`.) Also extend `server/test/schema-parity.test.ts` (add a `getTableColumns(x)` vs `PRAGMA table_info(x)` block for the newly-scoped table).
- **Backup/export gate** = **`server/src/routes/backup.ts`** (`lib/backup.ts` is only the DB-file snapshot). Owner-scope export + restore-wipe **in the same PR** as any `owner_id` addition; `OWNER_TABLES` for direct-owner tables, `WHERE parent_id IN (SELECT id FROM parent WHERE owner_id=?)` for junctions. **Bump `EXPORT_VERSION` (now `'6'`)** on any owner_id-column PR — a stale export lacks the new required column, so the version check must reject it. Grep `test/` for hardcoded version assertions (`export-import.test.ts` + the phase's own backup test) each bump.
- **Owner scoping:** `currentOwnerId()` / `runWithOwner` / `SYSTEM_OWNER` (`server/src/lib/context.ts`). grep-gate `server/test/owner-literals.test.ts` forbids integer-`1` / `SYSTEM_OWNER` literals in `routes/engine/agents/services` (`jobs/` exempt; `scripts/` NOT scanned — scripts legitimately use `SYSTEM_OWNER`/`SYSTEM_OWNER_ID`).
- **Tests:** sequential, pid-keyed shared SQLite DB, migrations-on-import. **Always `TZ=UTC`, pin dates.** `resetDb()` prunes non-system owners + wipes `time_blocks`/`tags`/etc.; use `createOwner()` + the `x-test-owner` header (test mode) for a 2nd owner.

---

## 5. Gotchas & build lessons (proven across T0–T2 — do not relearn)

1. **Verify merge/branch state — don't trust reports.** ALWAYS `git fetch origin main` + `gh pr view <n> --json state,mergedAt`; after a merge, confirm the content reached `main` (`git ls-tree origin/main -- <path>` exits 0 even for a missing path — grep the content).
2. **Ticket reader-lists ALWAYS undercount.** T1: ~30 files, not the ticket's ~24 (missed `summarize`/`weekly-review`/`patterns`/`objectives`/`summary`/`sync`-outbound). T2: the "~dozen" missed `pattern-blocks`/`pattern-prefs`/`category-prefs`/`possibles` + more. **Run a repo-wide grep for the table name yourself** — raw SQL (`FROM|INTO|UPDATE|JOIN <table>`) AND the Drizzle symbol (`.from(x)`/`.insert(x)`/`x.` usage). The adversarial-mapping workflow also undercounted; the grep is the backstop.
3. **`tsc --noEmit` only checks `src/**` — NOT `test/`** (tsconfig `include: ["src/**/*"]`; tests are vitest/esbuild-transpiled, no type-check). So changing an exported function's signature (e.g. adding a required `owner`) type-errors `src` callers (great tripwire) but **silently passes test-file callers → they blow up at CI runtime** (T2: `entity-tags.test.ts` called `syncEntityTags` with the old 3-arg form → `NOT NULL` at runtime). **After any exported-signature change, `grep test/` for callers by hand.**
4. **A NOT NULL column add breaks ~25–35 existing tests' raw inserts** (they omit the new col). Fan out a workflow (one agent per ~4-file batch: append the column + bind `SYSTEM_OWNER` for shared-DB tests / `SYSTEM_OWNER_ID` for fresh-DB migration tests). **But grep for the file list yourself** — the mapping workflow undercounts test files too.
5. **Historical migrations that INSERT into a table a LATER migration makes NOT NULL** break when a test REPLAYS them on the evolved schema (T2: `tag-directions.test.ts` replays `0036.up()` on the post-0100 DB → `NOT NULL owner_id`). Fix: guard the historical migration's insert to supply the new col ONLY when it exists (`cols.includes('owner_id')`). Real forward chain unaffected (col absent then); replay-safe; migration's historical effect unchanged. (See `0036_tag_directions.ts`.)
6. **Copilot Autofix** pushes `"Potential fix for pull request finding"` commits onto open PR branches and re-triggers CI. **Review every one — reconcile, don't assume.** On #222 it added two GOOD fixes (rescheduleTask tasks-UPDATE owner scope; an upfront ownership check in `blocks.ts` DELETE before `pushOutboundDeletes`) but also **deleted a `REQ2` comment line** (T2 restored it). #223 had none.
7. **`createOwner`/prefs-clone PK trap.** `scheduling_prefs`'s PK is the surrogate `id` (`$defaultFn(newId)`), NOT `owner_id` — cloning must remap `id → uuid7()`. The same "what's the real PK / physical column order?" care applies to any rebuild.
8. **`currentOwnerId()` fails loud** outside `runWithOwner` in non-test builds. Any new unwrapped owner-scoped path (boot query, un-wrapped script/helper) throws in prod and reddens the CI container smoke. Boot-time cross-owner sweeps (e.g. `auto-defense.recoverStaleFreezeLocks`) are intentionally global — don't `currentOwnerId()` them.

---

## 6. Verification discipline that worked (reuse it)

- **Adversarial fan-out investigation BEFORE writing code:** map the real reader surface + hunt gaps/faults, each claim verified against live code + the `.snap`. Caught F-REBUILD, F-REFLOW, G-RECUR, F-TAGUNIQUE, the boundary-vs-thread-everywhere tag architecture, and the entity_tags-cascade nuance before any code.
- **Per PR:** implement → local `tsc` + no-DB vitest + grep-gate → push → **watch CI** (`gh pr checks <n> --watch`) → read `--log-failed`, fix, re-push. T1 + T2 each took exactly one CI iteration (a stale version assertion / stale test callers). Small, `main`-based PRs; verify each reached `main`.

---

## 7. Map of where things live

- **Specs:** [T-multitenant-tickets.md](T-multitenant-tickets.md) (T0–T5 + gaps — ⚠️ its T1/T2 migration numbers + reader counts are stale; as-built is T1=`0099`/T2=`0100`, ~30 readers), [T-multi-tenant-users.md](T-multi-tenant-users.md) (design + decisions), [recap_state_A-S.md](recap_state_A-S.md) (§8 MT ledger, §5 auth ledger for U, §6 env for Y), [HANDOFF-multitenant.md](HANDOFF-multitenant.md) (Q/S→T kickoff), this doc.
- **As-built code (the owner-scoping pattern to copy for T5/U):** `server/src/lib/context.ts` (owner resolver), `server/src/db/migrations/0099_time_blocks_owner_id.ts` + `0100_tags_owner_id.ts` (rebuild + inline-backfill reference), `server/src/db/migrate.ts` (`rebuildTable`), `server/src/routes/backup.ts` (`OWNER_TABLES`/`EXPORT_VERSION '6'`/junction scope-via-parent), `server/src/routes/tags.ts` (boundary-enforcement pattern), `server/src/services/tags.ts` (owner-threaded `resolveTagId`), `server/test/{time-blocks-owner,tags-owner}.test.ts` (isolation-test patterns using `createOwner`/`x-test-owner`), `server/test/helpers.ts`.

---

## 8. First moves for the follower (T5 / Phase U)

1. `git fetch origin main`; confirm head `0100_tags_owner_id`. Assume you **can't** run the DB suite locally (Node 24) — `tsc` + no-DB vitest + CI.
2. **T5 is the schema half of Phase U — read [recap_state_A-S.md](recap_state_A-S.md) §5 (auth ledger: I's unbuilt JWKS PR2, `AUTH_*` env, `external_subject`) and coordinate the exact `owners` column set with the U plan BEFORE writing the migration.**
3. Write the additive migration (next number after `0100`): `ALTER TABLE owners ADD COLUMN external_subject … / username … / password_hash …` (all nullable). No rebuild. Add to `schema.ts:8-13`. `GLOSSARY.md` = owner ≡ user. Backup: `owners` is intentionally EXCLUDED from export (identity spine — see the comment in `backup.ts`); confirm that still holds and bump `EXPORT_VERSION` only if the payload shape changes.
4. **Wire per-owner base-tag provisioning (G-BASETAG) into owner creation** — seed `home`/`work`/`community` (`kind='pattern'`, `is_base=1`) + `family`/`social`/`me` (`kind='category'`, `is_base=1`) for each new owner, or Auto silently no-ops for them. This is the concrete debt T1/T2 left.
5. Tests: use `createOwner()` + `x-test-owner`. Push → watch CI → iterate. Verify content reached `main`.
