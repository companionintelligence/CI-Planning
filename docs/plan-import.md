# plan-import — additive task import with in-queue dedup

> **Status:** design, 2026-06-24. Implements the **`compare_and_merge`** grooming
> step named in [ingestion-plan.md §5–6](ingestion-plan.md) for the *generic*
> "tasks coming in" case (not just Gmail/Calendar). Companion to
> [GLOSSARY.md](GLOSSARY.md) (canonical nouns) and the README pipeline. Authoritative
> future-phase list remains [ROADMAP.md](ROADMAP.md).

---

## 0. Goal

Let flat tasks arrive in bulk from any source and **dedup them in the Inbox**,
without ever writing to the task list unreviewed. Re-importing the same source is
idempotent; near-duplicates collapse into **one Inbox item carrying a provenance
list**; items that match an existing open Task are **flagged** (not merged). The
human promotes/dismisses — the one in-the-loop step the README guarantees.

This is **route A** (flat action items). Curated *hierarchical* plans (efforts +
subtasks) are out of scope — see Non-goals.

## 1. Alignment & invariants (respect these)

- **No-auto-write (hard rule).** README: "Nothing reaches your task list without
  your say-so." Everything this plan stages lands as `possible_tasks.status='pending'`;
  promotion is the only path to a `tasks` row.
- **Noun budget = 8** ([GLOSSARY.md](GLOSSARY.md)). This plan adds **no noun**:
  the surface is the existing **Inbox** (`possible_tasks`); the work is a **Groom**
  step (`compare_and_merge`) and a staging entry — operations, not nouns.
- **Canonical vocabulary.** *Inbox* = `possible_tasks`. *Task* states are
  `open · TBD · scheduled · deferred · done · missed · past`; *terminal* = `done`/`past`
  (and the legacy `cancelled` soft-delete). *Tag* axes: `kind` pattern (Home/Work/
  Community) vs intention; `level` 1 (top) vs >1 (secondary). *Subtask* = Task with `parent_id`.
- **Match the existing API surface; don't invent endpoints** (ingestion-plan §1).
  Reuse `GET /api/possible-tasks` and `POST /api/possible-tasks/:id/promote|dismiss`.
- **Behavior-preservation is the contract** (consolidation-plan): every step is
  additive; existing tests stay green; *changing* a test expectation is a red flag.
  `dedupePossibles` (the existing embedding dedupe) is **not** modified — new code
  is added alongside it.
- **Deterministic-first; AI optional.** Fuzzy match is deterministic and runs with
  Ollama down; the embedding tier is "LLM only for the ambiguous middle" and
  degrades to a no-op when embeddings are unavailable (README: "dedupe off").
- **Migrations** are numbered TS functions, additive + idempotent, registered in
  `db/migrations/index.ts` (live head **0057**; next free **0058** — confirm at
  build time). **Audit**: every new mutating path calls `writeAudit(...)`.
- **Verification ritual** (per PR): Node `>=26 <27`; `pnpm --filter server test`,
  client typecheck, and `migrate.test.ts` green; run grooming tests with `TZ=UTC`.

## 2. Where it sits in the pipeline

```
incoming flat tasks ─▶ [PI-2 stage] ─▶ Inbox (possible_tasks, pending)
                                          │
                          [PI-4 compare_and_merge groom] ──uses──▶ [PI-3 matcher]
                                          │
              collapse dups (provenance)  │  flag vs existing open Tasks
                                          ▼
                         Inbox UI (PI-5) ─▶ human promote / dismiss ─▶ tasks
```

Data-flow boundaries (system-level):
- **In-point:** a batch of flat task descriptors `{title, due_at?, tags?[], source_kind, source_ref, account?}`.
- **Out-point:** reviewed, deduped Inbox items; `tasks` rows appear **only** on explicit promote (unchanged path).

## 3. Non-goals

- **No hierarchical-plan import.** Parent/subtask trees and tag *levels* don't fit
  the flat `possible_tasks` shape; that stays the [import-plan.ts](../server/src/scripts/import-plan.ts)
  admin seed (writes straight to `tasks`, outside this loop). Route B, separate.
- **No `/api/import` merge mode.** That endpoint is replace-owner-partition;
  `?mode=merge` is explicitly deferred ([R-backups-restore.md](R-backups-restore.md)). Not touched here.
- **No new noun, no new top-level view, no auto-promote.**
- **No change to `dedupePossibles` or the existing grooming behavior.**
- **No live Google MCP work** (that's the ingestion-plan's own track).

---

## Tickets

