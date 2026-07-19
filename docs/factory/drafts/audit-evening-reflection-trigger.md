> **Type:** Frontend · **Phase:** Audit follow-up (2026-07-19) · **Branch:** `feat/brief-evening-reflection` · **Commit style:** `feat(brief): evening reflection — open, read, edit` · **Design:** this ticket is the spec (docs/Z-focus-ritual.md for the Time-Sense frame) · **Dependencies:** none

## Goal

Make the EOD Alignment narrative **authorable**. The generator is fully built and tested
(`POST /api/reflections/evening/open` → `summarizeEvening` → deterministic-fallback prose +
carry-forward payload) but **no client code calls it** — `server/test/time-sense.test.ts:513`
literally encodes "modal never opened" as the expected state, so Today's Brief "Last night"
section can never show a narrative. After this ticket: the Brief carries a **Reflect** action
that authors the narrative, shows it, lets the owner hand-edit it, and regenerate it.

## Non-goals

- **No server changes.** All three evening routes exist, are `timeSenseGate`d, idempotent, and
  tested (`time-sense.test.ts:318-382, 485-514`). Client-only diff.
- **No new reflection kinds, no scheduling of an evening prompt/notification** (a reminder-driven
  evening nudge is a possible later ticket — out of scope).
- **No new flag.** Gate on `time_sense_enabled` alone (there is no per-channel evening flag, and
  the server gate checks only the master — mirror it exactly).
- Do not restructure BriefMenu's morning prose / capacity / top-tasks sections.

## Pinned conventions

- **Routes (verbatim, `server/src/routes/reflections.ts`):**
  `POST /api/reflections/evening/open` body `{ period_key?, refresh?: boolean }` →
  `{ period_key, body: prose, llm: boolean|null, created: boolean, payload: EveningPayload }`;
  **idempotent** — an existing row returns as-is with `llm: null` unless `refresh: true`
  (L145-166). `PUT /api/reflections/evening` body `{ period_key?, body? }` → `{ ok: true }`;
  **empty body deletes** the narrative (L170-182). Both 404 `{ error: 'Not found' }` when the
  flag is off, 422 on malformed `period_key`. Writes broadcast
  `reflection:updated`/`reflection:deleted` `{ kind: 'evening', period_key, position: 0 }`.
- **Which day:** the Brief folds the **previous** day's evening row into `DaySummary.evening`
  (`evening.prose` contains "`${PREV} in review`" in the fold tests, `time-sense.test.ts:485-514`).
  The client must use **`summary().evening.date` as `period_key`** — never compute the date
  itself.
- **`DaySummary.evening`** (`client/src/lib/api.ts:945-949`): `{ date, prose: string|null,
  carry_forward: [{ task_id, title, status }] }`; the key is **present whenever the flag is on**
  (prose `null` = not yet authored) and absent when off.
- **Client flag idiom** (`FocusRitual.tsx:113` / `Today.tsx:80`): read
  `prefs()?.time_sense_enabled` from the `prefs` store (`stores/index.ts:311`). **`DayGoals.tsx`
  does not import `prefs` today (its store import is at L6) — add it.**
- **Anchor:** BriefMenu (`client/src/components/DayGoals.tsx:403+`); the evening section is
  L489-525 gated `<Show when={summary()?.evening && (prose || carry_forward.length)}>`. The
  "Last night" sub-header (L500-503, `<Moon size={11}/>`) is the in-body anchor for the
  Reflect/Edit controls; the header-row Regenerate button (L469-481, `RefreshCw` under
  `<Show when={aiAvailable()}>`) is the action-button idiom to copy.
- **Section gate must widen:** the current gate hides the section when prose is null AND no
  carry-forward — exactly the un-authored state the new button must be reachable in. New gate:
  render the section whenever `summary()?.evening` exists (flag on); the prose/carry `<Show>`s
  inside keep their own guards.
