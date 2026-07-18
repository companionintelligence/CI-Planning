> **Type:** DB Migration + Backend
> **Phase:** FTUE / Weekly Planning Assistant — Wave 5 · Multi-user (DEFERRED)
> **Branch:** `feat/event-comments`
> **Commit style:** `feat(comments): cross-owner event comments`
> **Design:** this ticket is the spec (STUB — full commit-recipe to be drafted when Wave 5 starts). See [docs/ftue-plan.md](../../ftue-plan.md).
> **Dependencies:** M1 (a shared external event must exist)

> ### 🚧 OPEN but DEFERRED — issue #353. A stub, not a commit recipe.
> Nothing here has been built, and the full recipe is still to be drafted (see the Design line
> above). Treat this as intent only: it is a snapshot from 2026-07-14 authoring, taken before the
> migration head moved **0126 → 0130** and the ENTITY wave (#357–#375) landed.

## Goal

An internal **comment thread among co-owners of a shared account**, keyed by the **shared external event identity** `(provider, account, external_id)` — NOT a tenant-local `block_id`, because each co-owner ingests their own local copy. Any owner who connects that account (and thus has an `external_events` row for that `external_id`) may read/write the thread. This is the **FIRST cross-owner read path** in the codebase.

## Non-goals

- Do not key comments by a per-tenant `block_id` (breaks cross-tenant sharing).
- Do not build the comment UI (M4) or the structured apply (M5) here.
- Do not widen any other query beyond this scoped comments read.

## Status

**STUB — tracking only.** ⚠️ **Security-sensitive: first cross-owner path.** Locked decisions: comments keyed by `(provider, account, external_id)`; read/write gated on the requesting owner having an active `connection_tokens(owner_id, provider, account)` row AND an `external_events` row for that `external_id`; attributed to `author_owner_id`. Likely `event_comments(id, provider, account, external_id, author_owner_id, body, proposal_kind?, proposal_payload?, status open|resolved|applied, created_at, resolved_at?)`. **Isolation tests are the hard gate**: a non-co-owner MUST NOT read or write the thread.

## Definition of Done (high-level)

- [ ] Full commit-recipe body drafted + approved
- [ ] Schema + service + API for comments keyed by external event identity
- [ ] Cross-owner scope guard (co-connection required)
- [ ] Isolation tests: non-co-owner gets 403/not-found; co-owner reads/writes

## Subtasks

1. [ ] Draft the full body (schema, scope predicate, migration slot, tests)
2. [ ] Implement table + cross-owner scoped service/routes
3. [ ] Isolation test suite (the gate)