> Each ticket is its own PR — independently reviewable, additive, suites-green.
> They are **not** strictly linear: PI-3 starts immediately alongside PI-1, and
> PI-2 / PI-4 / PI-5 fan out once the schema lands. See
> [§5 Dependencies & fan-out](#5-dependencies--fan-out).

### PI-1 — Inbox provenance & merge link (schema)

**Goal.** Give an Inbox item a provenance list and let a duplicate point at its
survivor, so dedup is lossless and auditable ("one review item per real action,
linking every place it appeared" — ingestion-plan §5).

**In-points.**
- Migration runner on boot (`runMigrations` in `db/index.ts`) applies `0058`.
- Drizzle `schema.ts` gains the new column(s) + table for typed reads/writes.

**Out-points.**
- `possible_tasks.merged_into_id` (TEXT, self-ref, null unless `status='duplicate'`).
- `possible_tasks.account` (TEXT, origin account; ingestion-plan calls for this).
- `possible_tasks.duplicate_of_task_id` (TEXT, ref to a `tasks.id`; populated by **PI-4** when an Inbox item matches an existing open Task; null otherwise). **Lives here, not in PI-4** — so PI-4 carries no migration and can fan out after PI-1.
- New table `possible_task_sources(possible_task_id, source_kind, source_ref, account, seen_at, PK(possible_task_id, source_kind, source_ref))` — the provenance list.
- One backfilled provenance row per existing Inbox item (from its own `source_kind`/`source_ref`/`account`).

**Files impacted.**
- `server/src/db/migrations/0058_inbox_provenance.ts` (new)
- `server/src/db/migrations/index.ts` (register)
- `server/src/db/schema.ts` (columns + `possibleTaskSources` table)
- `server/test/migrate.test.ts` (or new `inbox-provenance.test.ts`)

**Acceptance criteria.**
- Migration is additive + idempotent (re-running applies nothing; guarded by `PRAGMA table_info`).
- Every pre-existing `possible_tasks` row has exactly one backfilled `possible_task_sources` row; no row count drift elsewhere.
- Existing Inbox reads return identical data (new fields are additive, default null/empty).
- FK/PK integrity holds (`foreign_key_check` clean post-migrate).

**Definition of done.**
- `0058` registered; `schema.ts` matches DB; `migrate.test.ts` green on a fixture 0.x DB; full server suite + client typecheck green; no behavior change observable in the app.

---

### PI-2 — Staging entry: additive ingest of incoming tasks → Inbox

**Goal.** A reusable entry that stages a batch of flat tasks into the Inbox as
`pending`, exact-deduped on `(source_kind, source_ref)`, recording provenance —
**never** writing to `tasks` (no-auto-write).

**In-points.**
- `stageIncomingTasks(items: IncomingTask[]): { created: number; updated: number }`
  where `IncomingTask = { title; due_at?; tags?: string[]; source_kind; source_ref; account? }`.
- A `compare_and_merge`-adjacent **Job** kind and/or the existing CLI pattern
  ([import-plan.ts](../server/src/scripts/import-plan.ts) sibling) reads a batch file and calls it.
  **No new HTTP endpoint** (a Settings upload is an optional later follow-up).

**Out-points.**
- `possible_tasks` rows (`status='pending'`) + `possible_task_tags` (one direction/pattern tag via existing `inferDirection`, plus content tags) + a `possible_task_sources` provenance row.
- Return counts `{created, updated}`; `writeAudit({action:'import', entity:'inbox'})`.

**Files impacted.**
- `server/src/agents/ingest.ts` (extend `upsertPossible` to write/refresh provenance + `account`; add `stageIncomingTasks`)
- `server/src/jobs/index.ts` (+ a job kind, if cron/Jobs-runnable) and `0058`/seed (only if registering a job row)
- `server/src/lib/audit.ts` (reuse)
- `server/test/ingest-stage.test.ts` (new)

**Acceptance criteria.**
- Re-staging the same `(source_kind, source_ref)` **updates** the existing item and **does not** create a duplicate (idempotent) — verified by row count.
- No `tasks` row is ever created by this path (assert `tasks` count unchanged).
- Provenance row is upserted per stage; `account` persisted; direction tag always attached even with Ollama down.
- Empty/invalid items are skipped with a count, not a throw.

**Definition of done.**
- Unit tests cover idempotent upsert, provenance write, zero task-writes, Ollama-down path; suites green; if a Job kind is added it appears in the Jobs view and is manually runnable.

---

### PI-3 — Dedup matcher service (pure, deterministic)

**Goal.** One shared, testable matcher: normalize + score two flat task records and
pick the best candidate. Deterministic (no network); the embedding tier is injected,
not called here.

**In-points.**
- `services/dedup.ts`:
  - `normalizeTitle(s: string): string` (lowercase, trim, collapse ws, strip punctuation).
  - `fuzzyScore(a: Candidate, b: Candidate): number` over **title + due-date proximity + tag overlap** (not title alone).
  - `findBestMatch(item: Candidate, candidates: Candidate[], opts): { match?: Candidate; score: number; method: 'exact'|'fuzzy' }`.
  - `Candidate = { id; title; dueAt?; tags: string[] }`.
- Thresholds passed in (defaults defined here, tunable): exact `=1.0`; fuzzy auto-collapse `>=0.90`; ambiguous band `0.75–0.90` (handed to the embedding tier in PI-4).

**Out-points.**
- Pure return values only (no DB, no I/O). Consumed by PI-4 and (optionally, later) by other groom steps.

**Files impacted.**
- `server/src/services/dedup.ts` (new)
- `server/test/dedup.test.ts` (new)

**Acceptance criteria.**
- Deterministic: same inputs → same output, no Ollama/network.
- Exact normalized-title equality scores `1.0`; punctuation/whitespace/case differences still match exact.
- `fuzzyScore` rewards due-date proximity and tag overlap, not just title (documented weighting); distinct tasks with similar titles but different due/tags fall below auto-collapse.
- `findBestMatch` returns the single highest-scoring candidate + method.

**Definition of done.**
- Unit tests cover exact, fuzzy bands, due/tag weighting, the "similar title, different due" false-positive guard, and empty-candidate cases; ≥ the project's normal coverage bar; suites green.

---

### PI-4 — `compare_and_merge` grooming step

**Goal.** The core. Over **pending** Inbox items: collapse near-duplicates into one
survivor (union provenance) and **flag** items that match an existing open Task as
likely-duplicate/likely-done. Fuzzy-first (PI-3); embeddings only for the ambiguous
band; skip cleanly when Ollama is down. **Never** writes to `tasks`; **never** merges
into a terminal-state Task.

**In-points.**
- `compareAndMerge(opts?): CompareMergeResult` in `agents/groom.ts` (uses `services/dedup.ts` + `embed()` from `mcp/ollama.ts` for the mid band only).
- Invoked by the existing **grooming** Job (and manually runnable from the Jobs view). Candidate set = pending `possible_tasks` (+ tags/due) and the owner's **non-terminal** Tasks (`open/TBD/scheduled/deferred`).

**Out-points.**
- Collapsed dup: loser → `status='duplicate'`, `merged_into_id=<survivor>`; survivor gains the loser's `possible_task_sources` rows (provenance union).
- Queue-vs-existing match: survivor flagged with a `duplicate_of_task_id` reference (additive column or a marker row) — surfaced, **not** promoted/merged.
- `CompareMergeResult { compared, merged, flaggedExisting, embeddingTierUsed: boolean }`; `writeAudit` per merge; SSE `possible:updated` so the Inbox refreshes.

**Files impacted.**
- `server/src/agents/groom.ts` (add `compareAndMerge`; **do not alter** `dedupePossibles`/`promotePossibles`)
- `server/src/services/dedup.ts` (consume)
- `server/src/jobs/index.ts` (wire into the grooming job; ensure manual run) — **shared with PI-2** (see fan-out contention)
- `server/test/compare-and-merge.test.ts` (new)
- **No migration** — `duplicate_of_task_id` ships in PI-1's `0058`.

**Acceptance criteria.**
- Two near-identical pending items collapse to one survivor; loser is `duplicate` + linked; survivor provenance contains both sources.
- A pending item matching an existing **open** Task is flagged, **not** merged, **not** promoted.
- **No** `tasks` write occurs; **no** merge into a `done`/`past`/`cancelled` Task (terminal tasks excluded from candidates).
- Deterministic with Ollama **down** (fuzzy tier only; `embeddingTierUsed=false`) and still correct; with Ollama up, the ambiguous band may additionally collapse.
- **Idempotent**: a second run makes no further changes (no oscillation; already-`duplicate` rows are skipped).
- **Behavior-preserving**: existing `dedupePossibles`/grooming tests unchanged and green.

**Definition of done.**
- New tests cover: queue-internal merge, queue-vs-existing flag, terminal-state exclusion, Ollama-off determinism, idempotent re-run, provenance union, audit rows. Grooming Job runs it; visible/runnable in Jobs view; `TZ=UTC` suite green.

---

### PI-5 — Inbox surfaces provenance + likely-duplicate

**Goal.** Show the merged provenance list and the "likely duplicate of \<Task\>" /
"likely already done" affordance on Inbox items, so promote/dismiss is informed —
the no-auto-write confirm step.

**In-points.**
- `GET /api/possible-tasks` (existing) extended to include `sources[]` (provenance) and `duplicate_of_task` (id + title) — **additive fields, same endpoint**.
- Client `Possible` type + Inbox view consume them.

**Out-points.**
- Inbox item renders its source list and, when flagged, a one-click **dismiss-as-duplicate**; `promote`/`dismiss` paths unchanged.

**Files impacted.**
- `server/src/routes/possibles.ts` (additive read fields)
- `client/src/views/Inbox.tsx` (render provenance + flag)
- `client/src/lib/api.ts` (`Possible` type)
- `server/test/possibles-provenance.test.ts` (new) + a client render assertion

**Acceptance criteria.**
- A merged item lists all contributing sources; a flagged item shows the existing-Task link.
- Existing promote (`P`) / dismiss (`D`) behavior and tests are unchanged.
- New fields are optional/additive; old clients keep working.

**Definition of done.**
- Route returns additive fields; Inbox renders them; client typecheck + server suite green; browser-verify the Inbox in the preview.

---

## 4. Risks / notes

- **Title-only matching is weak** — PI-3 deliberately matches on title **+ due + tags** to cut false-collapses; thresholds are first guesses and must be tuned against real Inbox data (track false-merge rate via `audit_log`).
- **Embedding non-determinism** — outcomes differ with Ollama on vs off; `CompareMergeResult.embeddingTierUsed` records which ran, and the fuzzy tier is the deterministic floor. Embeddings on short titles are noisy → they only adjudicate the ambiguous band, never override exact/fuzzy.
- **App-enforced integrity** — `possible_task_sources` and any new links must be cleaned on Inbox-item delete/dismiss (mirror the tag-repo discipline; the orphan-free test is the gate).
- **Idempotency** — keyed on `(source_kind, source_ref)` at stage and on `status='duplicate'` skip at groom; re-import and re-groom are both no-ops on settled data.
- **Scope creep guard** — if only PI-2+PI-4 are needed to ship value, PI-5 can follow; PI-3 is split out purely so the matcher is unit-tested in isolation.

## 5. Dependencies & fan-out

The tickets form a shallow DAG, not a line. Two independent roots (PI-1, PI-3)
mean work can start on two tracks immediately, and three tickets fan out after the
schema.

**Dependency table.**

| Ticket | Depends on | Parallel-safe with | Notes |
|---|---|---|---|
| **PI-1** schema | — | **PI-3** | Foundational; pure-data, no logic deps. |
| **PI-3** matcher | — | **PI-1** | Pure functions, own `Candidate` type — zero schema/runtime deps. |
| **PI-2** staging | PI-1 | **PI-4, PI-5** | Needs provenance columns/table. |
| **PI-4** groom | PI-1, PI-3 | **PI-2, PI-5** | Operates on whatever is in the Inbox — does **not** need PI-2. |
| **PI-5** Inbox UI | PI-1 | **PI-2, PI-4** | Renders provenance immediately; the `duplicate_of_task` flag stays empty until PI-4 runs (graceful). |

**DAG.**

```
        ┌──────────── PI-1 (schema 0058) ───────────┐
        │                  │                          │
   PI-3 (matcher)          ▼            ▼             ▼
        │             PI-2 (stage)  PI-4 (groom)  PI-5 (Inbox UI)
        └────────────────────────────▲
                  (PI-4 also needs PI-3)
```

**Fan-out waves.**

- **Wave A (2 parallel tracks):** **PI-1** and **PI-3** — independent roots, start
  together.
- **Wave B (3 parallel tracks, after PI-1; PI-4 also consumes PI-3 from Wave A):**
  **PI-2**, **PI-4**, **PI-5** — disjoint primary files (`ingest.ts` / `groom.ts` +
  `dedup.ts` / `routes/possibles.ts` + client), so they can land in any order.

**Critical path:** PI-1 → PI-4 (PI-3 finishes during Wave A, so it never gates
PI-4). PI-2 and PI-5 are off the critical path. Two contributors (or two agents)
collapse the five-PR line into roughly **two waves**.

**Contention to manage (not blockers).**
- `server/src/jobs/index.ts` is touched by **PI-2** (optional job kind) and **PI-4**
  (grooming wiring). Keep each edit to its own job block; if both land in the same
  window, expect a trivial merge. Mitigation: have PI-4 wire `compareAndMerge` inside
  `agents/groom.ts`'s grooming entry and minimize `jobs/index.ts` churn.
- All schema is in **PI-1's `0058`** (incl. PI-4's `duplicate_of_task_id`), so no two
  tickets add migrations — avoids migration-number races in `db/migrations/index.ts`.
- PI-5 may ship before PI-4; it just shows no duplicate flags until PI-4 populates
  them. That's intended graceful degradation, not a dependency.

## 6. Suggested PR sequence (waves)

1. **Wave A — parallel:** **PI-1** (schema `0058`, no behavior change) ‖ **PI-3**
   (pure matcher, fully unit-tested).
2. **Wave B — parallel, after PI-1:** **PI-4** (`compare_and_merge`, the core) ‖
   **PI-2** (staging entry) ‖ **PI-5** (Inbox provenance + flag UI).

Single-contributor fallback: PI-1 → PI-3 → PI-2 → PI-4 → PI-5 (the original line)
still works; the waves are an optimization, not a requirement.
