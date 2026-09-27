# Release-readiness plan — Opus review & fixes

**Date:** 2026-07-01 · **Reviewer:** Opus (auditing Sonnet's T–Y + S plan) · **Scope:** audit the `RELEASE-READINESS.md` / `S`–`Y` planning set against the actual codebase (schema, migrations, config, routes, client), fix the findings, and answer the production-readiness question.

> This is a companion to [RELEASE-READINESS.md](RELEASE-READINESS.md). Every claim below was checked against `server/src` at migration head **`0091`**, not against the docs' own assertions. The underlying plan is high quality — most of its specific code claims verified exactly (owners' 4 columns, the `PR2` markers, the `freeze-stars.ts` first-freeze check, the `.env.example` gap, `category-prefs.ts`'s "trimmed mirror" comment, `sync_events.owner_id` being value-only). The items here are the gaps, drift, and under-specced areas found on top of that.

---

## Bottom line on production-readiness

**Not production-ready after Phase S alone — and S isn't even the relevant gate.** S is table-count cleanup (`daily_recap`, `tag_prefs`); it changes nothing about whether the app can be released. The actual release-readiness work is **T → U → V** (multi-tenant scoping + OIDC/local auth + reset), and none of it is built — three of those docs are explicitly blocked on external inputs (Hub OIDC discovery doc, CI-Hub reset reference, CI-Server MCP vocabulary) that are still not provided. Also note the whole chain assumes **Phase Q has landed**, and it hasn't: the live head is `0091`, and Q's `0092`–`0094` (and therefore S's `0095`/`0096`) are still unwritten. The honest release gate is "T + U + V shipped and tested," not "S merged."

---

## Findings & fixes

Each finding lists what was wrong, the evidence, and what was changed. All doc edits are in-repo.

### 1. `S` contradicted the schema on `tags.kind` — **fixed**
`S-schema-consolidation.md`'s S2 note claimed `tags.kind` is *"already `'pattern'`|`'category'`"*. It is actually **three-valued** — `'pattern' | 'intention' | 'category'`, default `'intention'` (`schema.ts` line 238; `W` had this right). The merge itself is still sound (only pattern/category tags get prefs rows, so the `CHECK (kind IN ('pattern','category'))` on `tag_prefs` is correct), but the derivation rationale was written against a schema that doesn't exist.
**Fix:** rewrote the S2 note to state the real three-value taxonomy, explain why only two appear in `tag_prefs`, and warn against re-introducing the two-value assumption. Also corrected S's status line — see finding #7.

