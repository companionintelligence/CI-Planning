# T — Multi-tenant data model & user provisioning — planning doc

**Status:** Planning only. **Depends on:** Phase Q (schema hygiene) landing first — this phase is exactly the "multi-tenant bridge" work Q's own doc deliberately deferred. Companion to [Q-schema-hygiene.md](Q-schema-hygiene.md) (see its "Multi-tenant bridge" section — the owner-less-table list below is taken directly from it) and [RELEASE-READINESS.md](RELEASE-READINESS.md).

## Goal

Turn the current **owner-scoped-but-single-owner** schema into one that safely holds many independent owners' data, and decide what a "user" is in this system (see Open Decision #1 — this is the one thing that should be locked before any of T's tickets are written up in migration-draft detail).

## Current state (verified against `server/src/db/schema.ts` and migrations)

- `owners` has exactly 3 real columns: `id`, `name`, `email` (plus `last_auto_run_id`, unrelated). No password, no external-identity column, no role/tenant field.
- Exactly one `owners` row exists in practice (`id`, seeded `'Liam'`, `liam.broza@gmail.com` — `0003_seed_defaults.ts`).
- Almost every table is `owner_id`-scoped already — this was intentional (`B0` migration, "so multi-tenant is a cheap flip, not a rewrite").
- **Owner-less tables that would leak across tenants today** (verified @ migration `0091`, per Q's audit):
  - `time_blocks` — the calendar itself. Reachable only via `task_id → tasks.owner_id`, which breaks for owner-less blocks like synced external meetings. **This is the blocker** — the single most-used table in the app has no direct tenant scope.
  - `tags`, `tag_patterns`, `tag_categories`, `category_direction_optouts`, `entity_tags` — the entire tag taxonomy is global today, not per-owner.
  - `scheduled_jobs` + `job_runs` — a global cron registry. Multi-tenant needs either per-owner job rows or an account-level job runner design decision.
  - `sync_events.owner_id` exists as a **value**, not a foreign key — currently unenforced.
- `possible_tasks.proposed_owner_id` is named differently from every other `owner_id` column — a naming inconsistency to reconcile while touching this area.

## Open decisions (need your/the owner's sign-off before implementation-level specs are written)

**1. Is a "tenant" the same thing as a "user," or can one tenant have multiple users?**
Two real options, and they produce very different schemas:

- **Option A — 1:1 (tenant = user).** Each signed-up person gets their own isolated workspace; nobody shares data. This is what almost all personal-planning SaaS products do (think: a to-do app where every account is its own silo). Simplest schema: `owners` becomes the user table directly (add auth columns to it), no separate tenant concept needed.
- **Option B — teams/workspaces (tenant ≠ user).** Multiple people can share one workspace (e.g., a household or small team plans together). Needs a new `tenants` table, a `tenant_id` on every owner-scoped table (replacing today's `owner_id`, or living alongside it), and a `memberships(user_id, tenant_id, role)` join table.

Everything else in this app today (the term "owner," the single-owner assumption baked into `currentOwnerId()`) points at **Option A** being the actual intent — the ROADMAP explicitly calls the target state "multi-user," which in context means "many independent single-owner accounts," not "shared team workspaces." **Recommendation: confirm Option A before proceeding** — it's dramatically less work, and Option B can always be layered on top of A later (a tenant that currently has exactly one member) if team features are ever wanted, whereas building B now for an A-shaped product is wasted complexity. This doc assumes **Option A** below; flag if that's wrong.

**2. Does `owners` get renamed to `users`, or stay `owners` with auth columns added?**
Renaming is a bigger, more invasive migration (every FK reference, every `references(() => owners.id)` call in `schema.ts`, every raw-SQL `REFERENCES owners(id)` across 40+ tables) for a purely cosmetic win. **Recommendation: keep the table named `owners`**, add the new columns to it, and treat "owner" and "user" as the same concept in the product vocabulary going forward (update `GLOSSARY.md` to say so explicitly, so there's no confusion for future readers). Flag if you'd rather pay the rename cost for clarity.

## Scope (assuming Option A, no rename)

### T1 — Owner-scope the owner-less tables
Add `owner_id TEXT NOT NULL REFERENCES owners(id)` to `time_blocks`, `tags`, `scheduled_jobs` (+ `job_runs` via its existing `job_id` join, or directly). For the pure-junction tables (`tag_patterns`, `tag_categories`, `category_direction_optouts`, `entity_tags`) — evaluate whether they need their own `owner_id` or whether scoping flows correctly through their parent `tags` row once `tags` itself is scoped (likely sufficient, avoids redundant columns — worth a query-performance check before deciding).

**Backfill strategy:** today there's exactly one owner, so backfilling every existing row with that owner's id is a one-line `UPDATE ... SET owner_id = (SELECT id FROM owners LIMIT 1) WHERE owner_id IS NULL` — trivial now, would NOT be trivial later once real second/third owners exist. **This is the single best argument for doing Phase T before any real second user ever signs up** — the backfill window where "just assign everything to the one existing owner" is unambiguously correct closes forever the moment a second owner exists.

### T2 — Reconcile `proposed_owner_id` naming
Either rename it to `owner_id` for consistency, or document why it's intentionally different (it represents a *proposed* assignment, not a confirmed one — arguably a real distinction worth keeping, just worth a one-line note in `schema.ts` rather than leaving it looking like an accidental inconsistency).

### T3 — `owners` gains auth-identity columns
Exact columns depend on Phase U's decisions (local password hash? OIDC subject mapping? both, since both auth modes must coexist per your ask), but at minimum: `external_subject TEXT UNIQUE` (OIDC `sub` → local owner mapping, as already sketched — but never built — in `I-identity-auth.md`), a way to distinguish "this owner signs in via Hub OIDC" vs "this owner signs in locally" (a `auth_kind` column, or simply: presence of `external_subject` means OIDC, presence of a password hash means local — either works; U should decide). **This ticket is intentionally left light here and detailed in U** — the columns are identity/auth concerns, T just reserves the fact that they're coming so the migration numbering and `resetDb`/backup-table-list updates can be planned together rather than twice.

### T4 — `sync_events.owner_id` becomes a real FK
Currently a value-only column (noted in Q's audit). Low risk, small ticket, natural to bundle with T1.

### T5 — Vocabulary sync
Update `GLOSSARY.md` to formally define "owner" as the tenant/user unit (assuming Option A), so the term is canon rather than implicit.

## What this phase deliberately does NOT do

- Does not build any login mechanism (Phase U).
- Does not build team/workspace sharing (only relevant if Option B is chosen instead — not planned here).
- Does not touch `scheduling_prefs`, recurrence columns, or run the S1/S2 table consolidations — unrelated, orthogonal cleanups.

## Migration safety, rollback & backup interaction (added in the 2026-07-01 review — parity with S's analysis)

T alters the two highest-traffic tables in the app (`time_blocks`, `tags`), so it needs the same integrity/rollback rigor S1 already documents — the original draft had none.

**Rollback model.** The runner (`server/src/db/migrate.ts`) is **forward-only — there is no `down()`**. Each migration runs in its own transaction (failure aborts that migration, leaving earlier ones applied and re-runnable). So "rollback" here means **restore from a snapshot/Litestream**, not a reverse migration. Therefore: **`pnpm snapshot` immediately before applying T**, and if Litestream is running, note the pre-migration timestamp so a point-in-time restore is possible within the retention window (`ops/litestream.yml`). Adding `owner_id` columns is additive/idempotent (`IF NOT EXISTS`-style, like Q's), so forward risk is low; the backfill `UPDATE` is the only data-touching step and is trivially reversible only via restore.

**⚠️ Critical backup/restore interaction (verified in `server/src/routes/backup.ts`).** The restore path today **full-wipes the owner-less tables** before reinserting — literally `sqlite.exec('DELETE FROM tags')` and `sqlite.exec('DELETE FROM time_blocks')` with the comment *"v0.2 single-owner: full wipe."* That is correct **only** while there is one owner. **The moment T gives `tags`/`time_blocks` a real `owner_