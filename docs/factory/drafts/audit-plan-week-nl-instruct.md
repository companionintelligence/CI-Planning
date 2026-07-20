> **Type:** Frontend · **Phase:** Audit follow-up (2026-07-19) · **Branch:** `feat/plan-week-nl-instruct` · **Commit style:** `feat(plan-week): free-text instructions — preview, confirm, apply` · **Design:** owner rulings 2026-07-19 — Fill + Schedule branches; **preview → confirm** (never apply-on-submit); truthful `llm_used` · **Dependencies:** none. **Unblocks T14 (#350)** — voice feeds the text box this ticket makes live.

## Goal

Make free-text natural-language planning instructions **reachable** in the shipped app. Today the
entire chain is built and dead: `PromptStep`'s text box never renders (all three branches supply
bespoke components), `POST /api/plan-week/parse` has no live caller, and the apply twin
`POST /api/plan/instruct` (§A4: pins → locked obstacle blocks, hints persisted for the next
autoplan) has **zero callers anywhere**. After this ticket: the Fill and Schedule branches each
carry an instruction box; submit **parses** ("block off Tuesday mornings for deep work" → a
readable preview of pins + hints), and an explicit **Apply** button calls the apply route. The
session's `llm_used` flag finally becomes truthful at close.

## Non-goals

- **No server changes.** Parse (`plan-week.ts:97-116`), apply (`plan.ts:23-47` →
  `instructPlan`, engine-ops.ts:82-88), and the sessions PATCH (`llm_used` plumbed at
  `plan-week.ts:148,165-169`) all exist and are tested. Client-only diff.
- **No NL box on the Review branch** (read-only contract) or the assistant menu.
- **No voice** — that is T14; this ticket only gives it a live landing spot.
- **Do not change** `parseInstruction`'s vocabulary, the pin/hint semantics, or the
  `OnboardingWizard.tsx:90` close call (onboarding uses no LLM today; its `llm_used` stays unsent
  → server default 0).
- Do not delete PromptStep or its standalone tests — its fallback contract stays; only its
  doc-comment changes (see DoD).

## Pinned conventions

- **Parse (preview) call:** `api.planWeek.parse(text, date?)` → `PlanWeekParseResponse
  { ok, date, pins: PlanPin[], hints: PlanHint[] }` (`api.ts:515-516, 753`) — zero writes,
  verified by `server/test/plan-week-parse.test.ts`. `PlanPin = { title, start_at, end_at }`,
  `PlanHint = { kind: 'tag_before'|'tag_after'|'batch'; tag; time? }` (`api.ts:748-749`).
- **Apply call:** `api.plan.instruct(text, date?)` → `InstructResponse { ok, date, pins, hints,
  created }` (`api.ts:264, 750`). Server-side `instructPlan` runs **the same `parseInstruction`**
  the preview used (engine-ops.ts:84) — preview === apply semantics; pins insert as
  `block_kind='meeting', is_locked=1, is_auto=0, source_kind='instruct'` obstacle blocks and the
  route broadcasts `block:created` when `created > 0`.
- **Both calls pass `date: selectedDay()`** — the same anchor Fill's `api.auto.run` uses
  (`PlanWeekFill.tsx:87`). Never omit it (the server would default to ITS today).