### 2. `ROADMAP` overstated auth as done — **fixed**
`ROADMAP.md` marked **Phase I** *"✅ done … JWKS verify-only · API-key store …"*. Only the API-key "standalone" path (PR1) shipped. The **JWKS SSO Bearer path (PR2) was never built** — `requireAuth.ts` and `config.ts` still carry `// (PR2)` markers and there is no `auth/jwks.ts` anywhere in `server/src` (the only JWKS code verifies Google's id_token for the calendar connector, unrelated to Hub login). `U` correctly identified this; the ROADMAP still advertised it as complete.
**Fix:** changed the Phase I row to ⚠️ **partial**, listing what shipped vs. what didn't, and pointing at Phase U as the completion path.

### 3. `schema.ts` was not a complete source of truth — **fixed (Drizzle is approved SoT)**
The docs repeatedly say things are "verified against `schema.ts`," but the Drizzle file had **drifted out of sync with the migrations**. Establishing ground truth: statically replaying every `CREATE`/`DROP`/`RENAME` across migrations `0001`–`0091` yields **47 live business tables**; `schema.ts` defined only **36**. Exactly **11 tables existed in raw-SQL migrations but were missing from Drizzle** (and zero phantom defs the other way):

`daily_summaries`, `daily_plan`, `replan_suggestions`, `plan_hints`, `pattern_day_optouts`, `reflections`, `objectives`, `objective_tasks`, `estimate_calibration`, `plan_outcomes`, `day_stars`.

Notably, three of these (`daily_summaries`, `plan_outcomes`, `day_stars`) are **S1's own merge targets**, and several are `owner_id`-scoped tables **T** must not miss. `schema.ts` had effectively stopped being maintained around migration ~0079.

**Fix (actual code change):** re-declared all 11 tables in `server/src/db/schema.ts`, matching the live migration shape exactly — TEXT UUIDv7 ids per the CON-1 convention, `references(...)`/`onDelete` as in the DDL, composite `primaryKey(...)` where the tables use one, and every later `ALTER ADD COLUMN` folded in and annotated with its migration number (e.g. `objectives.source_task_id` from 0086; `version`/`field_ts` from 0087; `reflections.source_kind`/`source_ref` from 0088; `daily_plan.outcome` from 0084). The `daily_summaries` shape reflects its post-`0030` TEXT-id rebuild. **No database change** — these mirror what the migration chain already produces; they just make Drizzle complete again. Added a clearly-labelled "SCHEMA RECONCILIATION" section header explaining why.

#### Decision: what "Drizzle is authoritative" means here (ADR, 2026-07-01)

The phrase splits into two claims that must not be conflated:

**(A) Drizzle `schema.ts` is the authoritative *source of truth* for schema shape — ADOPTED.** It is the single, complete description of the current schema and what everything types against. The reconciliation above restores that; the CI guard below enforces it.

**(B) drizzle-kit (`generate`/`migrate`) should replace the custom raw-SQL runner as the *migration mechanism* — REJECTED.** The custom forward-only runner (`server/src/db/migrate.ts`) exists to do things drizzle-kit's schema-diff DDL cannot:

- **Imperative, PRAGMA-sensitive migrations.** `0030` retypes every `id` `INTEGER→TEXT` (UUIDv7) via a full table rebuild that must toggle `PRAGMA foreign_keys` *outside* a transaction (hence the runner's `manual` migration mode) — a `DROP` under FK-on would cascade-delete children. drizzle-kit generates pure DDL diffs and cannot express this.
- **Data migrations / backfills.** `0079` backfills `field_ts` as computed JSON; other migrations seed rows and encode first-write logic. drizzle-kit does not generate data migrations at all.
- **SQLite is drizzle-kit's weakest dialect** for exactly the drop/rename/retype-via-rebuild cases this schema uses most.
- There is **no `./drizzle` snapshot dir** — drizzle-kit has never actually driven migrations here; the 91-migration custom chain is the battle-tested path. Replacing it would be a large, high-risk project whose main benefit ("no hand-written SQL") evaporates because you'd hand-write custom SQL into generated files anyway.

**Resulting model:** `schema.ts` = authoritative *description*; the raw-SQL runner = authoritative *execution*; a CI drift-check keeps them in agreement so (A) holds by enforcement, not vigilance. If drizzle-kit is ever wanted, the only sane form is **hybrid** — runner keeps data/rebuild migrations, drizzle-kit generates purely-additive schema migrations going forward — not a wholesale replacement.

**Enforcement (implemented in this change):** `server/src/scripts/check-schema-drift.ts` applies every migration to a throwaway DB, introspects it, and diffs table/column presence against the tables declared in `schema.ts`; it exits non-zero on any missing/extra table or column (NOT NULL / PK differences are warnings; type-affinity is intentionally not compared to avoid false positives). Wired as `pnpm --filter server db:check-drift` and added to `.github/workflows/ci.yml` right after typecheck. This makes the exact drift found here (11 missing tables) impossible to merge again. *(Not run in the review sandbox — no `better-sqlite3` build toolchain — but it runs in CI, where deps build normally.)* This ADR + the runner-vs-Drizzle rationale should also be reflected in `ARCHITECTURE.md`.

### 4. The plan was server-only; the client auth screens were unspecced — **fixed**
The client (`client/`, **SolidJS** + `@solidjs/router` + `lucide-solid` + CI-Hub color tokens — not React) has **no auth-gated routes today**; every route in `App.tsx` is open because test/standalone mode injects the owner. `AUTH_MODE=local` needs real UI that no doc owned.
**Fix:** added **U3 — Client-side login screen** to `U` (a `/login` route + `Login.tsx`, a `Shell` route guard that is a no-op outside `local` mode, a small `GET /api/auth/mode` so the SPA knows whether to show login, logout, and the "Forgot password?" entry point), and expanded `V` with a real **client-side surface** section (the reset modal, a `/reset-password` page, and the backup-email row in the existing Settings view). Both are specced in the app's own modal/design-token conventions, with DoD items added.

> **CI-Hub reference — still needed.** You asked to mirror CI-Hub's password modals. **CI-Hub's source is not in any connected folder** (only `Companion-Planning` is mounted — no CI-Hub repo, doc, or screenshot is reachable), so I could not use it as a reference. The client specs therefore follow *this app's* house style as a placeholder and are explicitly marked "reconcile against CI-Hub once its source/screenshots are provided." Share the CI-Hub login/reset components (or screenshots) and U3 + V's client section get matched to them exactly.

### 5. `T` had no migration-safety / rollback / backup analysis — **fixed**
`S` was rigorous about `integrity_check`, backup scope, and risk tier; `T` — which alters the two highest-traffic tables (`time_blocks`, `tags`) — had none. The important discovery: **`backup.ts`'s restore path full-wipes owner-less tables** (`sqlite.exec('DELETE FROM tags')`, `DELETE FROM time_blocks`, commented *"v0.2 single-owner: full wipe"*). That is correct only while one owner exists — **the moment T adds `owner_id`, those wipes become cross-tenant data loss** (restoring owner A would delete owner B's tags and calendar). The migration runner is also **forward-only (no `down()`)**, so "rollback" means snapshot/Litestream restore.
**Fix:** added a **"Migration safety, rollback & backup interaction"** section to `T` making the `backup.ts` fix (owner-scope the export selects and the delete/restore blocks) a **correctness/security gate in the same PR as the column addition**, plus pre-migration `pnpm snapshot`, `foreign_key_check`/`integrity_check`, and a zero-NULL-`owner_id` test. Added matching DoD items.

### 6. Minor factual drift — **fixed**
- `W` said the REST API is "28-router." Actual: **29 router files** under `server/src/routes/` (excluding `index.ts`). Corrected.
- `Y` said `.env.example` "documents … the four `OLLAMA_*` vars, `PORT`, `DB_PATH`." Those six are present **only as commented-out examples**; the only active lines are the three VAPID vars. Corrected the wording (the substantive 20+-var gap Y identifies is real and unchanged).

### 7. Dependency-chain premise (`Q` hasn't landed) — **flagged in S**
`S` reserved migrations `0095`/`0096` "after Q's `0094`," but the live head is `0091` — Q's `0092`–`0094` are unwritten. The reserved numbers are provisional.
**Fix:** updated `S`'s status line to record the verified head (`0091`), confirm S1/S2 don't exist in code yet, and instruct re-verifying the head before assigning numbers.

---

## What was changed, by file

| File | Change |
|---|---|
| `server/src/db/schema.ts` | **Code:** added the 11 missing table definitions (finding #3), matched to live migration shape. |
| `server/src/scripts/check-schema-drift.ts` | **Code (new):** CI drift guard — migrates a throwaway DB, diffs tables/columns against `schema.ts`, fails on drift (finding #3 enforcement). |
| `server/package.json` | Added `db:check-drift` script. |
| `.github/workflows/ci.yml` | Added a "Schema drift check" step after typecheck. |
| `docs/S-schema-consolidation.md` | Fixed `tags.kind` note (#1); corrected status/migration-head premise (#7). |
| `docs/ROADMAP.md` | Phase I "done" → "partial," JWKS/PR2 not shipped (#2). |
| `docs/U-oidc-local-auth.md` | Added U3 client login screen + route guard + `/api/auth/mode`; DoD (#4). |
| `docs/V-password-reset.md` | Added client-side surface (reset modal, `/reset-password`, Settings backup-email); DoD (#4). |
| `docs/T-multi-tenant-users.md` | Added migration-safety/rollback + `backup.ts` cross-tenant-wipe analysis; DoD (#5). |
| `docs/W-graphql-crud.md` | Router count 28 → 29 (#6). |
| `docs/Y-env-configuration.md` | Clarified commented-vs-active `.env.example` vars (#6). |
| `docs/RELEASE-READINESS-REVIEW.md` | This document. |

## Open items still needing you (not code — inputs)

1. **CI-Hub source/screenshots** — to reconcile U3 + V's client auth screens to CI-Hub (finding #4).
2. **Hub OIDC discovery doc + client-registration process** — unblocks U from draft to buildable.
3. **CI-Server MCP vocabulary spec** — unblocks X's real gap analysis.
4. **Tenant-model sign-off** (T Open Decision #1 — Option A recommended) and the `owners`-rename decision (#2 — keep `owners` recommended).
5. ~~A CI drift-guard for `schema.ts`~~ — **done** (`db:check-drift` + CI step; see finding #3 ADR). Remaining: reflect the runner-vs-Drizzle decision in `ARCHITECTURE.md`, and run the drift check once in CI to confirm the reconciled `schema.ts` passes.
