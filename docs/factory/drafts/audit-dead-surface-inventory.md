> **Type:** Chore · **Phase:** Audit follow-up (2026-07-19) · **Branch:** `chore/dead-surface-inventory` · **Commit style:** `chore: deprecation comments on confirmed-dead surfaces` · **Design:** the 2026-07-19 full-codebase audit (33 adversarially-verified findings) · **Dependencies:** none (but see "Excluded" — six surfaces leave this list when their build tickets land)

## Goal

Mark every **confirmed-dead** surface in the codebase with an explicit deprecation comment stating
(a) that it has zero live callers, (b) the audit that established it, and (c) what would revive or
remove it — so no future reader mistakes dead code for load-bearing code. **Owner ruling: delete
nothing.** This is documentation only.

## Non-goals

- **Do not delete any file, route, method, column, or test.** The owner explicitly chose
  document-only over deletion (2026-07-19).
- **Do not build any UI** for these surfaces — the ones worth building got their own tickets.
- Do not change any behavior, signature, or export. `git diff` must be comments + this issue only.

## Excluded (dead today, but a build ticket revives them — do NOT mark these)

These audit findings are intentionally absent from the inventory below because an approved ticket
from the same decision session gives each its first live caller:

| Surface | Revived by |
|---|---|
| `api.reminders.list/create/remove` + reminders CRUD routes | Reminders card on Focus |
| `POST/PUT /api/reflections/evening*` | Evening reflection trigger |
| `GET /api/calibration/scopes`, `POST/DELETE /api/calibration/pins` | Calibration combo-pins UI |
| `api.patternTypes.create/update/delete` + pattern-type CRUD routes | Pattern-type manager + colors |
| `PromptStep`, `api.planWeek.parse`, `api.plan.instruct` + `instructPlan` | Free-text NL in Plan-my-week |
| `planning_sessions.llm_used` (never set true) | Free-text NL ticket (truthful close) |

## The inventory (each row gets a deprecation comment at the cited site)

All verified against `main` @ 280183f + `fix/audit-findings-2026-07-19`; re-grep before commenting
— a surface that gained a caller since drops off the list.