- **api wrappers to add** (in the `reflections` block, `api.ts:436-453`, mirroring `setNote`'s
  idiom at :448-449): `openEvening(period_key, refresh?)` and `setEvening(period_key, body)`.
- **AI badge truthfulness:** the open response's `llm` field is `true` iff the model authored the
  prose (`summarizeEvening` → `renderCopy` → `source === 'model'`, `agents/summarize.ts:630-644`)
  and `null` when an existing row was returned untouched. Badge "(AI)" only on `llm === true` —
  never on `aiAvailable()` (the T9 rule).
- **Resource update after author/edit:** the BriefMenu summary resource exposes `mutate`
  (`DayGoals.tsx:406`) — after open/PUT, `mutate` the `evening.prose` in place (cheap) or
  refetch `api.summary.get`; pick `mutate` and note the choice.

## Before implementation

1. `server/src/routes/reflections.ts:118-182` — gate + both routes; confirm shapes.
2. `client/src/components/DayGoals.tsx:403-545` — BriefMenu structure, summary resource, the
   evening section + gates.
3. `server/test/time-sense.test.ts:318-382, 485-514` — the authoring/idempotency/fold semantics
   the UI must respect.

## Files impacted

**Changed:**
- `client/src/lib/api.ts` — `reflections.openEvening` + `reflections.setEvening` (+ response
  types `{ period_key, body, llm, created }`).
- `client/src/components/DayGoals.tsx` — import `prefs`; widen the evening-section gate; add the
  Reflect/Regenerate/Edit controls + inline edit textarea.

**New:**
- `client/src/components/DayGoals.evening.test.tsx` — component tests (BriefMenu evening
  interactions; the file name keeps it beside any future DayGoals tests).

## Schema required

**None.**

## Definition of Done

- [ ] With Time-Sense on and no narrative authored, the Brief's "Last night" section renders
      with a **Reflect** button (not hidden as today); clicking it calls
      `openEvening(ev().date)` and the returned prose renders in place.
- [ ] With a narrative present: prose renders (as today), plus **Edit** (inline textarea →
      `setEvening(date, text)` → `{ ok }` → local mutate) and **Regenerate**
      (`openEvening(date, true)`, only shown when `aiAvailable()`, matching the morning
      Regenerate's gate).
- [ ] Clearing the textarea and saving deletes the narrative (server's empty-body-deletes
      contract) and returns the section to the un-authored state.
- [ ] "(AI)" marker renders iff the open response's `llm === true`; an idempotent re-open
      (`llm: null`) and a fallback authoring (`llm: false`) show no marker.
- [ ] With Time-Sense off, nothing new renders anywhere (`summary().evening` is absent — the
      existing behavior is unchanged).
- [ ] Carry-forward list behavior (openCarry → task modal) is untouched.
- [ ] `git diff main -- server/` is empty.

## Tests

`DayGoals.evening.test.tsx` (store-mock pattern per `DayStarsRow.test.tsx` — real signals in the
store mock, api mocked before `await import`):

- [ ] Un-authored state (evening present, prose null) → Reflect button renders; click fires
      `openEvening(ev.date)` (assert the date came from the summary, not from a client clock)
      and the prose appears.
- [ ] Authored state → Edit saves via `setEvening`; empty save returns to un-authored state.
- [ ] Regenerate passes `refresh: true` and renders only when `aiAvailable()`.
- [ ] "(AI)" iff `llm === true` — three-way assertion (true/false/null).
- [ ] `summary()` without `evening` (flag off) → no evening section at all.

Suites to keep green:

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] An owner with Time-Sense on can author, read, edit, regenerate, and delete the EOD
      narrative from Today's Brief.
- [ ] The "modal never opened" degrade path stays intact for owners who never click Reflect.
- [ ] No server diff.

## Subtasks

1. [ ] Add the two api wrappers + types.
2. [ ] Widen the evening-section gate; add Reflect/Edit/Regenerate controls with the truthful
       AI badge; wire `mutate`.
3. [ ] Write the component tests; run the three verification commands green.
