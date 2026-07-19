> **Type:** Frontend + Backend
> **Phase:** FTUE / Weekly Planning Assistant — Wave 5 · Multi-user (DEFERRED)
> **Branch:** `feat/comments-ui-tracking`
> **Commit style:** `feat(comments): comment thread UI + creator tracking`
> **Design:** this ticket is the spec (STUB — full commit-recipe to be drafted when Wave 5 starts).
> **Dependencies:** M3 (comments backend)

> ### 🚧 OPEN but DEFERRED — issue #354. A stub, not a commit recipe.
> Nothing here has been built, and the full recipe is still to be drafted (see the Design line
> above). Treat this as intent only: it is a snapshot from 2026-07-14 authoring, taken before the
> migration head moved **0126 → 0130** and the ENTITY wave (#357–#375) landed.

## Goal

The **comment thread UI** on a shared event (attributed, chronological) plus a **creator tracking surface**: the event creator sees unresolved-comment counts and is notified (reuse the existing SSE + notifications channel) so feedback isn't missed.

## Non-goals

- Do not implement the structured one-click apply (M5) — this is the thread + tracking only.
- Do not add comment storage/scope (M3 owns it).

## Status

**STUB — tracking only.** Locked decisions: internal co-owner comments (from M3); creator tracks unresolved via existing SSE/notifications. Full commit-recipe to be drafted when Wave 5 begins.

## Definition of Done (high-level)

- [ ] Full body drafted + approved
- [ ] Thread UI on the shared event (read/post, attributed)
- [ ] Creator sees unresolved count + notification for new comments

## Subtasks

1. [ ] Draft the full body when Wave 5 starts
2. [ ] Thread component + post box (M3 API)
3. [ ] Tracking: unresolved badge + SSE/notification wiring