| # | Surface | Site(s) | Comment must say |
|---|---|---|---|
| 1 | `api.tasks.reschedule(id, days)` | `client/src/lib/api.ts:128-129`, `server/src/routes/tasks.ts:343-358`, `rescheduleTask` in the engine | Zero callers. Superseded by Today's DueCard `+1d/+3d/+1w` defer, which moves `due_at` via `tasks.update` on purpose (this endpoint moves `scheduled_for` — the wrong axis for the shipped affordance, see `Today.tsx:357-359`). |
| 2 | `api.tasks.recall(id)` + `POST /tasks/:id/recall` + the Settings "Recall keeps Routine membership" toggle | `client/src/lib/api.ts:131`, `server/src/routes/tasks.ts:328-337`, `Settings.tsx:1063-1064` (`recall_keeps_pattern`) | No Recall action exists anywhere in the UI, so the endpoint is unreachable AND the live Settings toggle silently governs nothing. The toggle's comment must say this explicitly. |
| 3 | `api.patterns.get`, `api.patterns.promoteFromPlan`, `api.flightPlan.addPattern`, `api.memory.suggest`, `api.llm.status`, `api.dayTypes.assignments`, `api.reflections.delete`, `api.objectives.recompute` | `client/src/lib/api.ts:184, 205-206, 227-228, 339, 378, 404, 445, 478` | Each: typed wrapper with zero call sites; the server route is live and tested. One-line comment per method. `api.memory.suggest` additionally notes it is the intended "pull now" UX trigger if ever surfaced. |
| 4 | `GET /api/oauth/google/accounts` | `server/src/routes/oauth.ts:300-311` | Zero client callers — Settings sources accounts from `GET /api/integrations` (richer). T13 (#349) may delete it during the `disconnectConnection()` extraction; until then this comment is the marker. |
| 5 | `client/src/views/Patterns.tsx` | whole file, lines 1-25 | Unreachable: neither router imports it and both map `/patterns` to an unconditional `<Navigate href="/tasks" />` (`App.tsx:255,281`). Its own "reached only by stale deep-links" comment is FALSE — replace that comment with an accurate one. |
| 6 | `SLOT_MIN` | `client/src/lib/planner.ts:15` | Zero importers repo-wide. |
| 7 | `scheduled_jobs.next_run_at` | `server/src/db/schema.ts:507`, `server/src/graphql/job.graphql:26` | Defined + exposed over REST/GraphQL, never written (`startCronJobs` discards the `Cron` instance; croner's `.nextRun()` could supply it). The graphql comment already says "currently always null" — mirror it schema-side. |
| 8 | `vapidConfigState()` | `server/src/services/vapid-config.ts:242-254` | Diagnostic mirroring `googleConfigState()`, but no route exposes it (google's has `GET /api/google-config`); only its test calls it. An operator diagnosing dormant push must read server logs today. |
| 9 | Vestigial `block_kind` branches: `'focus'/'habit'/'break'/'buffer'` | `client/src/components/Planner.tsx:665`, `client/src/views/Today.tsx:84`, `client/src/components/CalendarGrid.tsx:25-32`, `server/src/engine/reminders.ts:37`, `server/src/engine/extend-block.ts:71-79` | No UI or server INSERT produces these kinds — but the REST/GraphQL write path accepts `block_kind` as free-form TEXT **by documented design** (`block.graphql:10-14`), so an API caller can create them today. `extend-block.ts`'s `isFixed()` deliberately(?) omits focus/habit — the comment must flag that as a reachable edge, not dead code. |
| 10 | Admin "Run now" tenant scope | `server/src/routes/jobs.ts:48-54` (+ `client/src/views/Jobs.tsx` Run-now button `title`) | Not dead code — a documented behavior gap: manual run executes only the clicking operator's tenant; the cron fans out per-owner (`jobs/index.ts:429-431` already documents it server-side). Add the same fact to the button's `title` tooltip so operators see it. |

## Pinned conventions

- Comment style: this repo writes constraint-stating comments, not history notes — each comment
  states the CURRENT fact ("zero live callers; the shipped defer affordance uses tasks.update on
  the due_at axis instead") and what changes it, never "removed in audit X" narration alone.
  Reference this issue number once per comment for traceability: `(dead surface — see #NNN)`.
- Item 10's tooltip is the single permitted user-visible string change:
  `title="Runs for YOUR account only — the scheduled cron runs every account"` on the Run-now
  button in `client/src/views/Jobs.tsx` (exact anchor: the `Run now` button, currently ~line 70).

## Before implementation

1. Re-grep every inventory row for new callers (`grep -rn "<symbol>" client/src server/src`) —
   drop any row that gained one, and say so in the PR body.
2. Read `Today.tsx:340-393` (DueCard defer) before writing item 1's comment — the comment must
   name the real replacement accurately.
3. Read `server/src/jobs/index.ts:429-444` before item 10 — mirror its wording.

## Files impacted

**Changed (comments only, except item 10's tooltip):**
- `client/src/lib/api.ts` — items 1, 2, 3
- `server/src/routes/tasks.ts` — items 1, 2
- `client/src/views/Settings.tsx` — item 2 (toggle comment)
- `server/src/routes/oauth.ts` — item 4
- `client/src/views/Patterns.tsx` — item 5
- `client/src/lib/planner.ts` — item 6
- `server/src/db/schema.ts` — item 7
- `server/src/services/vapid-config.ts` — item 8
- `client/src/components/Planner.tsx`, `client/src/views/Today.tsx`,
  `client/src/components/CalendarGrid.tsx`, `server/src/engine/reminders.ts`,
  `server/src/engine/extend-block.ts` — item 9
- `server/src/routes/jobs.ts`, `client/src/views/Jobs.tsx` — item 10

**New:** none.

## Schema required

**None.**

## Definition of Done

- [ ] Every inventory row's site carries a deprecation/status comment matching the "Comment must
      say" column, referencing this issue.
- [ ] Rows that gained callers since the audit are dropped and listed in the PR body.
- [ ] Item 10's Run-now tooltip states the single-tenant scope.
- [ ] Nothing else changed: no deletions, no behavior, no exports. `git diff --stat` shows only
      the files above.

## Tests

No new tests (comments only). The suites stay green:

- [ ] `pnpm --filter server typecheck` · `pnpm --filter server test`
- [ ] `pnpm --filter client typecheck` · `pnpm --filter client build` · `pnpm --filter client test`

## Acceptance Criteria

- [ ] A reader landing on any inventoried surface learns within one comment that it is dead, why
      it exists, and what would revive/remove it.
- [ ] The owner's delete-nothing ruling is honored — zero deletions in the diff.
- [ ] Operators can see from the Jobs page itself that Run-now is single-tenant.

## Subtasks

1. [ ] Re-verify all 10 rows for new callers; drop + report any that gained one.
2. [ ] Write the comments for items 1-9 (client files, then server files).
3. [ ] Item 10: server comment cross-reference + the Jobs.tsx tooltip.
4. [ ] Run the five verification commands; open the PR with the drop-list in the body.
