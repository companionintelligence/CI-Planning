> **Type:** Frontend · **Phase:** Audit follow-up (2026-07-19) · **Branch:** `feat/focus-reminders-card` · **Commit style:** `feat(focus): reminders card — list, create, delete` · **Design:** this ticket is the spec (owner placement ruling 2026-07-19: **Focus view**, not Today) · **Dependencies:** none

## Goal

Give the **Focus** view a Reminders card: list the owner's live reminders (soonest first), create
one against a task, and delete one — wiring the fully-built-and-tested server CRUD
(`GET/POST/DELETE /api/reminders`) that today has **zero** client callers. Until now reminders
only ever appear as a fire-time toast with a Snooze action; there is no place to see what's
coming or manage it.

## Non-goals

- **No server changes.** All four routes exist, are owner-scoped, validated, and tested
  (`server/test/reminders.test.ts:205-250`). This ticket is client-only.
- **No snooze UI in the card** — snooze stays on the fire toast (`stores/index.ts:460-464`).
- **No block-linked creation.** The server accepts `taskId` XOR `blockId`; the card's create flow
  targets a **task** only (block reminders keep arriving via the auto engine). Deleting a
  block-linked reminder from the list is allowed (generic DELETE).
- **No edit/reschedule** of an existing reminder — delete + recreate is the v1 story.
- Do not touch the reminder engine (`server/src/engine/reminders.ts`) or notification permission
  logic.

## Pinned conventions

- **Routes (verbatim, `server/src/routes/notifications.ts`):**
  `GET /api/reminders` → `200 { reminders: [{ id, task_id, block_id, fire_at, status, fired_at }] }`
  (L49; service adds `source` — see below). `POST /api/reminders` body
  `{ taskId?, blockId?, fireAt?, date?, time? }` → `201 { reminder }` | `422 { error }`
  ('exactly one of taskId or blockId is required' / 'fireAt (UTC ISO) or date+time is required')
  (L60-71). `DELETE /api/reminders/:id` → `200 { ok: true }` | `404` (L75-79). Mutations broadcast
  `reminder:created { id }` / `reminder:cancelled { id }` (L69, L78).
- **Timezone rule:** the card sends `{ taskId, date, time }` and lets the server resolve
  owner-tz via `zonedWallTimeToUTC` (`services/notifications.ts:127`) — **never** compose a naive
  `${date}T${time}Z` fireAt client-side.
- **`listReminders` returns non-cancelled rows ordered by `fire_at`** and includes `source`
  (`'manual' | 'auto'`, `services/notifications.ts:85-89`) — the client `Reminder` type
  (`client/src/lib/api.ts:901-904`) currently omits `source`; add it as `source?: string`.
- **Store idiom to copy exactly** — no-source resource + SSE refetch
  (`client/src/stores/index.ts:311-313` prefs form, `:243-248` for the `on()` refetch trio):
  ```ts
  export const [reminders, { refetch: refetchReminders }] = createResource(() =>
    api.reminders.list().then((r) => r.reminders));
  on('reminder:created', () => refetchReminders());
  on('reminder:cancelled', () => refetchReminders());
  on('reminder:snoozed', () => refetchReminders());
  on('reminder:fire', () => refetchReminders());
  ```
  (`reminder:fire` and `reminder:snoozed` are already emitted by the engine/routes; the client
  currently listens to them only for toasts — the new refetches keep the card live.)
- **Focus card anchor:** insert the card **after the Time-Sense hero (`Focus.tsx` L321) and
  before the Past-tasks collapser (L323)**. Copy the hero's card idiom:
  outer `rounded-2xl border … p-4` with the eyebrow label class
  `text-[10px] font-semibold uppercase tracking-[0.15em] … mb-1.5` (L280-281), row idiom
  `flex items-center gap-3 px-3 py-2.5 rounded-xl border` (L219-225), action pill (L250),
  `fmtTime(iso)` for times (L27-29), errors via `showToast((err as Error).message, 'error')`.
