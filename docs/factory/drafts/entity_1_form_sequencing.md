> **Type:** feature · **Phase:** ENTITY · **Branch:** `feat/wizard-progressive-gating` · **Commit style:** `feat(wizard): gate panes on title then direction` · **Design:** user feedback 2026-07-15 · **Dependencies:** none

> ### 📓 HISTORICAL — this is the pre-implementation draft, and it SHIPPED
> It drove **PR #362** (merged 2026-07-16, no migration), closing issue **#357**. It is kept
> as the **decision record**: the *why* behind the design, which the diff cannot explain.
>
> **It describes the codebase as it was BEFORE #362 — read it in the past tense.** Every
> `file:line` below is a snapshot from 2026-07-15 authoring and has drifted. For current
> behavior read the code; the durable pointers here are the *file + symbol* names. Unlike
> its siblings, this draft's pins were never corrected in-flight.
>
> Amended during implementation: gated panes were made **inert**, not merely styled as
> locked — a gap this draft did not specify.

## Goal

In the **Add** flow of the Element wizard, unlock the form progressively so the owner names the thing before configuring it:

1. **Title empty** → both panes are inert.
2. **Title non-empty** → the **left pane** (identity: Direction, Category, tags) unlocks.
3. **Direction set** → the **right pane** (scheduling: Day, time, duration, repeat) unlocks.

## Non-goals

- **Edit mode is out of scope.** Gating applies to `mode: 'add'` only (see *Pinned conventions* — gating edit would lock the right pane for existing tasks that legitimately have no direction).
- The **Routine** tab is out of scope — it has no panes (simple shell at `ElementWizard.tsx:881-885`).
- No change to save/validation rules. `saveElement` and its required-field checks are untouched.
- No new form fields, no reordering, no restyling beyond the gate affordance.
- Objectives are not part of this wizard — out of scope.

## Pinned conventions

All line numbers are `client/src/components/ElementWizard.tsx` on `claude/local-backend-frontend-setup-77dae0`.

- **Signals:** `const [title, setTitle] = createSignal('')`; `const [primary, setPrimary] = createSignal('')` (**`:96`**). `primary()` **is** the Direction value — it holds the pattern-tag *name* (`''` = unset; set at `:382-383`).
- **Edit guard:** `isEdit()` already exists (used at `:868`).
- **Tab values:** `tab()` is `'task' | 'timeblock' | 'routine'` (see `:873`, `:881`).
- **Title input:** `:871-874` — lives in the modal **header**, above the body. Not gated (it is the gate).
- **Body wrapper:** `:878` — `<div class="flex flex-col md:flex-row max-h-[68vh] overflow-y-auto">`, commented *"Body — identity left, time right (stacked on mobile)"* (`:877`).
- **LEFT PANE:** `:888-889` — `{/* LEFT PANE — identity */}` `<div class="w-full md:w-[290px] flex-shrink-0 p-4 md:p-5 flex flex-col gap-3.5 md:border-r border-b md:border-b-0 border-border">`. Holds `<PrimaryPicker label="Direction" …/>` (`:890`) and the block-only Category dropdown (`:893`).
- **RIGHT PANE:** `:1177-1179` — `{/* RIGHT PANE — scheduling */}` `<div class="flex-1 min-w-0 p-4 md:p-5 flex flex-col gap-3 transition-opacity" classList={{ 'opacity-50': dimRightPane() }}>`.
- **⭐ The dimming convention to extend, not reinvent:** `dimRightPane()` (**`:575`**) — `() => taskIsSomeday() || taskDeferred() || (tab() === 'timeblock' && someday())` — already dims the right pane by composing `classList={{ 'opacity-50': … }}` with `transition-opacity` on the pane div. **Match this exactly**: derived accessor + `classList` + `transition-opacity`.
- **Composition requirement:** the new gate must **OR** with `dimRightPane()`, not replace it. A someday task with a title and direction must still dim.

## Before implementation

