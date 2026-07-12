# Handoff — codebase audit → ship-readiness → multi-tenant RBAC (2026-07-12)

A single working session that audited the app end-to-end, fixed the ship-blockers, made it installable, hardened multi-tenant isolation, and produced the design for the operator/tenant role split. This is the cold-start summary: what shipped, what's open, and where to pick up.

## TL;DR

- **Merged:** #325 (data-flow ship-blockers), #326 (input-handling honesty), #327 (ship-readiness: license, first-run, profile, TZ, in-app Google setup).
- **Open, reviewed, green:** #328 (four cross-tenant data-leak fixes).
- **This PR:** design doc + this handoff for **Phase AG — multi-tenant RBAC** (`docs/AG-multitenant-rbac.md`). Implementation not started.
- **Migration head:** 0124 on main (`app_config` from #327). RBAC will add 0125.
- **Licensing note:** the project is **CI-Commercial-1.0, NOT MIT** (owner ruling; corrected in #327). Never describe it as MIT/open-source.

## What shipped this session

### PR #325 — data-flow ship-blockers (MERGED)
Three issues where the app misled a real user:
1. **Fixture data off by default.** `GOOGLE_MODE`/`MEMORY_MODE` unset now = **off** (was `fixture`, which silently ingested committed sample emails/events as real tasks every 30 min). Fixture is an explicit dev/demo opt-in; production refuses fixture unless `CP_ALLOW_FIXTURE=true`. Live ingest is gated per-owner on an active Google connection.
2. **Scrubbed the seeded developer identity** — migration 0122 turns the old `Liam / REDACTED-DEV-EMAIL@example.invalid` system owner into `System / NULL`; fresh installs seed neutral.
3. **Task completion mirrors onto calendar blocks** — `mirrorTaskStatusToBlocks` in `services/block-task-sync.ts`; checking a task off now completes its planner block (both directions), so finished work is no longer flagged "missed."

### PR #326 — input-handling honesty (MERGED, sibling session)
Inert Suggest/Schedule toggle repointed to `trust_mode` (dead `auto_mode` column dropped, migration 0123); quick-add routed through the shared `createTask` service; stars scoring made placement-path-independent; honest reset-request response when SMTP is unconfigured. Also corrected a stale audit claim: NL scheduling hints (`tag_before`/`batch`) *are* enforced (shipped in #174) — the code comments were stale.

### PR #327 — ship-readiness (MERGED)
- **License truth**: README/ARCHITECTURE + all package.json now say CI-Commercial-1.0 (was falsely "MIT").
- **The documented install actually boots**: the README `docker run` omitted `AUTH_MODE`, so the production image tripped its own `AUTH_MODE=test` guard and exited; the launchd plist crash-looped the same way. Fixed + added a working first-run walkthrough (local username/password login).
- **Profile editor**: `PATCH /api/owner/profile` + a Settings Profile card (all auth modes) — owners are no longer stuck as "System".
- **Timezone auto-adopt**: a UTC-defaulted install adopts the browser zone once per browser.
- **In-app Google connection setup** (migration 0124, `app_config`): an admin pastes a Google OAuth client in Settings → Connections and the connector flips to live at runtime — no env vars, no restart. Secret is KEK-sealed; `CP_MCP_COMMAND` now defaults to the bundled MCP server.
- Docs truth pass: versions → 0.3.0, migration heads → 0123, Node engines → `>=22`.

### PR #328 — cross-tenant data-leak fixes (OPEN, green)
The multi-tenant leak audit ran three parallel sweeps (REST/services, GraphQL/SSE/sync/export, schema/jobs/auth). **The planning-data core is fully owner-isolated** — tasks, blocks, tags, objectives, sync, SSE, export, and every GraphQL resolver/edge return "not found" for a cross-owner id. Four *edge* leaks were fixed:
1. **Timer** wrote onto another owner's task (`services/timer.ts`) — now validates task/block ownership + owner-scopes the aggregate write.
2. **Pattern membership** could reference another owner's task, leaking its title/estimate at placement (`services/patterns.ts`, `engine/patterns-place.ts`).
3. **Reminder** dispatcher could render another owner's task title (`services/notifications.ts`, `engine/reminders.ts`).
4. **Import** trusted per-row `owner_id` and could plant/overwrite another tenant's rows (`routes/backup.ts`) — now rejects foreign owner_id, forces the caller's, and drops junction rows referencing foreign parents.
New suite `server/test/tenant-isolation.test.ts` (8 cases). **Merge #328 before starting RBAC** — the RBAC work builds directly on this isolation baseline.

## The open decision this session couldn't close: RBAC

The audit's fifth finding is **not a data leak but a design gap**: `verifySession` (`server/src/lib/auth/session.ts:114`) grants every SSO/local session `[READ, WRITE, ADMIN]`, so under multi-tenant SSO every tenant is an admin (can reach `/api/jobs`, other tenants' job-run logs, and the server-global Google OAuth client). Fine for one-operator-per-box; a blocker for true SaaS.

The owner chose **true multi-tenant SaaS with a real operator/tenant role split**. The full design is in **`docs/AG-multitenant-rbac.md`**. Headline:
- One choke point to change: `session.ts:114` (derive scopes from a new `owners.role` column instead of the hardcoded triple).
- Three roles: `operator` (R+W+A), `member` (R+W), `viewer` (R). No new permission table — roles map onto existing scopes.
- New `routes/accounts.ts` (operator-gated) to create/list/manage accounts; reuses `provisionOwner` + `hashPassword` + `deleteOwner` (all test-proven).
- Migration 0125 adds `owners.role`, backfilling existing owners to `operator` (no lockout); OIDC auto-provision defaults new users to `member` (closes the auto-admin hole).

### Pick-up checklist for the next session
1. Merge #328 (isolation fixes) first.
2. Confirm the three defaults in the design doc's "Decisions" (three-role model, operator-set initial password, guard the last operator) — the owner did not explicitly ratify these; they were chosen as sensible defaults.
3. Implement per the doc's file table; write `accounts.test.ts` + the role-scoping cases; update `owners-auth`/`ciportal-auth`/`local-auth` for the new column.
4. Verify per the doc: migration backfill, member/viewer/operator scope gating, last-operator guards, and the E2E (operator sees Accounts UI, member does not).

## Repo facts worth carrying over
- **Windows/pnpm worktree**: run `pnpm install` in a fresh worktree; tests are `TZ=UTC pnpm vitest run` from `server/` and `client/`. Full server suite ~1,890 tests, client ~454.
- **Dev DB** lives at `~/Library/Application Support/CompanionPlanning/companion.db` even on Windows (macOS default path); starting the server applies pending migrations to it.
- **Auth modes**: `test` (dev, forbidden in production), `standalone` (hashed `x-api-key`, per-key scopes already supported), `sso` (CI-Portal OIDC or `DISABLE_OIDC` local username/password). Tests drive identity via `x-test-owner` / `x-test-scopes` headers.
- **Migration convention**: additive/idempotent TS functions, appended to the `MIGRATIONS` array in `db/migrations/index.ts`; gaps 0009 and 0119 are intentionally unused — don't reuse them.
- One trivial open PR unrelated to this work: **#324** (docs: require green CI before merge).
