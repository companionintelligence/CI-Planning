# CON-2b — Vocabulary relabels (handoff brief)

> **Self-contained brief for a fresh session.** Execute CON-2b: rename user-facing
> labels to the canonical vocabulary. **UI text + one internal identifier only —
> no data, schema, or behavior changes.** Canon: [GLOSSARY.md](GLOSSARY.md). Plan:
> [consolidation-plan.md](consolidation-plan.md).

## Where things stand
- Branch: **`claude/con-2-vocab`** (base of this work). Build CON-2b on top and commit here.
- Already done on this branch: **CON-2a** = `block_type` *values* renamed `plan→scheduled` / `concept→someday` (migration `0031`, all readers, API param `?state=`). **Do not redo data values.**
- This sits on the CON-1 branch (entity ids are now TEXT UUIDv7 — treat all ids as opaque strings; never `Number(id)`).
- Server tests need **Node 26.3.0**: `export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"; unset PORT`.

## Scope — relabel to the GLOSSARY canon
Map (from GLOSSARY): **Plan → Time Block (scheduled)** · **Concept → Time Block (someday)** · **Plan-Block/Template → Time Block (saved)** · **Pattern → Routine**.

### Exact touch points
**Patterns → Routines** (label only; keep the `/patterns` route path — internal name may differ per GLOSSARY):
- `client/src/components/Nav.tsx:15` `label: 'Patterns'` → `'Routines'` (keep `href: '/patterns'`)
- `client/src/components/BottomNav.tsx:14` same
- `client/src/views/Patterns.tsx:354` `<h1>Patterns</h1>` → `Routines` (+ any other "Patterns" copy in that view)
- `client/src/components/PlannerDrawer.tsx:409` "Create patterns in …Patterns" → "Create routines in …Routines"

**"Plan Block(s)" → "Time Block(s)"** (these are saved templates):
- `client/src/views/Patterns.tsx`: `:70` delete confirm, `:368` subtitle "Drop a Habit or Plan Block", `:404` `<h2>Plan Blocks</h2>`, `:408` empty hint
- `client/src/components/PlannerDrawer.tsx`: `:207` "Plan Blocks" heading, `:398` help text, `:196` `PlanBlocksCat` (fn name — optional internal rename)

**Block Wizard labels** (`client/src/components/PlannerDrawer.tsx`) — relabel the *displayed* words; keep the two-step structure:
- `:420` step chip "Concept" → "Someday"; `:424` "Plan" → "Scheduled"
- `:460` button "Track Concept" → e.g. "Save for someday"; `:461` "Make Plan" → "Schedule"; `:497` "Add Plan" → "Add Time Block"
- Default-name fallbacks `:278` `'Concept'`, `:305` `'Plan'` → "Time Block" (cosmetic)

**Planner / BlockEditModal** "Plan" → "Time Block":
- `client/src/components/Planner.tsx:337,355,544` "Remove from Plan" / "Detached from Plan" → "…from Time Block"
- `client/src/components/BlockEditModal.tsx:64` "Edit Plan" → "Edit Time Block"; `:50` default title `'Plan'` → `'Time Block'`

**DragKind internal identifier** `'plan-block'` → `'time-block'`:
- `client/src/lib/draggable.ts:21` (the type), `client/src/views/Patterns.tsx:84,412` (usages). Keep `'habit'` and `'flight-task'` as-is.

## Out of scope (do NOT touch)
- **`ConceptLane.tsx`** and its "Concepts" label — it's *removed* in CON-2d, not relabeled here. Leave it.
- **`tasks.subtype` / `is_habit` / `is_fast_task`** — that's CON-2c. Don't touch habit/subtype logic.
- Any **`block_type` values**, migrations, schema, or server engine — CON-2a already did the data rename.
- The **wizard step *keys*** (`createSignal<'concept' | 'plan'>`, `setStep('concept')`, `step() === 'plan'`) are internal state identifiers — relabeling the displayed text is enough. (Optional: rename the keys too for consistency, but only if every `step()` comparison updates together.)

## The gate (must hold)
- **Behavior baseline `.snap` stays byte-identical.** Relabels touch UI text + a client-only DragKind — never serialized API data. Verify: `git diff origin/main -- server/test/__snapshots__/baseline.characterization.test.ts.snap` shows **no change** beyond CON-2a's block_type lines. **Do not run vitest with `-u`.** If a snapshot moves, you touched something non-cosmetic — fix the source.
- `pnpm -C client exec tsc --noEmit` clean; `pnpm -C client exec vitest run` green (**~106**).
- `pnpm -C server exec tsc --noEmit` clean; `pnpm -C server exec vitest run` green (**253**) — server should be untouched by relabels.

## Deliverable
- Commit on `claude/con-2-vocab` (message e.g. `feat(con-2b): relabel Plan/Concept/Plan-Block→Time Block, Patterns→Routines`). End with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Do not open a PR** — CON-2 is one PR; CON-2c (subtype) and CON-2d (ConceptLane) still follow. Push the branch and report.
- Every new label must exist in [GLOSSARY.md](GLOSSARY.md) — if you coin a phrase, add it there.
