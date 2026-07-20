# Handoff — 2026-07-20 codebase audit + full follow-up wave

> Read this box first. It's the state of the world at the end of the 2026-07-19/20 session.

## TL;DR

- **A full-codebase audit** (33 adversarially-verified findings) drove one fix PR and a
  seven-ticket follow-up wave. **Everything is merged to `main` except one recovery PR (#401)
  and this doc.**
- **Migration head is now `0133_item_colors`.** Next free slot: **`0134`**.
- **The dominant finding class was "built but no UI"** — server routes fully implemented and
  tested with zero client callers. Five of the seven follow-up tickets were UI wire-ups of
  exactly that; nothing new was invented server-side for them.
- **One live gotcha: PR #394 (objective accent) never reached `main`** — it merged into the
  stacked #393 branch instead. Recovered as **#401** (open). See "Merge accident" below.

## What shipped (all merged unless noted)

### The audit fix set — PR #393 (merged)
Eight verified correctness bugs, each re-checked against source before fixing:

1. **Task-cancel orphaned its Planner block.** `deleteTask()` never touched `time_blocks` and
   reflow's GC only sees `source_kind='agent'`, so a manually-placed block outlived its cancelled
   task at full opacity. New `cancelBlocksForTask()` in `services/block-task-sync.ts` settles
   active placements to `cancelled` (kept as review evidence, per the AE terminal-status
   doctrine); REST + GraphQL both broadcast `block:updated`. Client: PlannerChip / BlockCard /
   PlannerEntityCard now agree on the full terminal vocabulary.
2. **Disabling Google didn't stop the sync.** `getConnectors()`/`googleAccounts()` now gate on
   `config.google.mode === 'off'` — the single choke point every sync path sources from. Was:
   only *new* connections were gated; the 15-min cron kept pulling/pushing with stored tokens.
   Settings' Disconnect button no longer locked outside live mode.
3. **Backup dropped two live tables.** `life_priorities` + `planning_sessions` (migs 0127/0131)
   added to export, import, and `purgeOwnerData`. `EXPORT_VERSION` 8→9; v8 dumps still restore.
4. **DST day-bounds**: `clearDayAutoBlocks()` + `dayCategoryPlans()` now use the DST-aware
   `utcDayBounds()` their siblings already use.
5. **`MEMORY_MODE=fixture`** refuses production boot without `CP_ALLOW_FIXTURE`, mirroring the
   GOOGLE_MODE guard.
6. **Mobile nav** applied the operator gate to `/jobs`; `Jobs.tsx` guards `jobs.error` before
   reading the resource (the app mounts **no ErrorBoundary** — a 403 previously crashed render).
7. **Admin Jobs page** shows `items_updated` + the run log (half the job kinds report all work
   via `items_updated` with `items_created` pinned at 0).
8. **`objectives.create/update` return type** corrected to `ObjectiveRecord` (raw row) — the six
   tree-computed fields only exist on `GET /objectives`.

### The follow-up wave (Waves A + B) — PRs #395–#400 (merged), #401 (open)

| # | PR | Feature | Notes |
|---|----|---------|-------|
| #387 | #395 | **Free-text NL in Plan-my-week** | `InstructBox` (parse→preview→apply) in Fill + Schedule; truthful `llm_used` at both session-close sites. **Unblocks T14 (#350).** |
| #386 | **#401 (open)** | **Objective accent in the Planner** | Per-objective colour on member chips + user-token preference. Recovered (see below). |
| #388 | #396 | **Reminders card on Focus** | First UI for the reminders CRUD; task-targeted create sends `{taskId,date,time}` (server resolves owner-tz). |
| #389 | #397 | **Evening reflection trigger** | Author/Edit/Regenerate in the Brief's "Last night"; `(AI)` only on `llm===true`; empty-save deletes. |
| #390 | #398 | **Calibration combo-pins** | Settings panel for the §2.3 confirm loop; Pin sends original `tag_ids`, Unpin URL-encodes the `+`-joined ref. |
| #391 | #399 | **Type manager + per-item colours** | **Migration 0133.** `color_token` on `patterns`+`objectives`; `resolveItemColor` (item??type??primary) across every tint point; syncs cross-device. |
| #392 | #400 | **Dead-surface inventory** | Document-only; 10 rows commented in place; one user-visible change (Jobs Run-now tooltip states single-tenant scope). |

## Merge accident — PR #394 stranded (action needed)

**PR #394 reported MERGED but its code is not on `main`.** It was based on
`fix/audit-findings-2026-07-19` (stacked on #393). #393 fast-forwarded to main **before** #394
merged, so #394 merged into the now-orphaned #393 branch and the accent stranded on
`feat/planner-objective-accent`. Issue #386 stayed open.

**Recovery: PR #401 (open).** The stranded commit cherry-picked cleanly onto current main, plus
the planned `accentColor()` token-preference upgrade (unblocked now that #391's `color_token` is
live). **Merging #401 closes #386.** 595 client tests pass, build clean, empty server diff.

**Lesson (again):** don't stack a Factory PR on another open PR's branch and rely on GitHub to
retarget — base the second PR on `main` and note the dependency in prose, or merge the base PR
first and rebase. This is the third time the repo has hit this (see `project_q2_table_consolidation`
memory / PR #209).

## State of the board

- **Migration head:** `0133_item_colors`. Next slot **`0134`**.
- **Open PRs:** **#401** (accent recovery — merge to close #386) and the branch carrying this doc.
- **Open issues:** **#349 (T13)** is the next queued FTUE ticket — connections list; its recipe
  was re-pinned this session (Settings Disconnect no longer gates on live mode; a dead
  `GET /oauth/google/accounts` route is foldable into it). **#350 (T14, voice)** is unblocked by
  #387's `InstructBox` — its drafted DoD targets the *dead* PromptStep and must be re-pointed.
  **#351–#355 (M1–M5)** remain deferred (cross-owner event sharing).
- **Spike #361** is closed (decision: objective accent; docs/objectives-in-planner.md).
- **Drafts** for the whole wave remain under `docs/factory/drafts/` (audit-*.md +
  spike361_followup_objective_accent.md) — the as-built recipes, kept for reference.

## Verify commands (unchanged)

From `server/` and `client/`: `pnpm typecheck`, `pnpm test`, `pnpm build` (client). Server suite
~4 min, client ~30s — run in the background. On `main` at this head: server **2087 passed / 3
skipped**, client **595 passed**, both clean.

## Repo facts worth carrying

- **No `ErrorBoundary` anywhere** — a resource read that hits a 403/500 crashes the render.
  Several views guard `resource.error` before reading; new views must too. A dedicated
  ErrorBoundary ticket is still worth filing (flagged in the original audit, not yet ticketed).
- **`block_kind` is free-form TEXT on the write path by design** (block.graphql) — the API can
  create `focus`/`habit`/`break`/`buffer` blocks the UI never produces. `extend-block.ts`'s
  `isFixed()` doesn't treat focus/habit as fixed → a *reachable* edge, flagged in #392's comments,
  not yet fixed.
- **Ollama-only invariant** holds; every AI surface degrades deterministically. This box runs a
  real Ollama but the medium model (`gemma3n:e4b`) isn't installed, so `generateJson` 503s — the
  degrade paths are what you exercise locally.
- **Golden-shape tests** (`schema-parity`, `baseline.characterization`) pin the schema and force a
  deliberate snapshot update on any column change — 0133 updated them by +3 lines on purpose.
- **factory.sh** does NOT add the `[Factory]` title prefix (include it) and warns "project not
  found" (there's no board — benign).
