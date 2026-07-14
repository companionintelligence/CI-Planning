> **Type:** Frontend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/focus-plan-week-shell`
> **Commit style:** `feat(focus): Plan-my-week button + assistant shell`
> **Design:** this ticket is the spec (weekly-planning-assistant surface; see `docs/ftue-plan.md` §5 for the broader FTUE framing — the assistant is a distinct, net-new UI surface, not the onboarding wizard)
> **Dependencies:** T1 (planning-session log schema + `api.planWeek.session.*`). T1 lands first; this ticket only **consumes** its client API.

## Goal

Give the FOCUS view a persistent **"Plan my week"** affordance that opens a new modal / bottom-sheet **assistant shell**. The shell is a step state-machine: it lands on a **fixed top-3 branch menu** (Fill next week / Schedule tasks / Review past data) and reuses one **PromptStep** component (question text + up to 3 option chips + a free-text input). Branch bodies are **stubs** in this ticket. The shell **opens a planning session** (T1 API) when it launches and **closes that session** when the user finishes, so every planning interaction is bracketed by a session-log record.

This delivers the entry point and the reusable conversation primitive that T3/T4/T5 (branch logic) and T7/T8/T9 (LLM) build on.

## Non-goals (fence off adjacent work)

- **Do not** implement any branch's real behavior — "Fill next week" (T3), "Schedule tasks" (T4), "Review past data" (T5) are stubs that render one placeholder `PromptStep` and a Back-to-menu control. No planning engine calls, no task/block writes.
- **Do not** add any LLM / NL parsing (T7/T8/T9): no `generate()`, no `renderCopy`, no `parseInstruction`, no `authorPlanOrder`. All copy in this ticket is static strings.
- **Do not** gate the button or the shell on `aiAvailable()` — the shell is fully deterministic in this ticket; AI gating arrives with the LLM tickets.
- **Do not** add voice (T14).
- **Do not** add or change the planning-session **schema or server routes** (T1 owns them). This ticket touches `client/src/lib/api.ts` **only** if T1 has not already added the client wrapper (see Files impacted).
- **Do not** add a new router route — the assistant is a global modal driven by a signal, like `ElementWizard`. No `App.tsx` `<Route>` changes, no `Nav`/`BottomNav` changes.
- **Do not** touch Today, Calendar, or the FAB behavior. The only view changed is `Focus.tsx`.

## Pinned conventions

Restate and match these verified values:

- **Global-modal idiom (mirror `elementModal`).** `stores/index.ts:467` exports `export const [elementModal, setElementModal] = createSignal<{…}>({ open: false, … })` and the component is **mounted once** in the Shell (`App.tsx:154` renders `<ElementWizard />`, self-driven — it reads the signal and renders nothing when closed). Add `planWeekModal` the same way, with a **minimal** shape `{ open: boolean }`.
- **Modal CSS (`client/src/index.css`).** `.modal-backdrop` (index.css:352) = `fixed inset-0 z-[1000] flex items-center justify-center p-4`, dark blur, click-to-close. `.modal` (index.css:358) = `rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden border`. The global `@media (max-width: 767px)` rule (index.css:444-459) **already** turns every `.modal` into a bottom sheet — do not re-implement responsiveness.
- **Modal structure (copy `ObjectiveModal.tsx:117-208`).** Backdrop `<div class="modal-backdrop" onClick={close}>` wrapping `<div class="modal max-w-lg" onClick={(e) => e.stopPropagation()}>`. Header: `class="px-4 py-3 border-b border-border flex items-center justify-between"` with a `<button class="btn-icon" onClick={close}><X size={15} /></button>`. Body: `class="p-4 flex flex-col gap-3"`. Footer (when present): `class="px-4 py-3 border-t border-border flex justify-end gap-2"` using `btn-ghost` / `btn-primary`.
- **Icons.** Import from `'lucide-solid'` (Focus.tsx already imports `Crosshair, Play, Check, RotateCcw`). Use an icon that resolves in this version — e.g. `CalendarRange` or `Sparkles` for the button, `ChevronLeft` for Back, `X` for close. Verify the import compiles under `pnpm --filter client typecheck` before finishing.
- **Client API helper.** `api.ts:3` `request<T>(method, path, body?)`; methods are grouped into per-domain objects on the exported `api` const (e.g. `api.objectives.list`, api.ts:449). The assistant calls **`api.planWeek.session.open()`** and **`api.planWeek.session.close(id)`** (contract owned by T1).
- **Focus header.** `Focus.tsx:260` — `<div class="flex items-baseline gap-3 mb-5">` holds the `<h1>Focus</h1>` and the date `<span>`; its right side is empty. Add a `<div class="flex-1" />` spacer then the right-aligned button; give the button `self-center` so it aligns despite the row's `items-baseline`.
- **Focus empty state.** `Focus.tsx:334-338` — `<Show when={upcoming().length === 0}>` renders a centered muted line; `entries().length === 0` is the **truly-empty-day** branch (currently "Nothing scheduled today — plan your day on Today.").
- **Solid store idiom.** Module-scope `createSignal` in `stores/index.ts`; a plain signal (no resource), so no eager-eval / TDZ ordering concern applies here.

## Before implementation

Read these first and match them exactly:

- `client/src/views/Focus.tsx` (whole file) — header row (lines 260-265) and empty state (lines 334-338) are the two edit sites.
- `client/src/components/ElementWizard.tsx` — the once-mounted, signal-self-driven modal pattern.
- `client/src/components/ObjectiveModal.tsx` — the simple `.modal-backdrop`/`.modal` header/body/footer layout to copy.
- `client/src/stores/index.ts` (around line 467) — the `elementModal`/`setElementModal` block to mirror.
- `client/src/App.tsx` (Shell, line 154) — where `<ElementWizard />` mounts; add `<PlanWeekAssistant />` beside it.
- `client/src/index.css` (`.modal-backdrop`/`.modal` at 352-368, mobile sheet at 444-459).
- `client/src/lib/api.ts` — confirm whether T1 has already added `api.planWeek.session.*` (see below).
- `client/src/components/QuickAdd.test.tsx` — the client component-test convention (`@solidjs/testing-library`, `vi.mock('../lib/api.js', …)` + `vi.mock('../stores/index.js', …)`).

**T1 contract check.** Before writing, grep `client/src/lib/api.ts` for `planWeek`. If T1 has already added the client wrapper, **use it unchanged** and do not edit api.ts. If it is missing (this ticket lands ahead of T1's client methods), add a thin wrapper only — matching T1's merged route/response shape — **without** any server route or schema work. The call sites this ticket needs are fixed: `open()` must return an object carrying a session **id**, and `close(id)` takes that id.

## Files impacted

**New:**
- `client/src/components/PlanWeekAssistant.tsx` — the assistant shell: `.modal-backdrop`/`.modal`, self-driven by `planWeekModal`, a `currentStep` signal state-machine, the fixed top-3 branch menu, and the reusable `PromptStep` sub-component. Renders nothing when `!planWeekModal().open`.

**Changed:**
- `client/src/views/Focus.tsx` — header row (~260-265): add a `flex-1` spacer + a persistent right-aligned "Plan my week" button → `setPlanWeekModal({ open: true })`. Empty state (~334-338): in the `entries().length === 0` branch, add a CTA button below the line that also opens the assistant (and reword the line away from "plan your day on Today").
- `client/src/stores/index.ts` — add `export const [planWeekModal, setPlanWeekModal] = createSignal<{ open: boolean }>({ open: false })` immediately after the `elementModal` block (~line 474).
- `client/src/App.tsx` — mount `<PlanWeekAssistant />` once in `Shell`, directly after `<ElementWizard />` (line 154). Add the import next to the `ElementWizard` import (line 11).
- `client/src/lib/api.ts` — **only if** T1 has not already added it: a `planWeek: { session: { open, close } }` block using `request<T>` (route/response per merged T1; do not invent schema).

## Schema required

None. The planning-session table and its routes are T1's. This ticket adds a client-side signal and consumes T1's API only.

## Definition of Done

- [ ] `planWeekModal` / `setPlanWeekModal` exported from `stores/index.ts`, mirroring the `elementModal` idiom, shape `{ open: boolean }`, default `{ open: false }`.
- [ ] `PlanWeekAssistant.tsx` exists, is mounted once in `App.tsx` `Shell` after `<ElementWizard />`, and renders nothing when `planWeekModal().open` is false.
- [ ] The shell uses `.modal-backdrop` (click-to-close) wrapping `.modal max-w-lg` (`stopPropagation`), with the ObjectiveModal-style header (title "Plan my week" + `btn-icon` `X` close) and body.
- [ ] A `currentStep` signal drives a state-machine: `'menu'` (default) → one of the three branch steps → back to `'menu'`.
- [ ] The **fixed** top-3 branch menu renders exactly these labels, in order: **Fill next week**, **Schedule tasks**, **Review past data**. Each selects its branch step.
- [ ] Each branch step is a **stub**: it renders a single `PromptStep` with a static placeholder question and a Back-to-menu control. No planning logic, no LLM.
- [ ] `PromptStep` is a reusable sub-component taking a question string, up to **3** option chips (renders `options.slice(0, 3)`), and a free-text input; Enter or the submit control fires `onSubmit(text)`; an optional `onBack` renders a Back control.
- [ ] On the `false → true` edge of `planWeekModal().open`, the shell calls `api.planWeek.session.open()` **once**, stores the returned session id, and resets `currentStep` to `'menu'`.
- [ ] On finish/close (X button, backdrop click, or a footer "Done"), the shell calls `api.planWeek.session.close(id)` (only if a session id was captured), then `setPlanWeekModal({ open: false })`.
- [ ] Session open/close are **best-effort**: wrapped in try/catch → `showToast(err.message, 'error')`; a failed `open()` still renders the shell, and a failed/absent-id `close()` still closes the modal locally.
- [ ] The Focus header shows a persistent "Plan my week" button (right-aligned, `self-center`) that opens the assistant.
- [ ] The Focus empty-state (`entries().length === 0`) shows a CTA button that opens the assistant; the stale "plan your day on Today" copy is replaced.
- [ ] No new route, no Nav/BottomNav change, no `aiAvailable()` gate, no changes outside the five files above.
- [ ] `client` typecheck, tests, and build all pass.

## Tests

New file `client/src/components/PlanWeekAssistant.test.tsx` (`@solidjs/testing-library`; mock `../lib/api.js` with `planWeek.session.open`/`close` spies, and `../stores/index.js` with `planWeekModal`/`setPlanWeekModal` signal + `showToast` spy — mirror `QuickAdd.test.tsx`):

- [ ] Opening the modal (`planWeekModal().open` true) calls `api.planWeek.session.open()` exactly once and renders the three fixed labels "Fill next week", "Schedule tasks", "Review past data".
- [ ] Clicking a branch chip advances `currentStep`: the menu is gone and the branch's `PromptStep` question is shown; clicking Back returns to the menu (labels visible again).
- [ ] Closing via the X (and, separately, via backdrop click) calls `api.planWeek.session.close(<id from open>)` once and sets `planWeekModal` to `{ open: false }`.
- [ ] `PromptStep` renders at most 3 option chips even when passed more than 3; typing text + Enter fires `onSubmit` with the typed value.
- [ ] A rejected `api.planWeek.session.open()` still renders the shell (menu visible) and fires a `showToast` error — the shell does not crash or stay blank.

```
pnpm --filter client typecheck
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] **Given** the FOCUS view with any day state, **then** a persistent "Plan my week" button is visible in the header; **when** clicked, the assistant modal opens.
- [ ] **Given** a truly empty day (`entries().length === 0`), **then** the empty-state shows a CTA that opens the same assistant; **and** the copy no longer says "plan your day on Today".
- [ ] **Given** the assistant opens, **then** a planning session is opened via `api.planWeek.session.open()` and the shell lands on the top-3 branch menu.
- [ ] **When** a branch is chosen, **then** its stub `PromptStep` renders (question + up to 3 chips + free-text input) with a Back control that returns to the menu.
- [ ] **When** the user closes or finishes, **then** `api.planWeek.session.close(id)` is called and the modal disappears.
- [ ] **Given** a viewport < 768px, **then** the modal renders as a bottom sheet (inherited from the global `.modal` `@media` rule — no extra code).
- [ ] The assistant is reachable **without** Ollama/AI (no `aiAvailable()` gate) and performs no planning writes.