- **Title resolution for a row:** `task_id` → `taskOf(task_id)?.title`; `block_id` → look up in
  `blocks()`; fall back to `'Reminder'`. `taskOf` and `blocks` are already imported by Focus.tsx
  (L5).
- **Auto reminders:** rows with `source === 'auto'` get a small `auto` badge. Deleting one is
  permitted but the engine may re-derive it on the next task edit (`syncTaskReminders`) — the
  badge's `title` says so: `"Auto reminder — may be re-created when the task changes"`.

## Before implementation

1. `server/src/routes/notifications.ts:46-95` — the four routes; confirm shapes unchanged.
2. `client/src/views/Focus.tsx:260-360` — layout + idioms; confirm the anchor lines.
3. `client/src/stores/index.ts:243-248, 311-313, 460-465` — resource idiom + existing reminder
   handlers.
4. `client/src/components/DayStarsRow.test.tsx` — the store-mocking test template (real Solid
   signals in the store mock; capture `on()` handlers since jsdom has no EventSource).

## Files impacted

**Changed:**
- `client/src/lib/api.ts` — add `source?: string` to `Reminder` (L901-904); no method changes
  (`list`/`create`/`remove` already exist at L322-325 and gain their first callers).
- `client/src/stores/index.ts` — `reminders` resource + `refetchReminders` + the four `on()`
  refetch hooks.
- `client/src/views/Focus.tsx` — the Reminders card (list + inline create + per-row delete).

**New:**
- `client/src/components/FocusReminders.tsx` — the card component (keeps Focus.tsx readable;
  receives nothing, reads stores directly like Focus's other sections).
- `client/src/components/FocusReminders.test.tsx` — component tests.

## Schema required

**None.**

## Definition of Done

- [ ] Focus shows a Reminders card between the hero and the Past collapser, listing every row
      from `reminders()` soonest-first: `fmtTime(fire_at)` + resolved title + status
      (`fired` rows dimmed, `auto` rows badged).
- [ ] The card renders nothing (no empty stub) when there are zero reminders and the create
      affordance is collapsed — an "Add reminder" pill is the only resting-state element.
- [ ] "Add reminder" expands an inline form: task picker (today's open/scheduled tasks from
      `tasks()`), time input (defaults to the next quarter hour), date fixed to today; submit
      posts `{ taskId, date, time }`, then `refetchReminders()`.
- [ ] `422` responses surface via `showToast` with the server's error string.
- [ ] Per-row delete calls `api.reminders.remove(id)` then `refetchReminders()`; a 404 (already
      gone) refetches silently instead of toasting.
- [ ] The card updates live on `reminder:created/cancelled/snoozed/fire` without user action.
- [ ] `git diff main -- server/` is empty.

## Tests

`client/src/components/FocusReminders.test.tsx` (DayStarsRow store-mock pattern):

- [ ] Renders rows soonest-first with resolved task titles; `fired` row carries the dimmed class;
      `auto` row carries the badge.
- [ ] Zero reminders → only the "Add reminder" pill renders (no list chrome, no empty-state text).
- [ ] Create flow: picking a task + time fires `api.reminders.create` with `{ taskId, date, time }`
      (assert NO `fireAt` key) and refetches.
- [ ] Delete fires `api.reminders.remove(id)` and refetches; a rejected remove with `not found`
      does not toast.
- [ ] A captured `on('reminder:created')` handler triggers refetch.

Suites to keep green:

```bash
pnpm --filter client exec tsc --noEmit
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] A user can see upcoming reminders, add one to a task, and delete one — entirely from Focus.
- [ ] The fire-toast + Snooze behavior is unchanged.
- [ ] No server diff; the four existing routes gain their first real UI callers.

## Subtasks

1. [ ] Add `source?` to the client `Reminder` type; add the `reminders` store + SSE refetches.
2. [ ] Build `FocusReminders.tsx` (list → create form → delete), mount it in `Focus.tsx` at the
       pinned anchor.
3. [ ] Write `FocusReminders.test.tsx`; run the three verification commands green.
