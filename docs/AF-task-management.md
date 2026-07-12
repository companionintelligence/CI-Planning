# Phase AF — Task-management consolidation

**Status: SHIPPED (all tickets AF-1 … AF-11 + AF-CU1/AF-CU2 merged to main by 2026-07-12; migrations 0118–0121). The ticket text below is preserved as the as-planned record.**

Owner asks (verbatim numbering from the request):

1. Move Objectives out of the nav into the TASKS view; tab order **TASKS / OBJECTIVES / HABITS / ROUTINES / TIMEBLOCK**; a **+** on an objective quick-adds a task as a subtask (title-only, everything else behind "more details"); all tasks with subtasks show on the Objectives tab.
5. Button on task cards to quickly assign a task to an objective.
6. Remove the Inbox; all incoming items become tasks directly, grouped in a **"New Today"** section that empties into the general list at night.
7. Saving a time block as a template is a **user action** (not automatic); fix the save-as-template flow to upsert by name so the TASKS > TIMEBLOCK tab doesn't collect duplicates.
8. Time blocks carry a primary tag (WORK / HOME / COMMUNITY) **plus** secondary tags.

## Owner decisions (2026-07-11)

| # | Decision |
|---|----------|
| a | **Auto-promote ALL** ingestion suggestions into real tasks — no confidence threshold, no trust-mode gate for promotion. |
| b | "New Today" is **date-derived** (`created_at` = owner-local today). No schema column, no nightly job; the section empties itself at the owner-local midnight rollover, same mechanism as the Archive rollover in `AllTasks.tsx`. |
| c | **Do NOT auto-create templates on block save.** Saving a time block as a template stays an explicit user action; fix that action to **upsert by name** so repeat saves update rather than duplicate. |
| d | **Relax the tag-XOR-category guard** — a time block may carry both a direction tag and a category (this was already the documented Phase AD intent; the service guard was never relaxed). |

## Current-state findings (code-verified 2026-07-11)

### Navigation / Tasks view
- Routes are registered twice in `client/src/App.tsx` (gated router ~217–232, ungated `UngatedRouter` ~239–254); views are eagerly imported (no lazy registry). `/patterns → /tasks` redirect at App.tsx:227/248 is the precedent for retiring a route.
- `client/src/views/AllTasks.tsx` already has tabs: `type Tab = 'tasks'|'habits'|'routines'|'timeblocks'` (line 54), **signal state only — not URL-synced** (line 55). Tab buttons at 196–231; Routines/Time Blocks tabs mount extracted panels (`RoutinesPanel`, `TimeBlocksPanel`) — the exact extraction pattern to reuse for Objectives.
- Task sections (Open / Scheduled / Routine) are derived lists rendered through the reusable `ArchiveSection` collapsible (AllTasks.tsx:336–368). The Archive split is **date-derived** ("done today stays active until the day rolls over", comment at 34–36, via `localISODate()`) — the model for "New Today".
- `client/src/views/Objectives.tsx` renders the recursive tree (`ObjectiveNode` :138), reads `?focus=<id>` deep-links (:45–46). Deep-link producer: the 8-point star on `TaskCard.tsx:327` → `/objectives?focus=…`.
- Nav entries: `Nav.tsx:14` (Inbox, with `possibles` badge, and a separator comment at :79), `Nav.tsx:16` (Objectives); `BottomNav.tsx:10` (Inbox in the primary bar), `BottomNav.tsx:15` (Objectives in the More sheet).

