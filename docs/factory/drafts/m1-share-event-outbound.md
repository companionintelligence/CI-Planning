> **Type:** DB Migration + Backend
> **Phase:** FTUE / Weekly Planning Assistant — Wave 5 · Multi-user (DEFERRED)
> **Branch:** `feat/share-event-outbound`
> **Commit style:** `feat(share): share event to a connection account (outbound push)`
> **Design:** this ticket is the spec (STUB — full commit-recipe to be drafted when Wave 5 starts). See memory `project_ftue_weekly_assistant`.
> **Dependencies:** None (Wave 5 foundation). Related: T13 (connection list).

## Goal

Let a user **share an event by tagging it with a connection's account**: mark a local `time_blocks` row to be pushed **outbound** to that external account's calendar, reusing the existing outbound-sync machinery (`external_events.direction='outbound'` + `outbound_queue`). Because co-owners who connect the same external account re-ingest the event, the shared external account is the multi-user link — **no cross-owner query hook is added here**.

## Non-goals

- Do not add a cross-owner (owner↔owner) query/visibility hook — sharing is mediated by the external calendar.
- Do not build the comment thread (M3) or the share UI chip (M2) here.
- Do not widen the tenant-isolation layer (`blockRowsForQuery` stays owner-only).

## Status

**STUB — tracking only.** Locked decisions: sharing = OUTBOUND push to the connection account's calendar; reuse `external_events(direction='outbound')` + `outbound_queue`; link between users = shared external account (co-owners re-ingest). **Before implementation must VERIFY** the outbound push path is actually wired/active (calendar sync has historically been pull-only per Phase J) — if stubbed, activating the outbound execution is in-scope. Likely a small share-marker relation keyed to `connection_tokens(owner_id, provider, account)`.

## Definition of Done (high-level)

- [ ] Full commit-recipe body drafted + approved (incl. outbound-path verification finding)
- [ ] Marking a block for a connected account enqueues an outbound push; the event appears on that account's external calendar
- [ ] Owner-scoped; no cross-owner data path introduced

## Subtasks

1. [ ] Verify/activate the outbound sync push path (`agents/sync.ts` outbound, `outbound_queue` 0055/0057)
2. [ ] Draft the full body (schema/service/route/tests)
3. [ ] Implement share-marker + enqueue; tests for the outbound mirror
