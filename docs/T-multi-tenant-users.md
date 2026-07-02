# T — Multi-tenant data model & user provisioning — design doc

**Status:** DESIGN · current at migration head **`0097`** (supersedes the earlier `0091`-era draft). **Decisions #1 & #2 LOCKED 2026-07-02** (§0). **Per-ticket implementation detail (goal / before-after / files / DoD / acceptance / tests) lives in [T-multitenant-tickets.md](T-multitenant-tickets.md)** — this doc is the design + decisions + ledger + phase shape. Companion to [recap_state_A-S.md](recap_state_A-S.md) §8, [Q-schema-hygiene.md](Q-schema-hygiene.md) → "Multi-tenant bridge", [HANDOFF-multitenant.md](HANDOFF-multitenant.md).

> The tickets were hardened by an adversarial code investigation at `0097`; several findings **corrected this doc** (T3 was mis-scoped; `tags.name` is globally UNIQUE; the reader surface is ~24 files; owner-isolation isn't HTTP-testable). Those corrections are folded in below.
>
> **Verify before coding** (HANDOFF Gotcha #1): `git fetch origin main`; confirm head `0097`; suite + typecheck green under `TZ=UTC`. Branch **fresh off `origin/main`** (Gotcha #2).

---

## 0 · Decisions

**#1 — Tenant model: Option A (tenant = user). ✅ LOCKED 2026-07-02.** Each account is its own isolated workspace. `owners` **is** the user table — auth columns get added directly to it. No `tenants`/`tenant_id`/`memberships`. (Option B — teams — can be layered on later as "a tenant with one member"; building it now is wasted complexity.)

**#2 — Table naming: keep `owners`. ✅ LOCKED 2026-07-02.** No rename to `users` (would touch every `references(() => owners.id)` + raw-SQL `REFERENCES owners(id)` across 40+ tables). "owner" ≡ "user" in product vocabulary; **T5 makes it canon in `GLOSSARY.md`**.

**#3 — Exact `owners` auth-identity columns: ⏳ OPEN, jointly with Phase U.** At minimum `external_subject TEXT UNIQUE` (OIDC `sub`), and for local login `username TEXT UNIQUE` + `password_hash TEXT` (argon2id, nullable). **Phase T does not implement auth/login behavior** (T5 may add nullable placeholder columns once U finalizes the exact set). The `SYSTEM_OWNER` sentinel row will have NULL auth columns — U's provisioning/login must exclude it (no id collision: the sentinel has zero timestamp bytes, real signups can't reproduce it).

**Smaller implementation decisions (flag if you disagree):**
- **Junctions scope through their parent, not their own column** — recommended (avoids redundant columns). Applies to `tag_patterns`, `tag_categories`, `category_direction_optouts`, `entity_tags`, `task_dependencies`, `pattern_tasks`, `possible_task_tags`, `objective_tasks`.
- **`scheduled_jobs` registry stays system-global — but the cron RUNNER must be changed to iterate owners.** ⚠️ Correction: *no cron iterates owners today* (the runner binds `SYSTEM_OWNER` for every job). Keeping the registry global is right; making the jobs run per-owner is **new code**, not a free property (T3). See [Fault F-CRON](T-multitenant-tickets.md#fault-f-cron).
- **`possible_tasks.proposed_owner_id` is documented, not renamed** — it's a *proposed* (not confirmed) assignment; a real FK already backup-filtered by it (T4).

---

## 1 · Current state (verified @ head `0097`)

- `owners`: `id`, `name`, `email` (+ `last_auto_run_id`). One row — the `SYSTEM_OWNER_ID` UUIDv7 sentinel (seeded `'Liam'`). No auth/identity/role columns.
- Almost every table is `owner_id`-scoped since B0. **`schema.ts` is intentionally incomplete** (`daily_recap` is migration-only). **Enumerate owned tables from the migrations, not `schema.ts`.**

**Owner-LESS tables — the work:**

| Table(s) | Issue | Ticket |
|---|---|---|
| **`time_blocks`** | **Blocker #1** — no `owner_id`; container/synced-meeting blocks have `task_id` NULL → no owner path at all. 6 inbound FKs + self-ref; never rebuilt. | T1 |
| `tags` + junctions (`tag_patterns`, `tag_categories`, `category_direction_optouts`, `entity_tags`) | tenant-global. ⚠️ **`tags.name` is a GLOBAL `UNIQUE`** — must become `UNIQUE(owner_id, name)` or a 2nd owner can't reuse any name. ([F-TAGUNIQUE](T-multitenant-tickets.md#fault-f-tagunique)) | T2 |
| `scheduled_jobs` (+ `job_runs`) | global cron registry — **kept global; the runner must fan out per owner** (T3) | T3 |
| `sync_events.owner_id` | a **value, not a FK** | T4 |
| `possible_tasks.proposed_owner_id` | a **real FK**, uniquely named | T4 (document) |

**Scope-via-parent (no `owner_id` column added):** `task_dependencies` → tasks, `pattern_tasks` → patterns, `possible_task_tags` → possible_tasks, `entity_tags` → tags/owned entity, `objective_tasks` → objectives (already owner-guarded in `apply.ts`).

**Verified already owner-scoped (NOT blockers):** `daily_recap`, `tag_prefs`, `daily_plan`, `reflections`, `objectives`, `estimate_calibration`, `replan_suggestions`, `plan_hints`, `pattern_day_optouts`. The consolidation/hygiene tables buy nothing for tenancy — the owner-*less* tables above are the whole job.

**Cross-cutting facts (feed T0/T3):**
- `backup.ts` (= **`server/src/routes/backup.ts`**, *not* `lib/backup.ts`) full-wipes the owner-less tables on restore and exports them unfiltered; `EXPORT_VERSION` is now `'4'` (PR #215 rewrote this file — match by symbol, not line). The moment a table gains `owner_id`, that wipe is cross-tenant data loss — **the correctness/security gate** (§3).
- `applyOp` has no owner check for `block` ops (**L Gap 5**).
- ⚠️ **No cron iterates owners** (`startCronJobs` binds `runWithOwner(SYSTEM_OWNER)`) → under multi-tenant every owner-scoped cron serves **only owner #1** (the biggest latent fault).
- ⚠️ `currentOwnerId()` **defaults to `SYSTEM_OWNER` outside any `runWithOwner` context** → an unwrapped path silently reads owner #1.
- **Client sends no `owner_id`** (server injects; import refetches) → **T requires zero client changes**.

---

## 2 · Scope — tickets

Full detail per ticket in [T-multitenant-tickets.md](T-multitenant-tickets.md).

- **T0 — Multi-tenant test & enforcement scaffolding** (prerequisite, no migration): a 2nd-owner test factory; a test-mode owner-binding hook (route-level isolation is untestable today — test-mode pins `SYSTEM_OWNER`); make `currentOwnerId()` throw outside a context in non-test builds; widen the owner-literal grep gate to `src/services`+`src/jobs` + UUID/`SYSTEM_OWNER`; decide the `EXPORT_VERSION` bump policy.
- **T1 — owner-scope `time_blocks`** (mig `0098`): the blocker; ~24 reader/writer files; closes L Gap 5; carries the `backup.ts` gate (incl. the `entity_tags` UNION). The heaviest slice.
- **T2 — owner-scope the tag axis** (mig `0099`): `tags.owner_id` + **`UNIQUE(owner_id, name)`**; junctions via parent; ~a dozen owner-blind readers; per-owner base-tag provisioning dependency. **Runs after T1.**
- **T3 — cron per-owner fan-out** (code; no migration unless per-owner run visibility is wanted): iterate owners in the runner; manual-vs-cron split; fix `prune_sync_events`. **A correctness PR, not a decision.**
- **T4 — `sync_events` FK + `proposed_owner_id` doc + owner-delete cascade consistency** (mig `0100`): the low-risk cleanup.
- **T5 — `owners` auth columns + `GLOSSARY`** (mig, with Phase U): reserve U's columns; make owner ≡ user canon.

**Not in T:** login (U); teams/workspaces (Option B, not chosen); `scheduling_prefs` split (owner-declined); recurrence unification / default-minutes (Q Tier-2, design-first).

---

## 3 · Migration safety, rollback & the backup gate

- **Forward-only runner, no `down()`** — "rollback" = `pnpm snapshot` / Litestream restore. Snapshot before every T migration.
- ⚠️ **`rebuildTable` cannot populate a new `NOT NULL owner_id` in one pass** (its `INSERT..SELECT` copies only shared columns). Use the **two-phase** pattern: create the new table with `owner_id` **nullable**, copy, backfill in `afterSql`, then tighten to `NOT NULL` (a second rebuild) — or hand-write the 12-step with the `COALESCE` backfill inline. Add `PRAGMA foreign_key_check` explicitly (rebuildTable does not). ([F-REBUILD](T-multitenant-tickets.md#fault-f-rebuild))
- **The `backup.ts` gate (same PR as each column add, non-negotiable):** convert the owner-less `DELETE FROM …` to `… WHERE owner_id = ?`, owner-scope the export selects, and **explicitly fix the `entity_tags` restore-delete `UNION SELECT id FROM time_blocks` → `… WHERE owner_id = ?`** (it does *not* auto-scope — [F-ETAGS](T-multitenant-tickets.md#fault-f-etags)). Bump `EXPORT_VERSION` per the T0 policy. Coordinate with the in-flight backup export-completeness fix (`task_0b00e839`) which also touches this file + `EXPORT_VERSION`.
- **Integrity:** `PRAGMA foreign_key_check`/`integrity_check` clean; a zero-NULL-`owner_id` test per newly-scoped table; regenerate + eyeball the `baseline.characterization` golden; extend `schema-parity.test.ts` to each newly-scoped table.

---

## 4 · PR order & dependencies

**Order: T0 → T3 ∥ T4 → T1 → T2 → T5.** *(Owner decision 2026-07-02. T0 first (unblocks isolation testing); **T3 ∥ T4** are disjoint, parallel-safe (T3 schema-free, T4 a tiny migration); then **T1 → T2** serial (shared `blocks.ts`/`backup.ts`/`schema.ts`/golden; T1-first isolates `entity_tags` sooner, T2 rebases on it); T5 with U. [F-ORDER](T-multitenant-tickets.md#fault-f-order).)*

- **Depends on:** Q + S merged (done, head `0097`).
- **T2 runs after T1** (serial — shared `blocks.ts`/`backup.ts`/`schema.ts`/golden). T1-first fixes the `entity_tags` backup UNION and isolates `time_block`-kind `entity_tags` rows, so T2 then only rebases its small `blocks.ts` category-check on T1.
- **Serialization hotspots** (coordinate even across the parallel T3 ∥ T4 tracks): pre-assign migration numbers (T1 `0098`, T2 `0099`, T4 `0100`); single-writer regen of the `baseline` golden; coordinate `backup.ts` + `EXPORT_VERSION` (also just touched by merged #215); and lock T0's `currentOwnerId()`-throws + widened grep-gate contract first (T1/T2/T3 depend on it).
- **T5 with Phase U** (decision #3).
- **Blocks:** U (needs T's `owners` shape) and softly W's final GraphQL owner-scoping shape.
- **Parallel-safe with:** Y (env audit), X (MCP vocab); W's non-ownership design.
- Small, `main`-based PRs; verify content reached `main` after each merge (HANDOFF Gotcha #2).

## 5 · Conventions (HANDOFF §4)

Migrations `NNNN_name.ts`, forward-only + idempotent, **registered in `migrations/index.ts`** (`import * as mNNNN` + append). Rebuilds use `rebuildTable` + `export const manual = true` (FK-off swap) — but see the two-phase `NOT NULL` caveat (§3). Regenerate + eyeball the `baseline.characterization` golden. `EXPORT_VERSION` policy set once in T0. Tests run sequentially against one pid-keyed DB, migrations-on-import — always `TZ=UTC`, pin all dates. Owner scoping via `currentOwnerId()` / `runWithOwner`; never an owner literal (grep gate — widened in T0).

## 6 · Definition of done (phase)

Per-ticket DoD/acceptance/tests are in [T-multitenant-tickets.md](T-multitenant-tickets.md). Phase-level:

- [ ] Decisions #1/#2 recorded (done); **#3 auth columns finalized with U** before T5.
- [ ] `time_blocks`, `tags` (+ junctions via parent), `sync_events` genuinely owner-scoped/enforced; the cron runner fans out per owner (T3).
- [ ] Backfill to the single owner with a **zero-NULL-`owner_id` test** per newly-scoped table; `foreign_key_check`/`integrity_check` clean; `pnpm snapshot` pre-migration.
- [ ] `backup.ts` owner-scoped (export + restore + `entity_tags` UNION) in the same PR as each column add; **restore-isolation test** (owner A restore leaves owner B intact); `EXPORT_VERSION` policy honored.
- [ ] `applyOp` block owner-check added (L Gap 5 closed).
- [ ] T0 scaffolding merged (2nd-owner helper, `currentOwnerId()` throw-outside-context, widened grep gate) before the scoping PRs rely on it.
- [ ] `GLOSSARY.md` defines owner ≡ user; `owners` has U's reserved auth columns (T5, with U).