- **Error surfacing:** the server sends `{ error: message }` with 422 (invalid: bad time, overlap,
  unknown tag, nothing actionable) or 503 (Ollama down); `request()` throws `Error(err.error)`
  (`api.ts:9-12`) — show `err.message` inline in the box (NOT the old uniform copy in
  `PromptStep:103`; the server's message is specific and actionable).
- **Gating:** the box renders inside `<Show when={aiAvailable()}>` (`stores/index.ts:303`), same
  as PromptStep's input (`PlanWeekAssistant.tsx:126`) — parsing needs Ollama.
- **T9 truthfulness rule** (`PlanWeekFill.tsx:15-19, 95` + its test `:191-223`): UI claims about
  AI are gated on what the server reported, never on `aiAvailable()`. For this ticket:
  a **successful parse IS model usage** (`parseInstruction` is `generateJson`-backed and throws
  `unavailable` otherwise — `agents/plan.ts:892-909`), so parse-success and apply-success both
  count as AI usage; `nextStep` counts only when `res.source === 'model'`
  (`PlanWeekScheduleTasks.tsx:79`); `auto.run` counts only when `result.llm === true`.
- **Session close plumbing already exists:** `api.planWeek.session.close(id, { status, summary?,
  llm_used? })` (`api.ts:493`) → PATCH maps `llm_used` → `closeSession`'s `llmUsed`
  (`plan-week.ts:148,165-169`; persistence proven by `server/test/plan-week-sessions.test.ts:100-119`).
  The two shell close sites are `PlanWeekAssistant.tsx:188` (branch-switch abandon) and `:219`
  (the `close()` helper) — **both must send `llm_used`**.
- **`BranchProps`** (`PlanWeekAssistant.tsx:37-40`) is `{ append, onBack }`; branch components
  receive it at `:276`. Extend it with `reportAiUse: () => void` (shell-owned signal).
- **Transcript kinds:** branch appends use `plan_week:*` kinds (`plan_week:confirm`,
  `plan_week:schedule_auto`, …). The new box appends `plan_week:instruct_preview` on parse and
  `plan_week:instruct_apply` on apply, via `props.append`.
- **Branch anchors:** Fill — the `step() === 'confirm'` block (`PlanWeekFill.tsx:180-188`),
  above the Confirm button ("any constraints before I fill the week?"). Schedule — the question
  step, directly after the AI-chip `<Show>` (`PlanWeekScheduleTasks.tsx:151-161`).
- **Test harness:** `PlanWeekAssistant.test.tsx` idioms — api/store mocks before `await import`,
  branch stubs, `aiAvailableFlag.current` box (`:22-57,71`); PromptStep standalone block
  (`:255-320`) shows the input-interaction patterns to copy.

## Before implementation

1. `PlanWeekAssistant.tsx:29-82, 126, 151-225, 266-278` — shell, BranchProps, PromptStep, close
   sites.
2. `PlanWeekFill.tsx` + `PlanWeekScheduleTasks.tsx` in full — step machines + anchors.
3. `server/test/plan-week-parse.test.ts` + `server/test/instruct.test.ts` — the exact
   error-case matrix the UI must surface (overlap, bad time, unknown tag, nothing-actionable,
   503).
4. The T9 test `PlanWeekFill.test.tsx:191-223` — the truthfulness assertion style to replicate
   for `llm_used`.

## Files impacted

**New:**
- `client/src/components/InstructBox.tsx` — the shared preview→confirm component:
  props `{ date: () => string; append: BranchProps['append']; reportAiUse: () => void }`.
  Free-text input → parse → preview list (pins as `title · HH:MM–HH:MM`, hints as
  `kind #tag [time]`) → Apply / Discard. Apply calls `api.plan.instruct`, toasts
  `Applied: N pin(s), M hint(s)`, refetches `blocks` (pins are real calendar blocks).
- `client/src/components/InstructBox.test.tsx`.

**Changed:**
- `client/src/components/PlanWeekAssistant.tsx` — `BranchProps` gains `reportAiUse`; shell adds
  an `aiUsed` signal; both close sites (`:188`, `:219`) send `llm_used: aiUsed()`; the DEAD-CODE
  comment block (`:64-72`) is rewritten to state the new reality (free-text is live via
  InstructBox in Fill/Schedule; PromptStep remains the menu-fallback shape only).
- `client/src/components/PlanWeekFill.tsx` — mounts `<InstructBox>` in the confirm step; calls
  `props.reportAiUse()` when `result.llm === true` on its existing run (`:87-95`).
- `client/src/components/PlanWeekScheduleTasks.tsx` — mounts `<InstructBox>` in the question
  step; calls `props.reportAiUse()` when `nextStep.source === 'model'` (`:79`).
- `client/src/components/PlanWeekAssistant.test.tsx`, `PlanWeekFill.test.tsx`,
  `PlanWeekScheduleTasks.test.tsx` — extended per Tests.

## Schema required

**None.**

## Definition of Done

- [ ] Fill's confirm step and Schedule's question step each render the InstructBox when
      `aiAvailable()`; hidden otherwise (chips/steps unaffected).
- [ ] Submitting text calls **parse only** — no block/hint exists until Apply (assert via the
      absence of an `instruct` call in tests).
- [ ] The preview renders every returned pin (`title`, local start–end) and hint (kind + tag),
      plus an explicit `Nothing actionable` path surfacing the server's 422 message inline.
- [ ] Apply calls `api.plan.instruct(text, selectedDay())`, appends `plan_week:instruct_apply`
      (`Applied: N pin(s), M hint(s) (AI)`), refetches blocks, and collapses the preview.
- [ ] Discard clears the preview without any API call.
- [ ] `reportAiUse()` fires on: successful parse, successful apply, Fill's `result.llm === true`,
      Schedule's `source === 'model'` — and on NOTHING else (never bare `aiAvailable()`).
- [ ] Both shell close sites send `llm_used: aiUsed()`; a session where no AI event fired closes
      with `llm_used: false`.
- [ ] PromptStep's doc-comment (`:64-72`) no longer claims the chain is dead; its standalone
      tests still pass unchanged.
- [ ] `git diff main -- server/` is empty.

## Tests

`InstructBox.test.tsx`:
- [ ] Parse-only on submit: `parse` called with `(text, date)`, `instruct` NOT called; preview
      renders `1 pin(s)` shapes with times; input survives for editing.
- [ ] Apply: `instruct` called with the SAME `(text, date)` as the preview; append fired with
      kind `plan_week:instruct_apply`; `reportAiUse` called; preview collapses.
- [ ] 422 path: rejected parse renders the server's message verbatim inline; no append, no
      `reportAiUse`.
- [ ] Discard: no `instruct` call, preview gone.
- [ ] Hidden when `aiAvailable()` is false.

Shell + branches:
- [ ] `PlanWeekAssistant.test.tsx`: close after a `reportAiUse` carries `llm_used: true`; close
      with no AI event carries `llm_used: false` (both close sites — helper AND branch-switch
      abandon).
- [ ] `PlanWeekFill.test.tsx`: `reportAiUse` fires iff `result.llm === true` (mirror the T9
      test's two-sided assertion at `:191-223`).
- [ ] `PlanWeekScheduleTasks.test.tsx`: `reportAiUse` fires iff `source === 'model'`.

Suites to keep green:

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] A user in Plan-my-week can type "block off Tuesday mornings for deep work", see exactly
      what was understood, and apply it — locked pin blocks appear on the Planner and hints
      shape the next autoplan run.
- [ ] A misparse never touches the calendar (preview-only until Apply).
- [ ] The Logs tab's sessions now record `llm_used` truthfully.
- [ ] T14's "mic → existing free-text box" DoD has a real box to target in both branches.

## Subtasks

1. [ ] Build `InstructBox.tsx` + its tests first (pure parse→preview→apply contract).
2. [ ] Extend `BranchProps` with `reportAiUse`; add the shell's `aiUsed` signal; wire both close
       sites; rewrite the PromptStep dead-code comment.
3. [ ] Mount the box in Fill (confirm step) + Schedule (question step); wire their existing AI
       events to `reportAiUse`.
4. [ ] Extend the three branch/shell test files; run the three verification commands green.
5. [ ] Comment on T14 (#350) that its landing spot now exists (mic targets InstructBox).