### Objectives data model
- `objectives` self-nest via `parent_id`; `level` is derived height-from-bottom (leaf = `'objective'`, holds tasks). Tasks↔objectives is the M:N `objective_tasks` join with `linked` tombstones; **no `objective_id` column on tasks** — the API field is derived (first linked objective).
- Server guards in `server/src/services/objectives.ts`: **leaf-only linking** (`linkTaskToObjective` → `non_leaf` 422, :470), containment (can't nest under task-bearing objective), cycle guard.
- `api.objectives.linkTask/unlinkTask` already exist client-side (`client/src/lib/api.ts:457–458`).
- Tasks already support subtasks (`tasks.parent_id`; `GET /api/tasks/:id/subtasks`; TaskCard renders nested cards). **Auto-promotion already exists**: a task that gains a subtask is promoted to a leaf objective and parent+subtasks linked (`server/src/services/task-promotion.ts`, called from `services/tasks.ts`). So ask 1.4 is mostly a *rendering* gap: REST `buildTree` (:144) returns only `next_action` + `has_tasks` per node — it does not return the linked task list (GraphQL `ObjectiveType.tasks` does).
- Objective sync (field-LWW, `server/src/sync/apply.ts`) operates on rows, not views — the move is sync-neutral. `stampRow` calls live inside the service; any new link/create path must go through the service (it already does).

### Inbox / possibles pipeline
- The "Inbox" (`client/src/views/Inbox.tsx`, route `/inbox`) renders **`possible_tasks`** ("possibles") — suggestions from `agents/ingest.ts` (Gmail/GCal), `agents/memory-suggest.ts` (Phase AA), groomed by `agents/groom.ts`. Manually created tasks never touch it.
- Promotion is centralized in `server/src/services/possibles.ts` (`promotePossible`: copies fields + tags, flips status, audit-writes, and the caller broadcasts `possible:promoted` **before** any auto-schedule placement — SSE-order contract tested in `possibles.test.ts`).
- **`trust_mode`** (`scheduling_prefs.trust_mode`, migration 0070; helper in `engine/autoplan.ts:996–1024`) currently gates auto-promotion: `cautious` = never, `balanced` = ≥0.7, `hands_off`. Auto-promote-all makes the *promotion* facet of trust_mode dead; the *auto-block/planning* facets stay (plan.ts:76, autoplan block gating).
- Grooming: seeded crons (migration 0003) `promote_possibles` (02:00) and `nightly_grooming` (dedupe→surfaceOverdue→promote, jobs/index.ts:116–131). **`dedupePossibles` does embedding-based semantic dedupe on *pending* rows** — if promotion happens at ingestion, dedupe must run inline (per ingestion batch, before promoting) or cross-source duplicates become real tasks. Same-source re-ingest is already blocked by UNIQUE(owner, source_kind, source_ref) (mig 0114).
- Full possibles surface: REST `routes/possibles.ts`, GraphQL `possible-task.graphql` + resolvers (promote/dismiss mutations, SSE parity), client `api.possibles` (api.ts:271), `possibles` store resource + SSE handlers (`stores/index.ts:182–187`), nav badges (Nav/BottomNav), Settings copy ("…into Inbox suggestions", Settings.tsx:1147), backup/export coverage (keep — table stays).

### Time blocks / tags
- `work`/`home`/`community` already exist as seeded, undeletable base **direction** tags (mig 0036, `is_base=1`). The wizard's timeblock branch already has a direction picker (ElementWizard.tsx:445–469 → `time_blocks.tag` + `entity_tags` level 1) and a category picker (:471–489 → `category_id`).
- **Secondary tags are fully plumbed server-side** (`secondary_tags` accepted on create/update, synced to `entity_tags` level 2 via `applyBlockTagLevels`, returned by the read API) but have **no authoring UI** in the timeblock wizard branch (the `TagSection` chip UI is gated to non-timeblock kinds at ElementWizard.tsx:442).
- **XOR conflict**: `services/blocks.ts` rejects tag+category (`tag_and_category`, :228 create / :361 update); mirrored in `routes/blocks.ts:87/131` and `graphql/block-resolvers.ts:136/151`; asserted in `blocks-service.test.ts:85`. Meanwhile `docs/AD-calendar-reliability.md` documents coexistence and `lib/element.ts` sends both — **picking a direction and a category errors on save today**. Decision (d) resolves this: remove the guard.
- Templates (`block_templates`) are only created manually: `PlannerEntityCard.tsx:171` (Planner ★ → "Save as template") and `FlightPlan.tsx:333`; server entry points `services/block-templates.ts:113` (`createBlockTemplate`), REST POST, GraphQL mutation. No upsert anywhere → repeat saves duplicate by name.
- ⚠️ Engines lazily regenerate recurring blocks on `GET /api/blocks` (two engines; see pattern-regen gotcha, PR #181). Any template hook must never sit on engine placement paths — decision (c) avoids this entirely by keeping template creation user-initiated.

### Migration numbering
Head is **0117** (`0117_push_memory_job`). This phase claims **0118** (AF-3). Renumber at merge if another lane lands first (PRAGMA-guarded, cosmetic).

## Cross-cutting invariants

- All LLM/embedding work stays on the Ollama seam (`mcp/ollama.ts`) — AF-3's inline dedupe reuses `dedupePossibles`, which already degrades deterministically when embeddings are unavailable.
- Owner scoping everywhere: possibles by `proposed_owner_id`, tasks/objectives/blocks by `owner_id`. "Today" = **owner-local** date (`localISODate()` client-side; owner-tz helpers server-side).
- Sync: objectives/objective_tasks writes must keep flowing through `services/objectives.ts` (stampRow). Task creation through `POST /api/tasks` / quick-add is already sync-covered.
- SSE-order contract: `possible:promoted` broadcasts before any placement broadcast it triggers (possibles.test.ts) — preserve in the auto-promote path.
- Client: Solid memos component-scoped only (module-scope memo TDZ gotcha).

---

# Tickets

Ticket ID convention: `AF-<n>`. Each is one PR off fresh `main`. Waves = merge barriers: a wave's tickets run in parallel worktrees with no overlapping files; the next wave starts after the previous wave merges.

**Definition of done (applies to every ticket, in addition to per-ticket items):**
- `pnpm --filter server test` and `pnpm --filter client test` green; `tsc` clean in both packages (worktrees: `pnpm install --frozen-lockfile` first).
- No behavior change outside the ticket's scope; screenshots for UI tickets.
- Docs touched by the change updated in the same PR (this doc's ticket table status + any referenced doc).

---

## Wave 1 — foundations (4 parallel lanes, zero file overlap)

### AF-1 · Move Objectives into the Tasks view (asks 1.1, 1.2)

**Goal:** Objectives is a tab inside `/tasks` (order: TASKS / OBJECTIVES / HABITS / ROUTINES / TIMEBLOCK); no top-level Objectives nav item; Tasks tabs are URL-synced so deep-links survive.

**Scope / approach:**
- Make `AllTasks` tabs URL-driven: `/tasks?tab=<tasks|objectives|habits|routines|timeblocks>` via `useSearchParams` (replace the bare signal at AllTasks.tsx:55; default `tasks`; unknown values fall back to `tasks`).
- Extract the tree body of `views/Objectives.tsx` into `components/ObjectivesPanel.tsx` (pattern: RoutinesPanel/TimeBlocksPanel extraction from Patterns.tsx). The panel keeps `ObjectiveNode`, `LevelIcon`, `ObjectiveModal` mounting, and the `focus` behavior — but reads `?focus=` from `/tasks` search params.
- Add the `objectives` tab (button + `<Show>`) in second position; rename the `timeblocks` tab label to **"Timeblock"** per the spec'd order naming.
- Replace both `/objectives` routes (App.tsx:226/246) with a redirect to `/tasks?tab=objectives` that **forwards the `focus` query param** (the `/patterns` redirect at :227/248 is the template but does not forward params — this one must).
- Update the TaskCard objective star (TaskCard.tsx:327) to navigate to `/tasks?tab=objectives&focus=…`. (Single-line change here; AF-6 owns the rest of TaskCard.)
- Remove Objectives from `Nav.tsx:16` and `BottomNav.tsx:15`. Delete `views/Objectives.tsx` once the panel extraction compiles (keep `lib/objectives.ts` — used by DayGoals weekly-focus typeahead).

**Acceptance criteria:**
- `/tasks` shows five tabs in the specified order; tab choice is reflected in and restorable from the URL (reload lands on the same tab).
- `/objectives` and `/objectives?focus=X` redirect to `/tasks?tab=objectives` (+`focus=X`) and the tree auto-expands/scrolls to X, exactly as the old view did.
- Objectives appears in no nav surface (desktop nav, mobile primary bar, mobile More sheet).
- New Objective / edit / delete / add-child flows work unchanged inside the tab.
- No dead exports: `views/Objectives.tsx` removed; imports in App.tsx cleaned.

**Tests:**
- Client: unit tests for the tab⇄searchParam mapping helper (extract as a pure function so it's testable without jsdom); existing `lib/objectives.test.ts` stays green.
- Manual verification in the preview browser: tab order, redirect + focus deep-link from a task card's star, mobile More sheet.

**Impacted files:** `client/src/App.tsx`, `client/src/components/Nav.tsx`, `client/src/components/BottomNav.tsx`, `client/src/views/AllTasks.tsx`, `client/src/views/Objectives.tsx` (deleted), `client/src/components/ObjectivesPanel.tsx` (new), `client/src/components/TaskCard.tsx` (one nav line).

---

### AF-2 · Objectives tree API returns linked tasks per leaf (enables 1.3, 1.4)

**Goal:** `GET /api/objectives` includes, for each **leaf** objective, its linked open tasks so the client can render tasks under objectives without N+1 fetches.

**Scope / approach:**
- Extend `buildTree` (`server/src/services/objectives.ts:144`) to attach `tasks: TaskSummary[]` on leaf nodes (`linked = 1` rows joined to non-cancelled tasks; minimal fields: id, title, status, priority, due_at, scheduled_for, parent_id, completed_at). One batched query for the whole forest, not per-node.
- Keep GraphQL parity: `ObjectiveType.tasks` already exists; assert both surfaces return the same task id set.
- Do NOT change write paths — leaf-only/containment guards untouched.

**Acceptance criteria:**
- Tree response includes per-leaf task arrays; non-leaf nodes have none; `next_action`/`has_tasks` unchanged (no client regression before AF-5 lands).
- A task promoted via subtask-creation (task-promotion) appears under its auto-objective in the tree response — this is the server half of ask 1.4.
- Response stays owner-scoped; cross-owner isolation test for the new field.

**Tests:** server vitest — tree includes linked tasks; excludes `linked=0` tombstones and cancelled tasks; batched-query shape (no per-node prepare in a loop); REST/GraphQL parity; multi-owner isolation.

**Impacted files:** `server/src/services/objectives.ts`, `server/src/routes/objectives.ts` (serialization if any), `server/test/` (objectives tree tests; add file if none covers buildTree shape).

---

### AF-3 · Auto-promote all suggestions at ingestion (server half of ask 6)

**Goal:** Every `possible_tasks` row becomes a real task immediately — the Inbox review step disappears from the pipeline. `possible_tasks` remains as the dedup/audit trail.

**Scope / approach:**
- Add a shared post-ingest step (in `services/possibles.ts`, e.g. `promoteAllPending(owner)`) that: (1) runs `dedupePossibles` on the pending set (inline semantic dedupe — this is the nightly groom step moved up; embeddings unavailable → skip gracefully per existing fallback), then (2) promotes every surviving pending row via the existing `promotePossible` service (preserves tag carry-over, audit rows, and the `possible:promoted`-before-placement SSE order).
- Call it at the end of each producer batch: `agents/ingest.ts` (Gmail/GCal) and `agents/memory-suggest.ts`.
- Promotion is **unconditional** — remove the trust-mode gate from `groom.promotePossibles` promotion decisions; `trust_mode` keeps governing auto-blocking/planning only. Update the tri-state doc comments (schema.ts:225–228, autoplan.ts:996–1023, mig 0070 header comment) so the semantics are honest.
- Keep `nightly_grooming` as a sweeper (it now promotes stragglers from crashed batches; its dedupe step is usually a no-op). **Migration 0118**: delete the now-redundant standalone `promote_possibles` scheduled_jobs row (nightly_grooming subsumes it); keep the `execute()` case for manual runs.
- REST/GraphQL promote+dismiss endpoints stay (API surface, sweeper, external clients).

**Acceptance criteria:**
- After an ingestion run, zero rows remain `status='pending'` (each is `promoted` or `duplicate`); created tasks carry the proposed fields + tags exactly as manual promotion did.
- `cautious` trust mode no longer withholds promotion (test updated deliberately); auto-blocking behavior under trust modes unchanged.
- SSE order contract preserved (`possible:promoted` before any placement event).
- `promote_possibles` cron row gone after 0118; `nightly_grooming` still runs and promotes any leftover pending rows.

**Tests:** update `trust-mode.test.ts` (promotion facet), `possibles.test.ts` (SSE order via the batch path), `memory-suggest.test.ts` + `ingest-no-mirror.test.ts`/`gmail-cursor.test.ts` (end state = promoted tasks), `jobs.test.ts` (cron row removal + sweeper), `dedupe.test.ts` (inline dedupe marks duplicates before promotion), `audit.test.ts` (audit rows still written). New: batch with duplicates → one task; embeddings-down → all promoted, none lost.

**Impacted files:** `server/src/services/possibles.ts`, `server/src/agents/ingest.ts`, `server/src/agents/memory-suggest.ts`, `server/src/agents/groom.ts`, `server/src/jobs/index.ts`, `server/src/engine/autoplan.ts` (comments), `server/src/db/schema.ts` (comments), `server/src/db/migrations/0118_retire_promote_possibles_cron.ts` (new) + `migrations/index.ts`, `server/test/*` per above.

---

### AF-4 · Relax the tag-XOR-category guard on time blocks (ask 8 pre-req; decision d)

**Goal:** A time block may carry a direction tag **and** a category simultaneously, matching the documented Phase AD contract.

**Scope / approach:**
- Remove the XOR checks in `services/blocks.ts` (:228 create, :361 update) and the `tag_and_category` variants from both result types (:212, :321).
- Remove the dead 422 branches in `routes/blocks.ts` (:87, :131) and the GraphQLError branches in `graphql/block-resolvers.ts` (:136, :151).
- Define color precedence when both are set (keep current behavior: `color_token` frozen from category at create wins; direction styling unchanged) — assert it in a test rather than leaving it implicit.
- Update `blocks-service.test.ts:85` from rejection to coexistence; note the change in `docs/AD-calendar-reliability.md` (the doc already claims coexistence — add "guard relaxed in AF-4").

**Acceptance criteria:**
- Creating/updating a block with both `tag` and `category_id` succeeds via REST and GraphQL; both persist and both come back on the read API (`tag`, `secondary_tags`, `category_id`).
- The wizard's existing direction+category double-pick (which errors today) saves cleanly — verified in preview.
- No `tag_and_category` string remains in the codebase.

**Tests:** blocks-service coexistence (create + update, REST + GraphQL), color precedence, entity_tags level-1 sync still correct when category also present.

**Impacted files:** `server/src/services/blocks.ts`, `server/src/routes/blocks.ts`, `server/src/graphql/block-resolvers.ts`, `server/test/blocks-service.test.ts`, `docs/AD-calendar-reliability.md`.

---

## Wave 2 — features on the new foundations (4 parallel lanes)

### AF-5 · Objectives tab: tasks under leaves + "+" quick-add subtask (asks 1.3, 1.4) — needs AF-1 + AF-2

**Goal:** Leaf objectives list their linked tasks; a **+** on a leaf objective quick-adds a task by title alone, with "More details" escaping to the full wizard.

**Scope / approach:**
- In `ObjectivesPanel`/`ObjectiveNode`, render the AF-2 `tasks` array under each expanded leaf (compact rows: done-toggle + title + due; not full TaskCard — keep the tree scannable). Tasks-with-subtasks already surface as auto-promoted objectives (server behavior), so ask 1.4 is satisfied by rendering; verify end-to-end.
- **+** affordance on leaf objectives only (`level === 'objective'`; non-leaves keep only the existing "Add child" objective action). Inline input: Enter creates via `POST /api/tasks` (title only) then `api.objectives.linkTask(objective.id, task.id)`; if the objective has `source_task_id`, create with `parent_id = source_task_id` instead and let task-promotion auto-link (keeps the subtask nested on the Tasks tab too).
- "More details" opens `ElementWizard` add-task mode prefilled (title if typed; `parentId` when source_task_id exists); on save, ensure the objective link is applied (linkTask after save when no source task).
- Handle the `non_leaf` 422 defensively (stale tree): toast + refetch.

**Acceptance criteria:**
- Expanding a leaf objective shows its open linked tasks; completing one from the row updates progress (existing recompute path) without a reload.
- **+** on a leaf: type title, Enter → task exists, is linked, appears immediately under the objective (SSE/optimistic). No other field required. Esc cancels.
- "More details" round-trips into the wizard and the resulting task is linked.
- A task given a subtask elsewhere in the app appears on the Objectives tab as an objective with its tasks (1.4 end-to-end).
- Non-leaf objectives show no task quick-add.

**Tests:** client — pure helpers (leaf detection, create-then-link sequencing incl. source_task_id branch); server already covered by AF-2. Preview walkthrough with screenshots: quick-add, more-details, 1.4 promotion flow.

**Impacted files:** `client/src/components/ObjectivesPanel.tsx`, `client/src/components/ObjectiveModal.tsx` (only if prefill needs plumbing), `client/src/lib/api.ts` (types for tree tasks), `client/src/stores/*` (refetch wiring if needed).

---

### AF-6 · Assign-to-objective on task cards (ask 5) — needs AF-1 (TaskCard conflict avoidance)

**Goal:** One-click objective assignment from any task card.

**Scope / approach:**
- Add a hover-rail action on `TaskCard` (Target icon) mirroring the existing "Add to routine" dropdown (TaskCard.tsx:443–458): a dropdown of **leaf** objectives (from `api.objectives.list()`, flattened; filter `level === 'objective'`), search-as-you-type if the list is long (reuse `flattenObjectives`/`matchObjectives` from `lib/objectives.ts`).
- Select → `api.objectives.linkTask`; card's 8-point star appears (derived `objective_id` refresh). If already linked, show the current objective checked; selecting another links additionally (M:N is legal); offer "Remove from objective" → `unlinkTask`.
- Surface `non_leaf` 422 as a toast (list should prevent it; defensive only).

**Acceptance criteria:**
- Any task card can be linked to a leaf objective in ≤2 clicks; the star deep-link then navigates to `/tasks?tab=objectives&focus=<id>` (AF-1 URL).
- Unlink works from the same menu; tombstone semantics respected (row flips `linked=0`, task stays).
- Non-leaf objectives never appear in the picker.

**Tests:** client — picker filter/flatten helpers; server — none (existing link/unlink coverage). Preview screenshots.

**Impacted files:** `client/src/components/TaskCard.tsx`, `client/src/lib/objectives.ts` (reuse; extend matcher only if needed), `client/src/stores/*` (objective list resource if not already global).

---

### AF-7 · Remove the Inbox; add "New Today" (client half of ask 6) — needs AF-1 (Nav/AllTasks overlap) + AF-3 (nothing left to review)

**Goal:** No Inbox surface; every task created today (manual, quick-add, or auto-promoted suggestion) sits in a "New Today" section at the top of the Tasks tab and flows into the normal sections at the owner-local midnight rollover.

**Scope / approach:**
- **New Today:** derived list in `AllTasks.tsx` — top-level, non-routine tasks with `created_at` on the owner-local today (`localISODate()`, same pattern as the done-today/Archive split at :34–45). Rendered as the first `ArchiveSection`-style collapsible above Open. Tasks in New Today are excluded from Open/Scheduled for the day (no double-listing); status filters/search bypass sectioning as they do today. Subtasks stay nested under parents (excluded via existing `isTopLevel`).
- **Inbox removal:** delete `views/Inbox.tsx`; replace both `/inbox` routes with a redirect to `/tasks`; remove Inbox entries + badge wiring from `Nav.tsx` (:14, :23, :81 and the separator comment at :79) and `BottomNav.tsx` (:10, :23 — primary bar keeps Today/Tasks/Calendar).
- **Dead code sweep:** remove `api.possibles` (api.ts:271–), the `possibles` store resource, and `refetchPossibles`; keep a slim SSE handler `possible:promoted → refetchTasks()` (server still broadcasts it from the AF-3 pipeline) and drop `possible:dismissed` handling. Remove the `Possible` client type if now unreferenced.
- **Copy:** Settings.tsx:1147 "…into Inbox suggestions" → "…directly into your task list (New Today)".

**Acceptance criteria:**
- Creating a task by any client path shows it in New Today immediately; an ingestion/memory pull (AF-3) lands its tasks there with no user action.
- After the owner-local midnight, yesterday's New Today tasks appear in Open/Scheduled with no job having run (pure derivation — verify by clock or date injection).
- `/inbox` redirects; no nav surface, badge, or store references possibles; `grep -ri "possibles\|/inbox" client/src` returns nothing (except the SSE event name).
- No task is listed twice across New Today/Open/Scheduled.

**Tests:** client — extract the New Today/Open/Scheduled partition as a pure function and unit-test the day-boundary + exclusivity + tz behavior (time-bomb-safe: fixed dates, no `Date.now()` in assertions). Preview screenshots (desktop + mobile nav).

**Impacted files:** `client/src/views/AllTasks.tsx`, `client/src/views/Inbox.tsx` (deleted), `client/src/App.tsx`, `client/src/components/Nav.tsx`, `client/src/components/BottomNav.tsx`, `client/src/stores/index.ts`, `client/src/lib/api.ts`, `client/src/views/Settings.tsx`.

---

### AF-8 · Save-as-template upserts by name (ask 7; decision c)

**Goal:** Saving a time block as a template (explicit user action, unchanged trigger points) updates the existing template of the same name instead of creating a duplicate; the TASKS > TIMEBLOCK tab stays clean.

**Scope / approach:**
- Add `upsertBlockTemplateByName(owner, input)` to `services/block-templates.ts`: match on `(owner_id, name)` (trimmed, case-insensitive); update tag/default_minutes/tasks when found, else create. Return `{created|updated}`.
- REST: `POST /api/block-templates` accepts `upsert: true` (default false — **GraphQL `createBlockTemplate` and plain REST create semantics unchanged**; W-parity untouched).
- Switch the two save-as-template call sites (`PlannerEntityCard.tsx:171`, `FlightPlan.tsx:333`) to `upsert: true`; toast reflects created vs updated.
- **Explicitly out of scope:** any automatic template creation on block save (decision c). No hooks in `createBlock`/engine paths.

**Acceptance criteria:**
- Saving a template twice with the same name yields one row with the latest contents; different names still create separate templates.
- GraphQL mutation and plain REST POST behavior byte-identical to today (regression-asserted).
- TimeBlocksPanel reflects the update without duplicates (SSE/refetch).

**Tests:** server — upsert create/update paths, case/whitespace matching, owner isolation (same name, two owners → two rows), REST flag default-off regression, GraphQL untouched (`graphql-block-template.test.ts` green unchanged). Client — none beyond preview check.

**Impacted files:** `server/src/services/block-templates.ts`, `server/src/routes/block-templates.ts`, `server/test/` (block-templates tests), `client/src/components/PlannerEntityCard.tsx`, `client/src/components/FlightPlan.tsx`, `client/src/lib/api.ts` (create signature).

---

## Wave 3 — wizard authoring (1 lane; isolated because it shares ElementWizard with nothing after Wave 2)

### AF-9 · Time-block primary + secondary tag authoring (ask 8) — needs AF-4

**Goal:** The time-block editor makes the WORK / HOME / COMMUNITY primary choice first-class and lets the user add secondary tags, alongside (not instead of) the category.

**Scope / approach:**
- Keep the existing direction picker (ElementWizard timeblock branch :450–469) as the **primary tag** control; ensure the three base directions render prominently (they're seeded, undeletable; display-capitalized).
- Add secondary-tag authoring to the timeblock branch: reuse the existing intention/`TagSection` chip UI (currently gated to non-timeblock kinds at :442) writing to `secondary_tags` on save — **stop folding intentions into the level-1 `tag` string** (`lib/element.ts` timeblock path :213–223 currently does `[primary, ...intentions].join(',')`; change to `tag = primary`, `secondary_tags = intentions ∪ preserved secondaryTags`).
- Edit mode round-trips existing `secondary_tags` into the chips (today they're preserved blind).
- Category picker unchanged and now co-exists (AF-4).
- Check the two Planner drag-create paths (`Planner.tsx` createBlockAt/gridDrop pass a task's first tag as `tag`) still behave — they don't author secondary tags, fine.

**Acceptance criteria:**
- A time block can be saved with primary=WORK/HOME/COMMUNITY, N secondary tags, and a category, in one save, via the wizard; read API returns all three; Planner renders as before (color precedence per AF-4).
- Level-1 `entity_tags` contains exactly the primary; secondaries land at level 2 (no more comma-joined multi-primary).
- Editing an existing block shows and preserves its secondary tags.
- Existing blocks with legacy comma-joined `tag` strings still render (read path unchanged); no data migration required (note: legacy multi-primary rows keep their shape until next edit).

**Tests:** client — `lib/element.ts` save-shape unit tests (primary/secondary/category split, edit round-trip, legacy preservation); server — already covered by AF-4 + existing `applyBlockTagLevels` tests; add one wizard-shaped payload test (tag + secondary_tags + category together). Preview screenshots.

**Impacted files:** `client/src/components/ElementWizard.tsx`, `client/src/lib/element.ts`, `client/src/lib/element`-related tests, `server/test/blocks-service.test.ts` (one payload-shape case).

---

## Dead code removed by this phase (inventory)

| Item | Removed in |
|---|---|
| `client/src/views/Objectives.tsx` (standalone view) | AF-1 |
| Objectives nav entries (Nav, BottomNav) | AF-1 |
| `client/src/views/Inbox.tsx`, `/inbox` routes | AF-7 |
| Inbox nav entries + possibles badge wiring (Nav :14/:23/:79-81, BottomNav :10/:23) | AF-7 |
| `api.possibles` client namespace, `possibles` store resource, `refetchPossibles`, `possible:dismissed` handler, `Possible` type (if unreferenced) | AF-7 |
| Trust-mode **promotion** gate in `groom.promotePossibles` + stale tri-state comments | AF-3 |
| `promote_possibles` scheduled_jobs row (cron 02:00) — mig 0118 | AF-3 |
| `tag_and_category` guard, result variants, route/GraphQL branches | AF-4 |
| Intentions-folded-into-primary `tag` join in `lib/element.ts` timeblock path | AF-9 |

**Deliberately kept:** `possible_tasks` table + REST/GraphQL promote/dismiss surface (audit/dedup trail, sweeper, API parity, backup coverage); `nightly_grooming` (sweeper role); `trust_mode` column + auto-block semantics; `lib/objectives.ts` (DayGoals typeahead); `RoutinesPanel`/`TimeBlocksPanel` unchanged.

## Sequencing summary

```
Wave 1 (parallel):  AF-1 client tabs/move   AF-2 tree API   AF-3 auto-promote   AF-4 XOR relax
                         │                      │                │                  │
Wave 2 (parallel):  AF-5 (1+2)   AF-6 (1)   AF-7 (1+3)   AF-8 (independent, scheduled here to keep Wave 1 at 4 lanes)
                         │
Wave 3:             AF-9 (4; isolated ElementWizard churn)
```

Known collision points if waves are violated: `AllTasks.tsx` + `Nav/BottomNav` (AF-1 vs AF-7), `TaskCard.tsx` (AF-1 vs AF-6), `ElementWizard.tsx`/`lib/element.ts` (AF-9 vs anything), migration number 0118 (AF-3 vs other in-flight lanes — renumber at merge if taken).

## Post-phase follow-ups (2026-07-12 audit)

Items surfaced by the Phase AF consistency audit that are **deliberately not** part of
the AF-CU2 cleanup PR:

1. **Tag-shape unification — deferred to its own ticket (owner decision).** The three
   entity families still send three different tag wire-shapes: tasks send a flat
   `tags[]` (treating intentions as level-1), routines comma-join into `patterns.tag`,
   and time blocks split `tag` (primary) + `secondary_tags` (level 2, AF-9). Owner
   chose to defer the unification rather than bundle it into the audit cleanup.
2. **M:N objective-link surfacing on task cards** — being built as **AF-10** (a task
   card shows which leaf Objective(s) it is linked to).
3. **Already chipped as separate background tasks:** owner-scoping the migration-0027
   index, and the objective progress recompute pass.
