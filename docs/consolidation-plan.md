# Companion Planning — Consolidation Pass

> **Status:** planning doc — no implementation yet. Branch off `main` (after #70).
> **This pass gates `claude/cockpit-v2` (#71): consolidation lands first; #71
> rebases onto it.** Vocabulary canon: [GLOSSARY.md](GLOSSARY.md). UX target:
> [cockpit-v2-plan.md](cockpit-v2-plan.md).

## Why consolidate first

The product goal has been constant — a **local-first, manual-or-Auto planner**
built from the *fewest* unified primitives with *canonical sources*. Recent PRs
(#65–#70) shipped real power but accreted surface: ~25 user-facing nouns, two
recurrence engines, a comma-string tag model beside a normalized one, and the
Block Wizard as the only way to author a block. #71 is mostly excellent UI, but
by its own Risk #5 it **net-adds** nouns/states on top of that.

So we settle **vocabulary, identity, recurrence, and the tag model once**, on a
behavior-preserving pass, so #71’s UI lands on a stable base and its higher-risk
parts (tag levels/dilution, recall=clone) become cheap. **Every step is
behavior-preserving except CON-5 (one additive capability: drag-to-place).**
Suites stay green (**server 250 / client 97**, Node 26.3.0) at every step.

## Locked decisions (with the user)

| # | Decision |
|---|----------|
| 1 | Consolidation **gates** #71; #71 rebases clean. |
| 2 | Pulled into consolidation: tag-store **normalization**, ConceptLane removal + Concept→*someday*, Habit dual-shape fix, holding-pens→states (model). |
| 3 | Keep #71’s power features (tag levels, dilution, recall/shelf) — explicit opt-in, measured against the noun budget. |
| 4 | Noun budget = **8** (7 in use + 1 reserved). See GLOSSARY. |
| 5 | Plan + Concept + Plan-Block → **Time Block** {scheduled · someday · saved}. **Behavior-preserving.** |
| 6 | Pattern → **Routine**; Ritual stays behind `enable_rituals`. |
| 7 | **Flight-plan** name kept (revisit after stores land). |
| 8 | Rename `block_type` values `plan`→`scheduled`, `concept`→`someday` (migration). |
| 9 | **Habit = recurring Task subtype.** Add `tasks.subtype` enum (`standard`\|`habit`\|`quick`, **mutually exclusive**); habits shown in the Routines menu. |
| 10 | **One recurrence engine.** Add `time_blocks.recurrence_rule` (bare-container recurrence); retire `0025`’s parallel pattern RRULE; a Routine recurs by placing its member tasks. **Recurring Time Blocks supported.** |
| 11 | Keep lazy placement on `GET /api/blocks`; make it concurrency-safe + documented (not a smell). |
| 12 | Tag store = **polymorphic `entity_tags(entity_kind, entity_id, tag_id, level)`**; cost (app-enforced integrity via a tag-repo layer) accepted. |
| 13 | Keep `time_blocks.tag` as a denormalized **top-level mirror**. |
| 14 | Fold concept-tags (prefs JSON) into the tag store. |
| 15 | Consolidation ships the **normalized store (no dilution)**; #71 Phase 5 adds **levels + dilution** only. |
| 16 | **Entity IDs → UUIDv7.** |
| 17 | **Drag-to-place** primitive lands in consolidation. |
| 18 | Adopt **GLOSSARY.md + noun budget** as the gate. |
| 19 | Baseline discipline: branch off `main` post-#70; suites green each step. |

## The ordered pass

Forward-only, expand → backfill → contract. Migration numbers continue from
`0029` (highest registered today). Each CON-step is its own PR.

### CON-1 — UUIDv7 identity *(own PR, first)*
- **Goal.** All entity PKs become time-ordered UUIDv7 (`TEXT`); one id regime,
  client-mintable. Unblocks recall=clone, multi-device (L), merge-safe
  export/import, and unifies with the auth UUIDv7 already specced in Phase I.
- **Scope.** `lib/ids.ts` (`uuidv7()`); migration **`0030_uuidv7_identity`** —
  rebuild the **18 tables** to `TEXT` PK and remap the **25 FKs** (SQLite can’t
  alter a PK in place: create new tables → backfill deterministic uuids → remap
  FKs → swap, in one transaction). Client `id: number → string` in `lib/api.ts`.
- **Behavior.** Identical; ids change format only.
- **Acceptance / tests.** FK-integrity check (no orphans post-migrate); export →
  wipe → import round-trips byte-identical; every existing suite green with string
  ids; `migrate.test.ts` on a fixture 0.x DB.
- **Risk.** The single riskiest migration in the plan → dedicated PR, heavy tests.

### CON-2 — Vocabulary + schema canon
- **Goal.** Make the data + UI speak the GLOSSARY. Behavior-preserving relabels +
  two small schema canonicalizations.
- **Scope.**
  - `block_type` values `plan→scheduled` / `concept→someday` — migration
    **`0031`** + the **8 readers** (`scheduler.ts:279`, `autoplan.ts:97`,
    `blocks.ts:180`, `Planner.tsx:492`, `PlannerDrawer.tsx:285/311`,
    `api.ts:124/249`); rename API param `?block_type=` → `?state=`.
  - `tasks.subtype` enum — migration **`0032`**, backfill `is_habit→habit`,
    `is_fast_task→quick` (15 files), drop the booleans (contract). Fixes the Habit
    dual-shape: Habit is a Task subtype, listed in Routines, not a “pattern type”.
  - Relabels: Plan/Concept/Plan-Block → **Time Block**; Patterns view → **Routines**;
    `DragKind 'plan-block' → 'time-block'`.
  - **Remove `ConceptLane`**; render *someday* Time Blocks on their goal day in the
    Planner header lane (generalize `todayConcepts`). *(#71 Phase 4 then adds only
    the click→popover.)*
  - Commit **GLOSSARY.md**; adopt the noun budget as a review gate.
- **Behavior.** Identical (states/subtypes are renames of existing data).
- **Acceptance / tests.** `state` filter returns the same rows as the old
  `block_type`; subtype backfill round-trips; no UI label outside the glossary.

### CON-3 — Tag store normalization *(structure only — NO dilution)*
- **Goal.** One canonical tag store for Tasks, Time Blocks, Routines.
- **Scope.** Migration **`0033_entity_tags`** — `entity_tags(entity_kind,
  entity_id, tag_id, level DEFAULT 1)`; backfill from `task_tags` + comma-split
  `time_blocks.tag` + concept-tags(prefs JSON). Keep `time_blocks.tag` as the
  top-level mirror. A **tag-repo layer** owns cascade-on-delete (no FK on
  `entity_id` — app-enforced; non-optional or it leaks orphans).
- **Behavior.** Identical: `level` defaults, **no weighting yet**.
- **Acceptance / tests.** Reads return the same tags pre/post; orphan-free after
  entity delete; mirror stays in sync on write.
- **Hands to #71 Phase 5:** levels-use + dilution (the only behavior change), where
  it’s tested against `auto-placement.test.ts`.

### CON-4 — Recurrence unification
- **Goal.** One recurrence engine, attachable to Task, Time Block, and
  Routine-placement.
- **Scope.** Migration **`0034`** — add `time_blocks.recurrence_rule` (+
  `recurrence_dtstart`); reuse the task engine’s `ux_*_occurrence` keying; **retire
  `0025`’s pattern RRULE** (a recurring Routine places its member tasks through the
  shared engine). Keep lazy `ensurePatternsForRange` on GET; wrap it
  concurrency-safe and document it as canonical.
- **Behavior.** Existing recurring habits/patterns behave identically; bare
  recurring Time Blocks (“Deep Work 9–11 every weekday”) now supported.
- **Acceptance / tests.** `generate.test.ts` + `recurrence-ops.test.ts` +
  `pattern-recurrence.test.ts` green; a recurring Time Block materializes
  idempotently across a DST week; concurrent GETs never double-place.

### CON-5 — Drag-to-place primitive *(the one additive capability)*
- **Goal.** Make the Planner write-capable so authoring isn’t wizard-only — and so
  #71’s two-column/drawer design is correct.
- **Scope.** Click an empty slot → create a Time Block; drag a flight-plan/backlog
  Task onto a time → schedule it. Built on `lib/draggable.ts`, `lib/grid.ts`,
  `lib/group-move.ts`. Demote the Block Wizard to the advanced path; fix the
  misleading “drag one onto the grid” empty-state copy.
- **Acceptance / tests.** Drop emits one tz-correct PATCH/POST; created block snaps
  to grid; no tz drift; click-vs-drag threshold respected.

## What this does to #71 (rebase map)

- **Moved into consolidation:** tag-store normalization (out of Phase 5),
  Concept→Someday naming (Phase 4), the ID decision (unblocks Phase 6 recall).
- **#71 phases, slimmer:** ① day-nav (and now retire `/calendar`, since the Planner
  is date-navigable) · ② pills / round-Auto ⚡ / fill-work-hours / 4·8·16 · ③
  two-column + drawer overlay · ④ *Someday* Time-Block **popover** only · ⑤ tag
  **levels + dilution** only · ⑥ Open/TBD/Deferred/Past views + **recall=clone**
  (trivial on UUIDs).
- **Migration numbers:** consolidation takes `0030–0034`; #71’s tag-levels /
  `recall_keeps_pattern` start at `0035+`.

## Cross-cutting

- **Verification ritual.** `export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH";
  unset PORT`; server + client suites + `pnpm typecheck` + `migrate.test.ts` green
  each PR. Browser-verify CON-5 in the preview.
- **Migrations.** `0030–0034`; register in `db/migrations/index.ts` (array order is
  load order); each additive + idempotent.
- **`entity_tags` integrity** is app-enforced — the tag-repo layer is part of CON-3,
  not a follow-up.

## Risks

1. **CON-1 (UUIDv7) is the riskiest change** — a full PK/FK rebuild on SQLite.
   Dedicated PR, FK-integrity + round-trip tests, no other work in it.
2. **CON-3 trades DB-enforced referential integrity for app-enforced** — the
   tag-repo layer must own every entity-delete path or tag rows orphan.
3. **CON-4 deletes code** (the `0025` path) rather than relabeling — the recurrence
   suites are the gate; verify habits/streaks unchanged.
4. **Behavior-preservation is the contract** — if any of CON-1..4 changes a test
   expectation, that’s a red flag, not an update. Only CON-5 adds behavior.
5. **Scope** — 5 PRs. They’re ordered so each is independently reviewable and #71
   never rebases onto a half-migrated base.
