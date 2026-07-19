> **Type:** Backend + Frontend
> **Phase:** FTUE / Weekly Planning Assistant — Wave 5 · Multi-user (DEFERRED)
> **Branch:** `feat/comments-structured-apply`
> **Commit style:** `feat(comments): structured proposals + one-click apply`
> **Design:** this ticket is the spec (STUB — full commit-recipe to be drafted when Wave 5 starts).
> **Dependencies:** M3 (comments backend), M4 (comments UI)

> ### 🚧 OPEN but DEFERRED — issue #355. A stub, not a commit recipe.
> Nothing here has been built, and the full recipe is still to be drafted (see the Design line
> above). Treat this as intent only: it is a snapshot from 2026-07-14 authoring, taken before the
> migration head moved **0126 → 0130** and the ENTITY wave (#357–#375) landed.

## Goal

Make a comment able to carry a **structured proposal** (e.g. reschedule to Fri, change estimate, retitle) that the **event creator applies to their local task in one click** — the comment then resolves (`status='applied'`). Turns the feedback thread into an actionable loop; only the creator (outbound-origin owner) can apply, executing via existing task/block update APIs.

## Non-goals

- Do not let recipients edit the event/task directly (read-only stands; they propose, creator applies).
- Do not add free-form auto-apply — apply is an explicit creator action.
- Do not build the base thread (M4) or storage (M3).

## Status

**STUB — tracking only.** Locked decisions: proposals are typed (`proposal_kind`/`proposal_payload` on the M3 comment); one-click apply performed by the creator on their local task via existing update APIs; applying marks the comment `applied` (resolve tracking). Full commit-recipe to be drafted when Wave 5 begins.

## Definition of Done (high-level)

- [ ] Full body drafted + approved
- [ ] Typed proposal composer (recipient) + one-click apply (creator) → task update
- [ ] Apply sets comment `status='applied'`; only the creator can apply

## Subtasks

1. [ ] Draft the full body when Wave 5 starts
2. [ ] Proposal types + apply-to-task mapping (reuse task/block update APIs)
3. [ ] Tests: only creator applies; apply updates task + resolves comment
