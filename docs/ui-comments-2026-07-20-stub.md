# UI comments stub — 2026-07-20 (Today view + Flight Plan)

> Captured from a screenshot-annotation + notes pass. Items 1–2 were **BUILT** as part of
> T14 (#350, branch `feat/plan-week-voice`); items 3–5 remain open — promote to Factory
> tickets when scheduled.

## Today view — quick-add & Add modal

1. ✅ **DONE (T14 branch)** — **Move the inline "Add a task…" quick-input line into the FAB.**
   - The Today top-of-page QuickAdd is removed; ElementWizard's header now hosts the NL
     quick line (below the Task/Time Block tabs, above the title), with a mic (T14 voice).
   - Deliberate semantics change: the line is **parse→preview→approve** (zero-write
     `/tasks/quick/parse` hydrates the wizard fields; Add creates) — the old QuickAdd
     created on Enter with no preview.

2. ✅ **DONE (T14 branch)** — **NL input generates an immediate preview in the Add modal.**
   - Enter (or a voice transcript) parses and hydrates title/day/time/duration/priority/
     direction/tags — visible in the fields and the mini day-timeline for approval.

## Flight Plan (Today view)

3. **"Fill plan" button stopped working.** Regression — the Fill-plan action no longer does
   anything. Needs repro + root-cause. *(Verify against current `main`; may relate to the
   plan-week / InstructBox wiring from #387.)*

4. **Move the Flight Plan container above the Planner.** Ordering change — the Flight Plan
   card should sit above the Planner grid in the Today view layout.

5. **Overdue tasks are not returning to "open" (or similar).** Overdue tasks appear stuck —
   not transitioning back to `open` status when they should (e.g. after a day rollover /
   reschedule). Needs investigation of the overdue→open transition path. *(The DUE section
   in the screenshot shows "1 overdue" with many P1 items pinned at 5:00 PM — worth
   confirming whether these are duplicated/stuck rows.)*

---

### Follow-up notes for whoever picks this up
- Items 3 and 5 are **bug reports** (regressions) — prioritize repro before the layout/UX
  changes (1, 2, 4).
- Item 5's screenshot shows the same few task titles repeated many times under DUE
  (`tech digest`, `Re-establish a social rhythm`, `Start the conversation about helping Mom
  retire`) — could be a duplication symptom of the same overdue-handling bug, worth checking
  the query that populates the DUE list.
