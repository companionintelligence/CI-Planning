# Handoff — Phase T (multi-tenant) in progress: T0 / T3 / T4 done → T1 next

**Written 2026-07-02.** A session-continuity handoff. Read this, then `git fetch origin main` and re-verify the head before doing anything (see Gotcha #1). Companion to [T-multi-tenant-users.md](T-multi-tenant-users.md) (design + decisions), [T-multitenant-tickets.md](T-multitenant-tickets.md) (the ticket board T0–T5 + a ranked gaps/faults audit), and [recap_state_A-S.md](recap_state_A-S.md) (§8 = the multi-tenant ledger).

---

## 1. Current state (verify, don't trust)

- **`main` migration head: `0098_sync_events_owner_fk`.** Verify: `git fetch origin main && ls server/src/db/migrations/ | grep -E '^[0-9]{4}_' | sort | tail -1` → `0098_sync_events_owner_fk.ts`.
- **Phase T locked order: `T0 → T3 ∥ T4 → T1 → T2 → T5`.** Decisions (owner-locked 2026-07-02): **#1 Option A** — tenant = user; `owners` **is** the user table, auth columns get added to it; no `tenants`/`memberships`. **#2 keep `owners`** — no rename to `users`. **#3** (exact `owners` auth columns) is deferred to **Phase U**.
- **T0, T3, T4 are merged.** T1 is next (the heaviest ticket), then T2, then T5 (with U).
- ⚠️ **The local dev env CANNOT run the DB-backed test suite.** It's Node **v24.3.0** and `better-sqlite3` won't load (repo wants Node ≥26). What DOES run locally: `pnpm --filter server exec tsc --noEmit` (typecheck) and **no-DB** vitest files (`owner-literals.test.ts`, `context-strict.test.ts`). Anything importing `server/src/db/index.js` (i.e. every DB test) does **not** load. **CI is the gate for DB-backed tests — expect to iterate on CI**, as this session did.

---

## 2. What shipped (T0 / T3 / T4 — all merged to `main`)

- **T0 — multi-tenant test & enforcement scaffolding (PR #218).** No migration.
  - `currentOwnerId()` (`server/src/lib/context.ts`) now **throws** outside a `runWithOwner` context when `NODE_ENV !== 'test'` (keeps the `SYSTEM_OWNER` fallback under test). **Every owner-scoped read/write must run inside `runWithOwner`** — a request (via `requireAuth`) or a cron/job (via the dispatcher).
  - `requireAuth` honors an **`x-test-owner`** header **in test mode only** — lets a test drive a request as a 2nd owner.
  - `server/test/helpers.ts`: **`createOwner(id?, name?, tz?)`** / `seedSecondOwnerData()` + `SECOND_OWNER_ID`. `createOwner` clones the system owner's `scheduling_prefs` row **with a fresh `id`** (see Gotcha #4). `resetDb()` now clears `sync_events` and **prunes non-system owners** (no cross-file leak in the shared pid-keyed DB).
  - grep-gate (`server/test/owner-literals.test.ts`) widened to `src/services` + `src/jobs` and now forbids the `SYSTEM_OWNER` sentinel in `routes/engine/agents/services` — **`jobs/` is exempt** (the cron dispatcher legitimately binds it, until T3 fully lands — now merged, but the global-kind branch still uses it).
  - Tests: `context-strict.test.ts` (pure-JS), `owner-scaffolding.test.ts` (DB).
- **T3 — cron per-owner fan-out (PR #220).** No migration.
  - `server/src/jobs/index.ts`: `startCronJobs` fans **owner-scoped kinds** out over `SELECT id FROM owners` via the exported **`runScheduledJob(kind)`** (each owner inside its own `runWithOwner`, so `currentOwnerId()`/SSE-broadcast/audit target that owner). **Global kinds** run once: `review_day`, `fire_reminders` (they iterate owners internally), `snapshot_db`, `prune_sync_events`. `prune_sync_events` now prunes **all** owners by age (dropped the owner predicate). `runJob` audits under `currentOwnerId()`. **Manual `POST /api/jobs/:id/run` stays single-owner** (calls `runJob` directly under the requesting owner). Test: `jobs-multiowner.test.ts`.
- **T4 — `sync_events.owner_id` → real FK (PR #219).** Migration **`0098_sync_events_owner_fk`** (`rebuildTable`, `manual`; recreates the `sync_events_owner_seq (owner_id,seq)` index; **no** `ON DELETE CASCADE`). `schema.ts` `.references(() => owners.id)` + a documenting comment on `possible_tasks.proposed_owner_id` (documented, not renamed). Test: `sync-events-schema.test.ts`.

*Also merged earlier this session (context):* A–S archival + `recap_state_A-S.md` (#213); Phase-T design + tickets (#214); **backup export-completeness fix (#215** — added the omitted owner-scoped tables to export/import, **`EXPORT_VERSION` → `'4'`**, closed gap G-EXPORT-MISSING); doc-staleness fixes (#216); Phase-Y `.env.example` completion (#217).

---

## 3. NEXT — T1 (owner-scope `time_blocks`), then T2, then T5

Full spec: [T-multitenant-tickets.md](T-multitenant-tickets.md) ticket **T1** + the gaps section. **T1 is the heaviest ticket in the phase.** Key points a follower must not miss:

- **Migration number: T1 is now `0099`** (T4 took `0098`). ⚠️ The tickets/design docs still say T1=`0098` — **renumber to `0099`** (T2 → `0100`). Verify head first (`0098`).
- **Two-phase `NOT NULL` rebuild (fault F-REBUILD):** `rebuildTable`'s `INSERT..SELECT` copies only shared columns → it **cannot** populate a brand-new `NOT NULL owner_id` in one pass. Create `owner_id` **nullable**, backfill `owner_id = COALESCE((SELECT t.owner_id FROM tasks t WHERE t.id = time_blocks.task_id), (SELECT id FROM owners LIMIT 1))` (container/synced blocks have `task_id` NULL → the single owner), **then** tighten to `NOT NULL` (second rebuild or a hand-written 12-step). `time_blocks` has **6 inbound FKs + a self-ref + ~30 columns + 6 indexes** — reproduce ALL of them, and add `PRAGMA foreign_key_check` (rebuildTable doesn't). Precedent for the T0 PK-collision trap applies (Gotcha #4).
- **~24 reader/writer files** to owner-scope (all enumerated in the ticket): `routes/blocks.ts` (range read **and every by-id** SELECT/UPDATE/DELETE — move-group, promote, clear-day, delete-by-recurrence-parent), `engine/{autoplan,blocks-place,blocks-recur,clear-range,patterns-place,reminders,review,scheduler,auto-defense}.ts`, `routes/{block-templates,plan}.ts`, `agents/sync.ts`, `services/{block-task-sync,timer}.ts`, `scripts/seed-test-data.ts`. ~13 raw `INSERT INTO time_blocks` sites all need `owner_id`.
- **Subtle regressions to guard (from the investigation):** `auto-defense.snapshotAutoBlocks` (F-REFLOW — an unscoped `reflow` would *corrupt* another owner's overlapping blocks), `blocks-recur`'s global template SELECT (G-RECUR — a GET would materialize another owner's recurring series), the by-id block mutations (G-BYID).
- **`backup.ts` gate, same PR (`server/src/routes/backup.ts`, NOT `lib/backup.ts`):** add `time_blocks` to `OWNER_TABLES`; owner-scope its export `SELECT` + restore `DELETE FROM time_blocks`; and **fix the `entity_tags` restore UNION → `UNION SELECT id FROM time_blocks WHERE owner_id = ?`** (F-ETAGS — a genuine cross-tenant `entity_tags` wipe, not a "re-verify"). Bump `EXPORT_VERSION` (`'4'` → `'5'`). **Match by symbol, not line** (#215 shifted the line numbers).
- **`applyOp` block owner-check (`server/src/sync/apply.ts`):** add `|| op.entity === 'block'` to the owner-isolation guard (closes **L Gap 5**) now that `time_blocks` will have `owner_id`. Keep `owner_id` **out** of `BLOCK_FIELDS`.
- **Tests use T0's scaffolding:** `createOwner()` + `runWithOwner`/`x-test-owner` for isolation. Note route-level owner-isolation isn't HTTP-testable in test mode (test-mode pins `SYSTEM_OWNER`) — do it at the service layer or via the `x-test-owner` header.

- **T2 (tag axis, migration `0100`)** — after T1 (co-edits `blocks.ts`; `entity_tags` completes once `time_blocks.owner_id` exists). Adds `tags.owner_id` + **`UNIQUE(owner_id, name)`** (F-TAGUNIQUE — `tags.name` is globally UNIQUE today, a blocker), owner-scopes **~a dozen owner-blind readers** (`services/tags.ts` `resolveTagId`/`findTag`/`makeTag` by name, `routes/tags.ts` GET/name-clash, `engine/autoplan.ts` pattern-tag reads, and the LLM vocab in `auto-tag`/`plan`/`ingest`/`tasks`), junctions scope-via-parent, and needs **per-owner base-tag provisioning** (owner #2 gets zero `Home/Work/Community` today — G-BASETAG, owned by T5/U).
- **T5 (owners auth columns + GLOSSARY)** — with Phase U.

---

## 4. Conventions (learned / confirmed)

- **Migrations** `server/src/db/migrations/NNNN_name.ts`, forward-only + idempotent, **registered in `migrations/index.ts`** (`import * as mNNNN from './NNNN_name.js'` — note `.js` — + append to `MIGRATIONS`). Rebuilds/retypes use `export const manual = true` + the shared **`rebuildTable`** (`server/src/db/migrate.ts`); add `PRAGMA foreign_key_check` yourself. The `baseline.characterization` golden captures **column names only** — a rebuild that preserves the column set/order needs **no** golden update; any real schema change → regenerate deliberately (`vitest run baseline.characterization -u`) and eyeball.
- **Backup/export** = **`server/src/routes/backup.ts`** (`lib/backup.ts` is only the DB-file snapshot). `OWNER_TABLES` list + `EXPORT_VERSION` (now `'4'`). The owner-less-table wipes on restore are the multi-tenant correctness/security gate — fix them **in the same PR** as each `owner_id` addition.
- **Owner scoping:** `currentOwnerId()` / `runWithOwner` / `SYSTEM_OWNER` (`server/src/lib/context.ts`). `SYSTEM_OWNER_ID` = `00000000-0000-7000-8000-000000000001`. grep-gate: `server/test/owner-literals.test.ts` (integer literals in routes/engine/agents/services/jobs; `SYSTEM_OWNER` forbidden in routes/engine/agents/services, `jobs/` exempt).
- **Tests:** sequential, pid-keyed shared SQLite DB, migrations-on-import. **Always `TZ=UTC` and pin dates** (the repo's #1 flake source). `resetDb()` prunes non-system owners; use `createOwner()` for a 2nd owner.

---

## 5. Gotchas (session-specific — avoid repeating)

1. **Verify merge/branch state — don't trust reports.** "Merged X" and the live GitHub state have diverged repeatedly this session (a merge that didn't complete; a stale local `main`). ALWAYS `git fetch origin main` + `gh pr view <n> --json state,mergedAt` before building on top. #219/#220 were reported merged twice before they actually landed.
2. **Copilot Autofix** pushes `"Potential fix for pull request finding"` commits directly onto open PR branches (authored under the repo owner's GitHub account) and re-triggers CI. **Review every one.** Mostly benign this session (T3 got a good per-owner `try/catch`; T4 a comment fix) — but earlier it "resolved" the T1/T2 order contradiction the **wrong** way (kept T2→T1). Reconcile, don't assume.
3. **Migration numbering vs the order flip.** The build order (`T3 ∥ T4 → T1 → T2`) differs from the doc's originally-reserved numbers. T4 took `0098`; **T1 = `0099`, T2 = `0100`**. Two migration-bearing PRs in parallel **conflict in `migrations/index.ts`** (both append) — serialize migration PRs, and always claim the next free number after re-verifying head.
4. **`createOwner`/prefs-clone PK trap.** `scheduling_prefs`'s primary key is the **surrogate `id`** (`$defaultFn(newId)`), NOT `owner_id`. Cloning a prefs row must map `id → uuid7()`; copying the source `id` PK-collides and `INSERT OR IGNORE` swallows it silently (this was T0's one CI failure). The same "what's the real PK?" check applies to any T1/T2 rebuild.
5. **`currentOwnerId()` now fails loud** outside a `runWithOwner` scope in non-test builds. Great for catching missing wrappers — but any NEW unwrapped owner-scoped path (a boot-time query, a script, an un-wrapped helper) will throw in prod. The CI container smoke boots the app in non-test mode and exercises this, so a missing wrapper reddens CI.
6. **Stacked-PR trap (from the S phase).** A PR whose base is a feature branch merges into *that branch*, not `main`. Prefer `main`-based PRs; after each merge verify the content actually reached `main` (`git ls-tree origin/main -- <path>` exits 0 even for a missing path — grep the content).

---

## 6. Verification discipline that worked (reuse it)

- **Adversarial investigation before writing tickets/code:** a fan-out workflow that maps the real reader surface + hunts gaps/faults, each claim verified against live code. It caught the T3 mis-scoping (no cron iterated owners), `tags.name` global UNIQUE, the `rebuildTable` NOT-NULL limitation, and the `entity_tags` backup UNION — *before* any code.
- **Per PR:** implement → local `tsc` + no-DB vitest → push → **watch CI** → fix. CI is the real gate for DB tests. T0 took one CI fix (the PK collision); T3/T4 were first-pass green.
- Small, `main`-based PRs; verify each reached `main`.

---

## 7. Map of where things live

- **Specs / handoffs:** [T-multitenant-tickets.md](T-multitenant-tickets.md) (T0–T5 tickets + ranked gaps/faults — the primary build reference), [T-multi-tenant-users.md](T-multi-tenant-users.md) (design + decisions + PR order), [recap_state_A-S.md](recap_state_A-S.md) (§8 multi-tenant ledger; §5 auth ledger for U; §6 env for Y), [HANDOFF-multitenant.md](HANDOFF-multitenant.md) (the Q/S→T kickoff), this doc.
- **As-built refs:** [../ARCHITECTURE.md](../ARCHITECTURE.md), [../README.md](../README.md), [GLOSSARY.md](GLOSSARY.md).
- **Code:** `server/src/lib/context.ts` (owner resolver + the new throw), `server/src/jobs/index.ts` (cron fan-out — `runScheduledJob`/`OWNER_SCOPED_KINDS`), `server/src/routes/backup.ts` (the multi-tenant gate + `OWNER_TABLES`/`EXPORT_VERSION`), `server/src/sync/apply.ts` (owner-isolation guard — L Gap 5), `server/src/db/migrate.ts` (`rebuildTable`), `server/test/helpers.ts` (`createOwner`/`resetDb`).

---

## 8. First moves for the follower

1. `git fetch origin main`; confirm head `0098`. Assume you **can't** run the DB suite locally (Node 24) — rely on `tsc` + no-DB vitest + CI.
2. Read [T-multitenant-tickets.md](T-multitenant-tickets.md) ticket **T1** + the gaps section (F-REBUILD, F-REFLOW, F-ETAGS, G-BYID, G-RECUR). Cut `claude/phase-t1-time-blocks` off `origin/main`; migration **`0099`**.
3. Build **T1** (the two-phase `time_blocks` rebuild + all ~24 readers + the `backup.ts` gate + the `applyOp` block guard + isolation tests using T0's `createOwner`). Push → watch CI → iterate. Keep it one coherent PR (migration + scoping + backup gate + guard, per the ticket's DoD).
4. Then **T2** (`0100`, tag axis — start with the `UNIQUE(owner_id,name)` blocker + the reader inventory), then **T5** (owners auth columns, jointly with Phase U).
