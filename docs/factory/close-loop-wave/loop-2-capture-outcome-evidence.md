> **Type:** Backend
> **Phase:** Close-loop wave — dismissed suggestions
> **Branch:** `feat/capture-possible-outcomes`
> **Commit style:** `feat(possibles): record dismiss and promote as timestamped evidence`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 1 (`0157` must exist)

## Goal

Write one `possible_outcome_log` row every time an owner decides a suggestion — dismiss or
promote — so the loop has a corpus to learn from.

Both decisions go through exactly one service function each, and every surface funnels
through them (verified: `routes/possibles.ts:81` and
`graphql/possible-task-resolvers.ts:74` both call `dismissPossible`), so two call sites
cover the REST list row, the drawer's `SuggestionPanel`, and the GraphQL mutation.

Promotes are captured too, not as an afterthought: they are the denominator for ticket 6's
noise rate, and they let ticket 3 fence out a dismissal the owner later reversed.

**Merge this early even if 3–5 trail.** The corpus cannot be backfilled — existing
`status='dismissed'` rows carry no decision timestamp — so evidence only starts accruing
the day this lands.

## Non-goals

- **Do not change what the click does.** `dismissPossible` must still return
  `{ ok: true, row }` and still set `status = 'dismissed'`; `promotePossible` must still
  return its `PromoteResult` unchanged. Capture is strictly additive.
- **Do not let capture fail the decision.** Wrap the write in a total `try/catch` that logs
  and swallows. A logging failure must never surface to the owner as a failed dismiss.
- **Do not read the log.** No retrieval, no aggregation, no batch. Ticket 3 owns all reads.
- **Do not add a route, a mutation, or a client change.** Every surface already routes
  through the two service functions.
- **Do not touch `possible_tasks`** — no new column, no `dismissed_at`.
- **Do not backfill** existing dismissed rows.
- **Do not write from the audit path.** `writeAudit` stays exactly as it is; this is a
  second, separate write with a different purpose and shape.
- **Do not dedupe by deleting.** If an owner dismisses the same row twice, append twice —
  the log is append-only. Ticket 3 collapses repeats at read time via
  `ix_possible_outcome_log_possible`.

## Pinned conventions

- **Owner scope.** The owner comes from the already-fetched row's **`proposed_owner_id`**,
  not `owner_id` — that is the column name on `possible_tasks`. Both service functions
  already have the row in hand (`dismissPossible` via `.returning()`), so no second query.
- **Id.** `newId()` from `server/src/lib/ids.js` (TEXT UUIDv7).
- **Timestamps.** `decided_at` is `new Date().toISOString()`. `local_date` is
  `localDateInTZ(decidedAt, await ownerTimezone(owner))` — `localDateInTZ` is exported from
  `server/src/lib/tz.ts:102`, `ownerTimezone` from
  `server/src/engine/recurrence-generate.ts:72`. This is the same pairing
  `stampTaskCompletionReflection` uses.
- **`input_text`.** `raw_title`, plus `raw_summary` appended with a single space when
  present and non-empty. This is what the extractor proposed, and it is what ticket 4 will
  embed and retrieve on.
- **`outcome`.** The literal `'dismissed'` or `'promoted'`. Vocabulary enforced in code —
  there is no CHECK constraint.
- **DB access.** `store().prepare(...).run(...)` raw SQL, matching the rest of the learning
  path. `possibles.ts` currently uses Drizzle for its own queries; the log write does not
  need to.
- **Logging.** `logger` from `server/src/lib/logger.js`; log at `warn` on a swallowed
  failure, with the possible id.

## Before implementation

Read `server/src/services/possibles.ts` in full (particularly `dismissPossible` around
line 340 and `promotePossible` at line 199), `server/src/services/classification-learning.ts`
`logAssignment()` for the shape of an evidence write, and
`server/src/services/tasks.ts` `stampTaskCompletionReflection` for the
`ownerTimezone` + `localDateInTZ` pairing.

## Files impacted

**New:**
- `server/test/possible-outcome-capture.test.ts`

**Changed:**
- `server/src/services/possibles.ts` — add `recordPossibleOutcome()`; call it from
  `dismissPossible` and `promotePossible`

## Schema required

None. Ticket 1 created `possible_outcome_log`.

## Definition of Done

- [ ] `recordPossibleOutcome(row, outcome)` exists in `server/src/services/possibles.ts`
- [ ] `dismissPossible` writes one row with `outcome = 'dismissed'` after a successful update
- [ ] `promotePossible` writes one row with `outcome = 'promoted'` after a successful promote
- [ ] Neither writes a row when the update/promote found nothing (`not_found`)
- [ ] `decided_at` is ISO-8601; `local_date` is the owner-local `YYYY-MM-DD`
- [ ] The owner on the log row is the possible's `proposed_owner_id`
- [ ] A throw inside capture cannot change the function's return value

## Tests

- [ ] A dismiss writes exactly one row, with `outcome='dismissed'`, the right owner, an ISO
      `decided_at` and a `YYYY-MM-DD` `local_date`
- [ ] A promote writes exactly one row with `outcome='promoted'`
- [ ] A cross-owner dismiss (driven with the `x-test-owner` header) writes **no** row and
      still returns `not_found`
- [ ] Dismissing an unknown id writes no row
- [ ] Dismissing the same row twice appends two rows (append-only, no dedupe here)
- [ ] With the log table renamed away, a dismiss still returns `ok: true` and still flips
      `status='dismissed'` — capture failure is invisible to the caller
- [ ] `input_text` is `raw_title` alone when `raw_summary` is null, and the joined pair when
      it is present

```bash
pnpm --filter server exec vitest run server/test/possible-outcome-capture.test.ts
pnpm --filter server exec vitest run server/test/possibles.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given a pending suggestion, when the owner dismisses it from any surface (REST list,
      drawer, GraphQL), then exactly one `dismissed` row is appended
- [ ] Given a pending suggestion, when the owner promotes it, then exactly one `promoted`
      row is appended
- [ ] Given the log table is missing, when the owner dismisses, then the dismiss still
      succeeds and a warning is logged
- [ ] Given two owners, then neither can produce a log row attributed to the other

## Subtasks

1. [ ] Read the two service functions and `logAssignment()`
2. [ ] Add `recordPossibleOutcome(row, outcome)` — resolve owner from `proposed_owner_id`,
       stamp `decided_at`/`local_date`, build `input_text`, insert, all inside try/catch
3. [ ] Call it at the end of the success path in `dismissPossible`
4. [ ] Call it at the end of the success path in `promotePossible`
5. [ ] Write `possible-outcome-capture.test.ts` covering the seven cases above
6. [ ] Run the verification commands
