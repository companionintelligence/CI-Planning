> **Type:** Frontend
> **Phase:** FTUE / Weekly Planning Assistant — Wave 5 · Multi-user (DEFERRED)
> **Branch:** `feat/share-chip-ui`
> **Commit style:** `feat(share): share-to-account chip + read-only shared badge`
> **Design:** this ticket is the spec (STUB — full commit-recipe to be drafted when Wave 5 starts).
> **Dependencies:** M1 (share backend), T13 (per-account connection list)

> ### 🚧 OPEN but DEFERRED — issue #352. A stub, not a commit recipe.
> Nothing here has been built, and the full recipe is still to be drafted (see the Design line
> above). Treat this as intent only: it is a snapshot from 2026-07-14 authoring, taken before the
> migration head moved **0126 → 0130** and the ENTITY wave (#357–#375) landed.

## Goal

UI to **tag an event with a connected account** to share it: a chip/picker on the event (reusing the tag-chip idiom) over the owner's connected accounts (from T13), showing share status; plus a **read-only "shared" badge** on events a recipient received via the shared account (they can't edit — they can comment via M3–M5).

## Non-goals

- Do not build the comment thread UI (M4) here.
- Do not add new share backend (M1 owns it) or a connection list (T13 owns it).
- Recipients get no edit affordance — read-only.

## Status

**STUB — tracking only.** Locked decisions: recipients are read-only; the share chip reuses the existing tag-chip/popover idiom; account options come from T13's per-account list. Full commit-recipe (exact components, `.modal`/chip reuse, states) to be drafted when Wave 5 begins.

## Definition of Done (high-level)

- [ ] Full body drafted + approved
- [ ] Share chip on the event picks a connected account → calls M1; shows share status
- [ ] Read-only "shared" badge on received events; no edit controls for recipients

## Subtasks

1. [ ] Draft the full body when Wave 5 starts
2. [ ] Share chip (picker over T13 accounts) + shared badge
3. [ ] Tests: recipient sees read-only badge, no edit affordance
