# Phase T — Multi-tenant: ticket board

**Derived from an adversarial code investigation at migration head `0097`** (6 agents, ~200 file reads). Companion to the design doc [T-multi-tenant-users.md](T-multi-tenant-users.md) and [recap_state_A-S.md](recap_state_A-S.md) §8. **Several tickets CORRECT the design doc** — see [§ Gaps, drift, missed opportunities & faults](#gaps-drift-missed-opportunities--faults). Decisions #1 (Option A) + #2 (keep `owners`) are LOCKED.

> **`backup.ts` disambiguation (applies everywhere below):** the export/import/wipe logic is in **`server/src/routes/backup.ts`**. `server/src/lib/backup.ts` is only `snapshot()`/`pruneOldSnapshots()` — unrelated. Line numbers cited are `0097`-current; prefer matching by symbol (`OWNER_TABLES`, `DELETE FROM time_blocks`).

**Recommended PR order:** **T0 → T3 → T4 → T2 → T1 → T5.** (Rationale: T0 unblocks testing; T3 is schema-free and fixes a latent blocker independently; T4 is tiny; **T2/T1 are the two heavy rebuilds** — do the simpler-shaped one that shakes out the migration+backup+test pattern first. The design doc's time_blocks-first order front-loads all risk into the single hardest rebuild; see [Fault F-ORDER](#fault-f-order).) Every PR is `main`-based; verify content reached `main` after each merge.

---

## T0 — Multi-tenant test & enforcement scaffolding (prerequisite, no migration)

**Goal:** make owner-isolation *testable* and *enforceable* before any table is scoped — the current harness cannot do either.

**Before:**
- No 2nd-owner test factory; the only multi-owner tests insert `owners` inline ad-hoc (`server/test/reminders.test.ts:147`, `daily-recap.test.ts:49`).
- `requireAuth` **test-mode always binds `SYSTEM_OWNER`** (`server/src/lib/auth/requireAuth.ts:52-54`) → an HTTP request **cannot** be issued as owner B; route-level isolation is untestable.
- `currentOwnerId()` **silently defaults to `SYSTEM_OWNER` outside any `runWithOwner` context** (`server/src/lib/context.ts:24-26`) → a missing wrapper reads owner #1 with no error.
- The "grep gate" (`server/test/owner-literals.test.ts:10-14,27`) only matches the **integer** literal `1`, scans **only** `src/routes|engine|agents` (NOT `src/services`, `src/jobs`), and never catches a hardcoded `SYSTEM_OWNER` UUID.
- `schema-parity.test.ts:14-22` guards **only `tag_prefs`**; `resetDb()` (`helpers.ts:26-55`) does **not** delete the `owners` table (a seeded 2nd owner leaks across the shared pid-keyed DB into later files).

**After:**
- `createOwner(id?, name?, tz?)` + `seedSecondOwnerData()` exported from `helpers.ts`; `resetDb()` prunes non-`SYSTEM_OWNER` owners (and clears the tag/junction/sync_events tables it currently omits).
- A **test-only owner-binding hook** so a route can be exercised as owner B — either a `withOwner(id, fn)` service-call helper, or a test-mode header `x-test-owner` honored by `requireAuth` **only** when `AUTH_MODE=test`.
- `currentOwnerId()` **throws** outside a `runWithOwner` context when `NODE_ENV!=='test'` (fail-loud); test builds keep the `SYSTEM_OWNER` fallback.
- Grep gate extended to `src/services` + `src/jobs` and to forbid bare `SYSTEM_OWNER`/`'00000000-…-0001'` in scoped dirs.
- `EXPORT_VERSION` policy decided (see [Fault F-EXPORTVER](#fault-f-exportver)) — recommended: **one bump at the end of the T sequence**, not per-PR.

**Schema & files:** `server/test/helpers.ts`, `server/test/owner-literals.test.ts`, `server/src/lib/context.ts`, `server/src/lib/auth/requireAuth.ts`, `server/test/schema-parity.test.ts`. No migration.

**DoD:** helpers merged + used by ≥1 isolation test; `currentOwnerId()` throw-outside-context lands with the test-mode escape; grep gate green over the widened dirs; `EXPORT_VERSION` policy written into this doc.

**Acceptance:** a test can create owner B, run a service call under `runWithOwner(B)`, and assert isolation; a deliberately-unwrapped owner-scoped query throws in a non-test build.

**Tests:** self-testing (the helpers + gate are the deliverable); add a unit test that `currentOwnerId()` throws outside context in non-test mode.

---

## T1 — Owner-scope `time_blocks` (migration `0098`) · the heaviest slice

**Goal:** give `time_blocks` a real `owner_id`, fix the `backup.ts` cross-tenant wipe, close L Gap 5, and owner-scope every reader/writer — so the calendar is tenant-isolated.

**Before (verified):**
- `time_blocks` has **no `owner_id`** (created in `0001` baseline, ~30 cols, only ever `ALTER ADD COLUMN`; retyped TEXT/UUIDv7 in `0030`). `schema.ts:93-137`.
- Reachable by owner only via `task_id → tasks.owner_id`; **container (`block_kind='timeblock'`) and synced-meeting (`'meeting'`) blocks have `task_id` NULL → no owner path at all.**
- **6 inbound FKs + self-ref** the rebuild must preserve: `time_entries.block_id` (SET NULL), `reminders.block_id` (CASCADE), `external_events.block_id` (CASCADE), `outbound_queue.block_id` (CASCADE), `daily_plan.block_id` (SET NULL), `time_blocks.parent_block_id` (self, SET NULL).
- Indexes today: `ix_time_blocks_task`, `ix_time_blocks_category`, `ix_time_blocks_parent`, `ix_time_blocks_pattern_source` (partial), `ux_block_occurrence` (partial unique), `ux_time_blocks_ingest_source`. **No `start_at`/`owner_id` index.**
- **~24 reader/writer files, all owner-blind** (only the lazy materializers already take an owner): `routes/blocks.ts` (range `:62-63`, fallback `:96-97`, POST insert `:168-192`, by-id `:257/330/365/373/378/437/445/448/453`), `engine/{autoplan,blocks-place,blocks-recur,clear-range,patterns-place,reminders,review,scheduler,auto-defense}.ts`, `routes/{block-templates,plan}.ts`, `agents/sync.ts`, `services/{block-task-sync,timer}.ts`, `scripts/seed-test-data.ts:139`. ~13 raw `INSERT INTO time_blocks` + 2 Drizzle inserts.
- **`applyOp` has no owner check for `block` ops** (`sync/apply.ts:112-117`) — L Gap 5.
- `backup.ts` exports `time_blocks` **unfiltered** (`:65`), import **full-wipes** it (`:186`), and the `entity_tags` delete `UNION SELECT id FROM time_blocks` (`:178-182`) spans **all** owners. `EXPORT_VERSION='3'`.

**After:** every `time_blocks` row carries `owner_id`; all reads/writes/mutations are owner-scoped; `backup.ts` export/restore is per-owner; `applyOp` rejects cross-owner block ops; an owner-scoped range index exists.

**Schema & files:**
- **NEW `server/src/db/migrations/0098_time_blocks_owner_id.ts`** (`export const manual = true`): add `owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE`. ⚠️ **`rebuildTable`'s `INSERT..SELECT` copies only shared columns and cannot populate a new NOT-NULL `owner_id` in one pass** (`migrate.ts:77`) — see [Fault F-REBUILD](#fault-f-rebuild). Use the two-phase approach: create the new table with `owner_id` **nullable**, copy, run the backfill `UPDATE owner_id = COALESCE((SELECT t.owner_id FROM tasks t WHERE t.id=time_blocks_new.task_id),(SELECT id FROM owners LIMIT 1))` in `afterSql`, **then** enforce NOT NULL (second rebuild or a hand-written 12-step). Recreate **all 6 existing indexes** + add `ix_time_blocks_owner_start(owner_id, start_at)`. Add `PRAGMA foreign_key_check` (rebuildTable does **not**). Idempotency guard on `PRAGMA table_info` (mirror `0094`).
- `server/src/db/migrations/index.ts` — `import * as m0098` + append.
- `server/src/db/schema.ts:93-137` — add `ownerId` (this type-errors the 2 Drizzle inserts, a good tripwire).
- `routes/blocks.ts` — owner-scope the range/fallback reads **and every by-id SELECT/UPDATE/DELETE** (move-group, promote, clear-day, delete-by-recurrence-parent); add `ownerId: currentOwnerId()` to the POST insert.
- `engine/blocks-recur.ts:92-108` — owner-scope the **global template SELECT** and add `owner_id` to the `INSERT OR IGNORE` (else owner A's GET materializes owner B's series — [Gap G-RECUR](#gap-g-recur)).
- `engine/auto-defense.ts:67-77,223,242,331,342` — thread owner into `snapshotAutoBlocks` + every reflow mutation (else `reflow(A)` **corrupts** owner B's overlapping blocks — [Fault F-REFLOW](#fault-f-reflow)).
- `engine/clear-range.ts:21,196-198,218-224` — owner-scope `blocksToDelete` + template enumeration; fix the two "no owner_id" comments.
- `engine/{autoplan,blocks-place,patterns-place,scheduler,review}.ts`, `routes/{block-templates,plan}.ts`, `agents/sync.ts:148-161`, `scripts/seed-test-data.ts:139` — add `owner_id` to every `INSERT INTO time_blocks` (bind the in-scope owner) and owner-scope their `time_blocks` SELECT/DELETE.
- `sync/apply.ts:115` — add `|| op.entity === 'block'` to the owner check (keep `owner_id` **out** of `BLOCK_FIELDS`).
- `routes/backup.ts` — add `time_blocks` to `OWNER_TABLES`; export `WHERE owner_id=?` (`:65`); restore `DELETE … WHERE owner_id=?` (`:186`); **`entity_tags` UNION → `UNION SELECT id FROM time_blocks WHERE owner_id=?`** (`:181`, [Fault F-ETAGS](#fault-f-etags)); bump `EXPORT_VERSION` per T0 policy.

**DoD:** migration + all reader/writer scoping + backup gate + `applyOp` guard land in **one PR**; `pnpm snapshot` pre-migration; `foreign_key_check`/`integrity_check` clean; baseline golden regenerated + eyeballed (only diff = `time_blocks.owner_id`); `schema-parity` extended to `time_blocks`; suite + typecheck green under `TZ=UTC`.

**Acceptance criteria:**
1. Every `time_blocks` row has non-NULL `owner_id`; task-backed blocks inherit their task's owner, container/meeting blocks got the single owner.
2. Owner B (via `runWithOwner`) never reads, PATCHes, moves, promotes, or deletes owner A's block (range read **and** by-id).
3. `applyOp` rejects a cross-owner `block` op (404); a synced `block` op cannot author `owner_id`.
4. `reflow(A)` and `GET /api/blocks(A)` never snapshot/move/stamp/**materialize** owner B's blocks.
5. Restoring owner A's export leaves owner B's `time_blocks` **and** `entity_tags` intact.
6. All 6 pre-existing indexes survive; `ix_time_blocks_owner_start` exists and the owner-scoped range read uses it (EXPLAIN QUERY PLAN, not SCAN).

**Tests:** migration test (zero-NULL, integrity, index survival); `sync-apply.test.ts` cross-owner block rejection + `owner_id` un-authorable; owner-isolation matrix for GET/PATCH/DELETE/move-group/promote (service-level via T0 hook); cross-owner reflow + recurrence-regen non-interference; `backup`/entity_tags restore-isolation with a 2nd owner; `EXPLAIN QUERY PLAN` index test; the existing engine insert tests (`blocks-place`, `auto-placement`, `blocks-category`, `connector-google`, `auto-defense`) act as the raw-insert regression net.

---

## T2 — Owner-scope the tag axis (migration `0099`)

**Goal:** owner-scope `tags`, relax the global name-uniqueness, scope the junctions via parent, and fix ~a dozen owner-blind tag readers + the tag backup wipe.

**Before (verified):**
- `tags` has **no `owner_id`**; `name` is **`TEXT NOT NULL UNIQUE` globally** (`0001` baseline `:97`; `schema.ts:231`). `0036` only added `kind/muted/is_base`.
- Junctions `tag_patterns`, `tag_categories`, `category_direction_optouts`, `entity_tags` have no `owner_id` (FK `tags` CASCADE). `entity_tags` is polymorphic (`entity_kind ∈ task|time_block|routine`, `entity_id` has **no FK**).
- `tag_prefs` (0097) **is** owner-scoped (`UNIQUE(owner_id, tag_id)`); scoping flows to it once `tags` is scoped — no `tag_prefs` reader bypasses owner.
- **Owner-blind readers:** `services/tags.ts:38-56` (`findTag`/`makeTag`/`resolveTagId` by **name**, no owner — the most-called write path), `:199,215-272`; `routes/tags.ts` (`GET` returns **all owners'** tags `:41-50`; name-clash `:74,130` global; by-id mutate/delete `:104,155,167`); `routes/blocks.ts:161,266` (`category_id` validated by **kind only, not owner**); `engine/autoplan.ts:181,544` (`SELECT … tags WHERE kind='pattern'` global); LLM vocab `services/auto-tag.ts:40`, `agents/plan.ts:646-648`, `routes/tasks.ts:295`, `agents/ingest.ts:26-42` (privacy leak).
- Base `Home/Work/Community` (`is_base`) seeded **once globally** (`0036:46-47`) — no per-owner provisioning.
- `backup.ts` exports the tag axis unfiltered (`:102-105`) and full-wipes it on restore (`:195-198`).

**After:** `tags.owner_id NOT NULL`; `UNIQUE(owner_id, name)`; junctions isolate via parent tag; every tag reader owner-scoped; tag backup per-owner; new-owner base-tag provisioning defined.

**Schema & files:**
- **NEW `0099_tags_owner_id.ts`** (manual/rebuild, two-phase like T1): add `owner_id`, **drop global `UNIQUE(name)` → `UNIQUE(owner_id, name)`** ([Fault F-TAGUNIQUE](#fault-f-tagunique)), backfill to the single owner, add `ix_tags_owner`. Junctions get **no** column.
- `schema.ts:229-241` — add `ownerId`; move `.unique()` off `name` to table-level `unique().on(ownerId, name)`; extend `schema-parity`.
- `services/tags.ts` — thread `ownerId` through `findTag`/`makeTag`/`resolveTagId` (`SELECT … WHERE owner_id=? AND name=?`, `INSERT … (id, owner_id, name)`); verify every caller passes an owner-owned tag id.
- `routes/tags.ts` — owner-scope `GET`, name-clash checks, the `entity_tags` count join, and by-id mutate/delete (404 for a foreign tag id).
- `routes/blocks.ts:161,266` — add `AND owner_id=?` to the `category_id` kind-validation.
- `engine/autoplan.ts:181,544`, `services/auto-tag.ts:40`, `agents/plan.ts`, `routes/tasks.ts:295`, `agents/ingest.ts`, `scripts/import-plan.ts` — owner-scope every `SELECT … FROM tags`.
- `routes/backup.ts` — add `tags` to `OWNER_TABLES` (`WHERE owner_id=?`); export/delete the three junctions by parent-tag membership (`… tag_id IN (SELECT id FROM tags WHERE owner_id=?)`, [Gap G-JUNCTION](#gap-g-junction)); bump `EXPORT_VERSION` per policy.
- **New-owner base-tag provisioning** ([Gap G-BASETAG](#gap-g-basetag)) — belongs with T5/U owner-creation; **T2 documents the dependency** so Auto isn't silently broken for owner #2.

**DoD:** migration + all tag readers + backup + junction scoping in one PR; base-tag provisioning dependency recorded; integrity/golden/parity green.

**Acceptance criteria:**
1. Two owners can both hold a tag named `errands` (proves `UNIQUE(owner_id, name)`).
2. `GET /api/tags` / `directionsOf` / `categoriesOf` return only the caller's tags; a foreign tag id 404s on mutate/delete.
3. A block can't be stamped against another owner's category tag.
4. LLM vocab (`auto-tag`/`plan`/`ingest`/`tasks`) draws only the caller's tag names.
5. Restore-isolation: owner A's restore leaves owner B's tags/junctions/`entity_tags` intact.

**Tests:** two-owners-same-name; tag/direction/category owner-isolation matrix; category-stamp cross-owner rejection; migration zero-NULL + integrity; restore-isolation; regenerate golden.

---

## T3 — Cron per-owner fan-out (code; **no migration** unless per-owner run visibility is wanted) · **RE-SCOPED**

> **This ticket corrects the design doc.** The doc framed T3 as "keep `scheduled_jobs` system-global; several jobs already iterate owners via `runWithOwner` (e.g. freeze-stars) — likely no migration / a decision to record." **That is false and is the single biggest latent fault** ([Fault F-CRON](#fault-f-cron)).

**Goal:** make every owner-scoped cron process **all** owners, not just owner #1.

**Before (verified):**
- `startCronJobs` wraps **every** job in `runWithOwner(SYSTEM_OWNER, () => runJob(kind))` (`jobs/index.ts:254`) → `currentOwnerId()` is always owner #1 inside a cron.
- Owner-scoped jobs that therefore **silently skip all other owners** under multi-tenant: `freeze_stars` (`freeze-stars.ts:34`), `generate_recurrences` (`recurrence-generate.ts:114`), `sync_calendar` (`agents/sync.ts:352,408`), `advance_objectives`, `calibrate_estimates` (`:22`), `tag_tasks` (`auto-tag` via `jobs/index.ts:128-133`), `auto_schedule` (`autoplan.ts:383-403`), `promote_possibles`/`nightly_grooming` (`agents/groom.ts`), `ingest_gmail`/`ingest_gcal` (`agents/ingest.ts:101,252`), and `prune_sync_events` (`jobs/index.ts:164-176` — prunes only owner #1, so **every other owner's `sync_events` grow unbounded**; its comment claiming isolation is false).
- Already owner-agnostic (correct): `review_day` (`review.ts:52,136-152`, groups `byOwner`), `fire_reminders` (`reminders.ts:67-89`, global `UPDATE … RETURNING owner_id`). Global by nature: `snapshot_db`.
- `job_runs` has no `owner_id`; `runJob` writes one aggregate run row per kind, broadcasts to `currentOwnerId()`, audits as `SYSTEM_OWNER`.
- `POST /api/jobs/:id/run` (`routes/jobs.ts:27-37`) runs `runJob` under the **request** owner — correct for a manual "run my job now".

**After:** cron dispatch iterates `SELECT id FROM owners` and wraps each owner-scoped kind in `runWithOwner(ownerId, …)`; the 3 global kinds run once; manual `/run` stays single-owner; broadcast/audit target the processed owner.

**Schema & files:**
- `server/src/jobs/index.ts` — replace the blanket `runWithOwner(SYSTEM_OWNER)` with an **allow-list-driven** dispatch: owner-scoped kinds fan out per owner; `review_day`/`fire_reminders`/`snapshot_db` run once globally. Split `runJob` into **single-owner (manual)** vs **all-owners (cron)** modes ([Fault F-MANUAL](#fault-f-manual)); broadcast `job:*` + `writeAudit` to the processed owner, not `SYSTEM_OWNER`.
- `prune_sync_events` — simplest correct fix: **drop the `owner_id` predicate and prune globally by age** (retention is per-row/age-based); fix the misleading comment.
- Verify `0095` deleted the `aggregate_plan_outcomes` `scheduled_jobs` row (not just the table); the dispatch must skip unknown kinds gracefully.
- **Optional migration** only if per-owner run visibility is wanted: `job_runs.owner_id` (the *only* justified T3 migration). Otherwise: aggregate row + per-owner broadcast/audit.

**DoD:** cron fan-out + manual/cron split + `prune` fix land; per-owner cron regression test green; no per-owner `scheduled_jobs` rows added (registry stays global).

**Acceptance criteria:**
1. A single cron tick of each owner-scoped kind processes **owner A and owner B** (seed both; assert both changed).
2. No cross-owner writes (owner A's job never touches owner B's rows).
3. `freeze_stars` freezes each owner's "yesterday" **in their own tz** (seed owners in different tz).
4. `prune_sync_events` prunes **both** owners' aged rows.
5. Manual `POST /api/jobs/:id/run` as owner B runs for B only and does **not** broadcast/recompute for A.

**Tests:** new `jobs-multiowner.test.ts` (per-kind fan-out + cross-owner non-interference + tz-differ freeze); manual-vs-cron scope; `review-reschedule` byOwner lock-in.

---

## T4 — `sync_events` FK + `proposed_owner_id` + owner-delete cascade consistency (migration `0100`)

**Goal:** enforce the `sync_events` owner FK, document the `proposed_owner_id` naming, and normalize owner-delete behavior — the low-risk cleanup slice.

**Before (verified):** `sync_events.owner_id` is a value with **no `.references()`** (`schema.ts:538`); `possible_tasks.proposed_owner_id` **is** a real FK (`:83`), already backup-filtered (`:88,:176`) and COALESCE'd with `currentOwnerId()` by two agents — so "document, not rename" is safe. `pattern_day_optouts.owner_id` (`0074`) references `owners` **without ON DELETE CASCADE**, unlike newer tables ([Fault F-CASCADE](#fault-f-cascade)). `external_events`/`outbound_queue` CASCADE off `time_blocks` but are **absent from the export payload** ([Gap G-CASCADEXPORT](#gap-g-cascadexport)).

**After:** `sync_events.owner_id` is an enforced FK; `proposed_owner_id` documented in `schema.ts`; owner-delete cascade behavior consistent (or explicitly deferred to U with a note).

**Schema & files:** NEW `0100_sync_events_owner_fk.ts` (rebuild to add `REFERENCES owners(id)`); `schema.ts:538` add `.references()`, `:83` add a one-line `proposedOwnerId` comment; decide cascade normalization for `pattern_day_optouts` (+ any other non-cascade owner FK) — fold into this migration or record as a U/account-deletion item.

**DoD:** `sync_events` FK enforced (`foreign_key_check` clean); `proposed_owner_id` documented; cascade decision recorded; export/restore gap for `external_events`/`outbound_queue` flagged or fixed.

**Acceptance criteria:** inserting a `sync_events` row with a non-existent owner fails FK; `proposed_owner_id` note present; owner-delete cascade behavior is consistent or explicitly documented.

**Tests:** `sync_events` FK-violation test; migration zero-orphan check.

---

## T5 — `owners` auth-identity columns + `GLOSSARY` (migration, **with Phase U**)

**Goal:** reserve the auth columns U populates, and make "owner ≡ user" canon.

**Before:** `owners` = `id/name/email/last_auto_run_id` only (`schema.ts:8-13`); one row (the `SYSTEM_OWNER_ID` sentinel).

**After:** `owners` gains `external_subject TEXT UNIQUE`, `username TEXT UNIQUE`, `password_hash TEXT` (all nullable; final set confirmed with U); `GLOSSARY.md` defines owner ≡ user.

**Schema & files:** NEW migration (numbered after T4); `schema.ts:8-13`; `GLOSSARY.md`. **Coordinate the exact column set with U before writing** (decision #3). The `SYSTEM_OWNER` sentinel row will have NULL auth columns — U's auto-provision/login must **exclude the sentinel** ([Note N-SENTINEL](#note-n-sentinel)); no id collision (sentinel has zero timestamp bytes, real signups can't reproduce it).

**DoD:** columns land in one coordinated migration with U; `GLOSSARY` updated; sentinel-exclusion documented for U.

**Acceptance criteria:** the columns exist and are nullable; the sentinel row is auth-inert; `GLOSSARY` states owner ≡ user.

**Tests:** migration presence/nullable test; (U owns the auth behavior tests).

---

## Gaps, drift, missed opportunities & faults

Ranked; each notes the correction folded into the tickets above.

### Blockers

- <a id="fault-f-cron"></a>**F-CRON (fault):** No cron iterates owners — `startCronJobs` binds `SYSTEM_OWNER` for every job. Under multi-tenant, **every** owner-scoped cron (freeze/recurrence/sync/calibrate/advance/tag/auto-schedule/ingest/promote/prune) serves **only owner #1** — a full feature + data-retention outage for every other owner. The design doc's "T3 is a decision, no migration, freeze-stars already iterates" is **wrong**. → **T3 rewritten** as an owner-fan-out code PR.
- <a id="fault-f-tagunique"></a>**F-TAGUNIQUE (fault):** `tags.name` is **globally UNIQUE**; the doc never mentions it. Without `UNIQUE(owner_id, name)` a 2nd owner can't reuse any tag name and import collides. → **T2** relaxes it.
- <a id="fault-f-rebuild"></a>**F-REBUILD (fault):** `rebuildTable`'s `INSERT..SELECT` copies only shared columns → cannot populate a new `NOT NULL owner_id` in one pass; the doc's "rebuild NOT NULL then backfill" isn't executable. → **T1/T2** use the two-phase (nullable → backfill → tighten) or hand-written 12-step.
- <a id="fault-f-etags"></a>**F-ETAGS (fault):** the `backup.ts` `entity_tags` restore-delete `UNION SELECT id FROM time_blocks` spans all owners; the doc's "re-verify, it should hold" is wrong — it's a genuine cross-tenant `entity_tags` wipe. → **T1** adds `WHERE owner_id=?` to the UNION.
- <a id="gap-g-readers"></a>**G-READERS (gap):** T2 is ~a dozen owner-blind readers (`services/tags.ts`, `routes/tags.ts`, autoplan, vocab), not "a column"; the doc's reader-scoping checklist existed only for T1. And T1's real reader surface is **~24 files**, not "blocks.ts + engine/\*". → both tickets enumerate every site.

### High

- <a id="fault-f-reflow"></a>**F-REFLOW (fault):** `auto-defense.snapshotAutoBlocks` filters by date only → `reflow(A)` would snapshot/re-place/stamp owner B's overlapping blocks — silent **corruption**, not a read leak. → named in **T1**.
- <a id="gap-g-recur"></a>**G-RECUR (gap):** `blocks-recur` template SELECT is global → owner A's `GET /api/blocks` materializes owner B's recurring series. → **T1**.
- <a id="gap-g-test"></a>**G-TEST (gap/fault):** `requireAuth` test-mode pins `SYSTEM_OWNER`, so route-level owner-isolation is **untestable via HTTP**; the DoD's "GET /api/blocks owner-isolation" isn't achievable as written, and **no 2nd-owner helper exists**. → **T0** adds the helper + a test-mode owner hook; isolation tests run service-level.
- <a id="fault-f-context"></a>**F-CONTEXT (fault):** `currentOwnerId()` defaults to `SYSTEM_OWNER` outside a context → any unwrapped path silently serves owner #1, invisible in test-mode. → **T0** makes it throw in non-test builds + mandates an audit.
- <a id="fault-f-tblrebuild"></a>**F-TBLREBUILD (fault):** `time_blocks` has never been rebuilt (6 inbound FKs, self-ref, ~30 cols, 6 indexes); under FK-off any `createNewSql` omission passes silently. → **T1** enumerates the full column/FK/index list + mandates `foreign_key_check` + eyeballed golden.
- <a id="gap-g-basetag"></a>**G-BASETAG (gap):** base `Home/Work/Community` seeded once globally → owner #2 gets zero pattern tags → Auto silently places nothing. → **T2** documents the per-owner-provisioning dependency (owned by T5/U).
- <a id="fault-f-order"></a>**F-ORDER (drift):** time_blocks-first front-loads all risk (hardest rebuild + first backup gate + Gap-5 close). → recommended order **T0→T3→T4→T2→T1→T5**.

### Medium

- <a id="gap-g-byid"></a>**G-BYID:** ~9 by-id `time_blocks` mutations in `routes/blocks.ts` (move-group/promote/clear-day/delete) have no owner check — REST analogue of L Gap 5. → **T1** guards each.
- <a id="gap-g-junction"></a>**G-JUNCTION:** the three tag junctions have two tag-id columns each; "scope via parent" needs explicit `IN (SELECT id FROM tags WHERE owner_id=?)` rewrites in export + delete. → **T2**.
- <a id="fault-f-manual"></a>**F-MANUAL:** `runJob` is shared by cron (should fan out) and manual `/run` (should be single-owner); fanning both out leaks SSE + recompute across tenants. → **T3** splits the modes.
- <a id="fault-f-exportver"></a>**F-EXPORTVER:** import hard-rejects any `version != current`; per-PR bumps strand every intermediate export. → **T0** decides one policy (recommended: single bump at end of sequence).
- <a id="gap-g-cascadexport"></a>**G-CASCADEXPORT:** `external_events`/`outbound_queue` CASCADE off `time_blocks` but are absent from export/restore → any restore drops sync state with no re-insert. → flagged in **T4** (add to export or document forced re-sync).
- <a id="fault-f-import"></a>**F-IMPORT:** `POST /api/import` `INSERT OR REPLACE` trusts row-level `owner_id`; a colliding PK could clobber another owner's row. → per-row owner validation in the scoping PR + adversarial colliding-PK test.
- <a id="fault-f-cascade"></a>**F-CASCADE:** `pattern_day_optouts.owner_id` lacks `ON DELETE CASCADE`; `time_blocks` T1 adds CASCADE while `flight_plan` (0093) deliberately omitted it — inconsistent owner-delete behavior. → **T4** normalizes (or defers to U with a note).
- <a id="gap-g-gate"></a>**G-GATE:** the grep gate only catches integer `1` literals and skips `src/services`/`src/jobs` and UUID `SYSTEM_OWNER`. → **T0** widens it.
- <a id="gap-g-export-missing"></a>**G-EXPORT-MISSING (pre-existing bug):** export/import silently **omits** owner-scoped `daily_plan`, `reflections`, `objectives`, `objective_tasks`, `estimate_calibration`, `replan_suggestions`, `plan_hints`, `day_assignments` — a round-trip data-loss bug unrelated to tenancy, but T is the PR touching this file. → audit every `owner_id`-bearing table against the export payload; fold in or document.

### Low / notes

- <a id="drift-d-objtasks"></a>**D-OBJTASKS (drift):** `objective_tasks` (no `owner_id`, scopes via `objectives`, already guarded in `apply.ts:118`) is missing from the ledger's "scope-via-parent" list. Verified owner-scoped already: `daily_plan`, `plan_hints`, `reflections`, `estimate_calibration`, `replan_suggestions`, `pattern_day_optouts`, `objectives`. → add to §8 for completeness.
- <a id="note-n-sentinel"></a>**N-SENTINEL:** the `SYSTEM_OWNER` row will have NULL auth columns — U's provisioning/login must exclude it. → **T5** note.
- **N-CLIENT:** `client/src` sends no `owner_id` and refetches on import → **T requires zero client changes**. Stated to de-risk.
- **N-INDEX:** T2 should add `ix_tags_owner` and reconsider junction index leading columns for owner-scoped reads.
- **N-BACKUP-PATH:** the doc/recap say "backup.ts" without a path — it's `server/src/routes/backup.ts`, not `lib/backup.ts`. Corrected in this doc's header.