## Subtasks

1. [ ] Add `planWeekModal`/`setPlanWeekModal` to `stores/index.ts` after the `elementModal` block.
2. [ ] Confirm T1's `api.planWeek.session.open`/`close` exist in `api.ts`; add the thin client wrapper only if absent (no schema/routes).
3. [ ] Create `PlanWeekAssistant.tsx`: signal-guarded `.modal-backdrop`/`.modal` shell, header with title + `X`, `currentStep` state-machine.
4. [ ] Implement the fixed top-3 branch menu with the exact labels; wire each to its branch step.
5. [ ] Implement the reusable `PromptStep` (question + `options.slice(0,3)` chips + free-text input with Enter-submit + optional Back).
6. [ ] Stub each branch step to render one `PromptStep` with placeholder copy and Back-to-menu.
7. [ ] Wire the session lifecycle: open on the `false→true` open edge (store id, reset step), close on finish/close; best-effort try/catch + `showToast`.
8. [ ] Mount `<PlanWeekAssistant />` once in `App.tsx` `Shell` after `<ElementWizard />` (and add the import).
9. [ ] Edit `Focus.tsx` header (spacer + persistent button) and empty state (CTA + reworded copy).
10. [ ] Write `PlanWeekAssistant.test.tsx` covering the cases above.
11. [ ] Run `pnpm --filter client typecheck`, `pnpm --filter client test`, `pnpm --filter client build` and fix any failures.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