Read, in order:

1. `client/src/components/ElementWizard.tsx:571-576` — the existing `dimRightPane` / `taskIsSomeday` / `taskDeferred` accessors.
2. `client/src/components/ElementWizard.tsx:866-901` — header title input, body wrapper, left pane opening.
3. `client/src/components/ElementWizard.tsx:1174-1183` — right pane opening + its existing `classList`.
4. `client/src/components/ElementWizard.tsx:285-300, 320-330, 370-385` — the seed/reset paths, to confirm `title` and `primary` are populated on the closed→open edge in edit mode (so gates read as open if you later extend to edit).

## Files impacted

**Changed:**
- `client/src/components/ElementWizard.tsx` — add two derived accessors; apply them to the left pane (`:889`) and right pane (`:1178-1179`) `classList`.

**New:** none.

## Schema required

**None** — client-only, no API and no DB change.

## Definition of Done

- [ ] Two accessors added next to `dimRightPane` (`~:575`), mirroring its style:
      `const gateLeft = () => !isEdit() && tab() !== 'routine' && title().trim() === '';`
      `const gateRight = () => !isEdit() && tab() !== 'routine' && (title().trim() === '' || !primary());`
- [ ] Left pane (`:889`) gets `class="… transition-opacity"` + `classList={{ 'opacity-50': gateLeft(), 'pointer-events-none': gateLeft() }}`.
- [ ] Right pane (`:1178`) `classList` becomes `{{ 'opacity-50': dimRightPane() || gateRight(), 'pointer-events-none': gateRight() }}` — **`dimRightPane()` behavior preserved**.
- [ ] Gated panes carry `aria-disabled="true"` so the state is not colour-only.
- [ ] Add mode, Task tab: empty title → both panes inert; type a title → left unlocks; pick a Direction → right unlocks.
- [ ] Add mode, Time Block tab: identical behavior.
- [ ] Clearing the title back to empty re-gates **both** panes.
- [ ] Clearing the Direction re-gates the right pane only.
- [ ] **Edit mode: no gating at all** — an existing task with no direction has a fully usable right pane.
- [ ] Routine tab: unaffected (no panes).
- [ ] A someday/deferred task still dims via `dimRightPane()` once ungated.

## Tests

Verification commands (must pass):

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client build
pnpm --filter client test
```

Cases:

- [ ] Add → Task: title `''` → left pane has `opacity-50` + `pointer-events-none`.
- [ ] Add → Task: title `'x'` → left pane ungated; right pane still gated.
- [ ] Add → Task: title `'x'` + Direction picked → right pane ungated.
- [ ] Add → Task: title cleared → both re-gated.
- [ ] Add → Time Block: same four transitions.
- [ ] Add → Routine: neither gate applies; the routine shell renders normally.
- [ ] Edit → task with `primary() === ''`: right pane is **not** gated (regression guard).
- [ ] Add → Task, someday toggled, title+direction set: right pane dims via `dimRightPane()` but stays interactive (`pointer-events-none` absent).
- [ ] Saving is unaffected once gates are open.

## Acceptance Criteria

- [ ] Progressive unlock works on the Task and Time Block tabs in add mode.
- [ ] Edit mode and the Routine tab are untouched.
- [ ] `dimRightPane()` still dims for someday/deferred.
- [ ] `tsc`, client build, and client tests all clean.
- [ ] No new console errors.
- [ ] Screenshot proof of gated → left-open → fully-open.

## Subtasks

1. Add `gateLeft` / `gateRight` accessors beside `dimRightPane` (`~:575`).
2. Apply `gateLeft` to the left pane div (`:889`), adding `transition-opacity`.
3. Fold `gateRight` into the right pane `classList` (`:1179`), OR-ing with `dimRightPane()`.
4. Add `aria-disabled` to both panes.
5. Verify the edit-mode and Routine-tab exclusions by hand.
6. Run tsc + build + tests; capture screenshots.
