> **Type:** Frontend + Backend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/settings-logs-tab`
> **Commit style:** `feat(settings): planning logs tab`
> **Design:** this ticket is the spec (Weekly Planning Assistant context: `docs/ftue-plan.md`)
> **Dependencies:** T1 — plan-week session store + `GET /api/plan-week/sessions`, `GET /api/plan-week/sessions/:id`, `DELETE /api/plan-week/sessions/:id`, and the client `api.planWeek.session.*` methods. **T6 consumes that contract; it does not define it.**

## Goal

Add a third **Logs** tab to Settings that lists the user's Weekly-Planning-Assistant sessions recorded by T1, and lets them:

- **Review** a session — open its full transcript in a modal.
- **Export** a session — download it as JSON or Markdown.
- **Clear** sessions — delete one (with confirm) or all (with confirm).

The tab reuses the existing `activeTab` pattern in `client/src/views/Settings.tsx` (today `'preferences' | 'connections'`, extended to add `'logs'`). Backend work is **reuse-only**: this ticket adds **no new server route and no schema** — export is done client-side (see the decision below), and delete reuses T1's per-session `DELETE`.

### Backend decision (required by the ticket): export is client-side, no new endpoint

The task allowed a server-side `GET /api/plan-week/sessions/:id/export?format=json|md` **only if it is cleaner than client-side serialization**. It is not — **do NOT add that route.** Rationale:

1. The Review action already fetches the full session via `api.planWeek.session.get(id)`, so JSON export is `Blob([JSON.stringify(session, null, 2)])` with **zero** new server code.
2. Markdown export is a pure, deterministic transform of the transcript the client already holds — no server-only data is needed.
3. A server export route would duplicate that serialization, add a new auth-gated handler + its own tests, and gain nothing.

Therefore T6 ships **client-side Blob downloads** for both formats and **no backend code**. (If T1 turns out to also expose a bulk `DELETE /api/plan-week/sessions`, prefer that single call for Clear-all; otherwise Clear-all loops the per-session `DELETE` — see Pinned conventions.)

## Non-goals

- Do **not** add consolidate / summarize / "digest" of sessions — that is **T10**.
- Do **not** build any assistant / chat / plan-a-week interaction flow here — this tab is read/export/delete over sessions T1 already recorded.
- Do **not** add, alter, or migrate any session schema, table, or column — **T1 owns the plan-week session schema** (no file under `server/src/db/migrations/` in this ticket).
- Do **not** add a `GET .../export` server route (decided against above), nor any other new `server/src/routes/*` route or `api.ts` method — T6 only *consumes* `api.planWeek.session.list/get/delete`.
- Do **not** use the global `elementModal` / `setElementModal` signal for the Review modal — that idiom is reserved for the ElementWizard. Use a local modal (see conventions).
- Do **not** wire the Logs tab into the URL / router — `activeTab` is a plain in-component signal (line 62), not URL-synced; keep it that way.

## Pinned conventions

Verified against the current tree — restate/obey these exactly:

- **Tab state** (`client/src/views/Settings.tsx:62`): `const [activeTab, setActiveTab] = createSignal<'preferences' | 'connections'>('preferences');`. Extend the union to `'preferences' | 'connections' | 'logs'`. Default stays `'preferences'`.
- **Tab bar** (`Settings.tsx:535-557`): two `<button>`s inside `<div class="flex gap-1 mb-5 border-b border-border">`. Each button is `class="px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px"` with a `classList` toggling `'border-primary text-foreground'` (active) vs `'border-transparent text-muted-foreground hover:text-foreground'` (inactive). Add a third identical button labelled **Logs** (with a `<ScrollText size={13} />` before the text, matching the icon-in-section idiom).
- **Tab body**: each tab is a top-level `<Show when={activeTab() === '…'}>` inside the single `<form onSubmit={save} class="flex flex-col gap-5">` (preferences block ends at line 1060; connections block is lines 1063-1585). Add a third sibling `<Show when={activeTab() === 'logs'}>…</Show>`. The Logs content is **not** part of the settings form submit — put its own `<section class="card">`s inside the `<Show>`; do not add form fields that `doSave()` would pick up.
- **Section / card idiom**: `<section class="card"><div class="section-label …">Title</div><p class="text-xs text-muted-foreground mb-3">…</p>…</section>`. Buttons: `btn-primary`, `btn-secondary`, `btn-ghost`, `btn-danger` (all in use in this file). Danger/delete uses `btn-danger` or a `btn-ghost … text-destructive` (see `deleteAccount`, line 1531-1537).
- **List fetch idiom** (copy `Settings.tsx:325-327`, the `accounts` resource): `const [sessions, { refetch: refetchSessions }] = createResource(() => api.planWeek.session.list().then(r => r.sessions).catch(() => null));`. Guard rendering with `<Show when={sessions()} fallback={…loading…}>` and an empty-state when the list is empty. `createResource` is imported already (line 1).
- **Confirm-before-delete idiom** (copy `deleteAccount`, `Settings.tsx:379-388`): `if (!window.confirm(...)) return;` then `await api…delete(...)`, `await refetchSessions()`, `showToast('…', 'success')`, `catch → showToast((err as Error).message, 'error')`. `showToast` and `api` are already imported (lines 3-4).
- **Clear-all**: confirm once, then delete every listed id via **T1's per-session DELETE** — `await Promise.all((sessions() ?? []).map(s => api.planWeek.session.delete(s.id)))` — then `await refetchSessions()`; `catch → showToast(...)`; a `finally` refetch keeps the list truthful on partial failure. **If T1 exposes a bulk `DELETE /api/plan-week/sessions`, call that single method instead** (reuse-first); do not add such a route in T6.
- **Review modal**: use the reusable `.modal-backdrop` / `.modal` CSS (auto bottom-sheet under 768px — `client/src/index.css:352,358,446`). Copy the local-modal shape from `client/src/components/ObjectiveModal.tsx:118-119`: `<div class="modal-backdrop" onClick={props.onClose}><div class="modal max-w-lg" onClick={(e) => e.stopPropagation()}>…</div></div>`. Drive it from a **local** signal in `Settings.tsx`, e.g. `const [reviewing, setReviewing] = createSignal<PlanWeekSession | null>(null);` — **not** the global `elementModal`.
- **Client-side download idiom**: create a `Blob`, `URL.createObjectURL(blob)`, set a temporary `<a>`'s `href` + `download`, `.click()`, then `URL.revokeObjectURL`. (The existing JSON export at `Settings.tsx:1552-1558` uses a static `<a href="/api/export" download>`; the Logs export is dynamic per-session, so build the anchor in a handler.)
- **AI gating**: none. This tab is pure history I/O and must **not** be gated on `aiAvailable()` — sessions and their transcripts are readable/exportable/deletable whether or not Ollama is up. (No `generate()` / `renderCopy` / LLM call anywhere in this ticket.)
- **Owner scoping**: enforced entirely by T1's endpoints (`currentOwnerId()` in `server/src/routes/plan-week.ts`); T6 adds no server code, so there is nothing new to scope.
- **Icons** (all exist in `lucide-solid@1.17.0`): add `ScrollText`, `Eye`, `Download`, `FileJson`, `FileText` to the existing `lucide-solid` import at `Settings.tsx:2`. Reuse the already-imported `Trash2`, `X`, `AlertTriangle`.

### Assumed T1 contract (source of truth is T1 — reconcile before coding)

T1 is a dependency and is not yet on this branch. This ticket assumes the following shape; **at implementation, confirm the exact method names, response envelopes, and field names against T1's merged `client/src/lib/api.ts` and `server/src/routes/plan-week.ts`, and use T1's actual names wherever they differ** (see Subtask 1). Do not redefine or re-export these types — import them from `api.ts`.

- `api.planWeek.session.list()` → `Promise<{ sessions: PlanWeekSessionSummary[] }>`
- `api.planWeek.session.get(id: string)` → `Promise<{ session: PlanWeekSession }>`
- `api.planWeek.session.delete(id: string)` → `Promise<{ ok: boolean }>`
- `PlanWeekSessionSummary` ≈ `{ id: string; owner_id: string; week_start: string; status: string; created_at: string; updated_at?: string; title?: string; turn_count?: number }`
- `PlanWeekSession` ≈ `PlanWeekSessionSummary & { transcript: PlanWeekTurn[] }` (T1 may name the array `messages` or `turns` — bind to whatever T1 exports)
- `PlanWeekTurn` ≈ `{ role: 'user' | 'assistant' | 'system'; content: string; created_at?: string }`

The Markdown serializer (below) is written against `PlanWeekSession` and must be adjusted to T1's real transcript field name if it is not `transcript`.

## Before implementation

Read these first and match them exactly:

- `client/src/views/Settings.tsx` — `activeTab` signal (line 62); tab-bar buttons (lines 535-557); the two tab bodies as sibling `<Show>`s inside one `<form>` (preferences ≤ 1060, connections 1063-1585); the `accounts` `createResource` list idiom (line 325); `deleteAccount` confirm+refetch+toast idiom (lines 379-388); the static export anchor (lines 1552-1558); the `lucide-solid` import line (line 2).
- `client/src/lib/api.ts` — **T1's** `api.planWeek.session.*` methods and the `PlanWeekSession*` types (confirm names). Note the `request<T>()` helper (lines 3-14) and how namespaced groups + exported interfaces are structured (e.g. `accounts`, lines 497-505; `InviteResult`, line 509).
- `client/src/components/ObjectiveModal.tsx` (lines 118-119) — the local `.modal-backdrop` / `.modal` modal shape to copy for Review.
- `client/src/index.css` (lines 352-358, 444-447) — the `.modal` / `.modal-backdrop` classes and their mobile bottom-sheet behavior.
- `server/src/routes/backup.ts` (lines 183-300) — the export/download precedent (Content-Disposition, filename-with-date). **For reference only** — T6 does the equivalent client-side and adds no route.

## Files impacted

**New:**

- `client/src/lib/plan-week-export.ts` — pure, dependency-free serializers used by the export buttons:
  - `sessionToMarkdown(session: PlanWeekSession): string` — deterministic Markdown (H1 title/week, a metadata line for status + timestamps, then each transcript turn as `**Role** · <ts?>` + the content, blank-line separated).
  - `sessionToJson(session: PlanWeekSession): string` — `JSON.stringify(session, null, 2)`.
  - `exportFilename(session: PlanWeekSessionSummary, ext: 'json' | 'md'): string` — e.g. `plan-week-${session.week_start}-${session.id}.${ext}` (deterministic, filesystem-safe).
- `client/src/lib/plan-week-export.test.ts` — vitest unit tests for the three helpers.

**Changed:**

- `client/src/views/Settings.tsx` — extend the `activeTab` union to include `'logs'`; add the Logs tab button; add the `<Show when={activeTab() === 'logs'}>` body with the sessions list, per-row Review/Export-JSON/Export-Markdown/Delete controls, a Clear-all control, and the Review modal; add the local `sessions` resource + `reviewing` signal + the download/delete/clear handlers; add the five new lucide imports.

**Not changed:** `client/src/lib/api.ts` (T1 owns `api.planWeek.session.*`), `server/**` (no backend code), `server/src/db/migrations/**` (no migration).

## Schema required

**None.** T1 owns the plan-week session schema. T6 adds no table, column, index, migration, or Drizzle change. Migration head is untouched (T6 claims no migration slot).

## Definition of Done

- [ ] `activeTab` union is `'preferences' | 'connections' | 'logs'`; a third **Logs** tab button renders in the tab bar with the same active/inactive `classList` styling as the other two and a `<ScrollText size={13} />` glyph.
- [ ] Selecting **Logs** shows a card listing the owner's plan-week sessions (newest-first if the list isn't already ordered), each row showing at least the week/title, status, and created time, sourced from `api.planWeek.session.list()`.
- [ ] Loading and empty states are handled: a loading placeholder while the resource is pending, and a friendly empty-state (icon + one line) when there are no sessions.
- [ ] Each row has a **Review** control that fetches `api.planWeek.session.get(id)` and opens a `.modal-backdrop`/`.modal` modal rendering the full transcript (role-labelled turns); the modal closes on backdrop click and on an explicit close (`X`) button.
- [ ] Each row has **Export JSON** and **Export Markdown** controls that trigger a client-side download of the fetched session (filenames from `exportFilename`, no server round-trip beyond the `get`).
- [ ] Each row has a **Delete** control that confirms via `window.confirm`, calls `api.planWeek.session.delete(id)`, refetches the list, and toasts success/error.
- [ ] A **Clear all** control confirms once, deletes every listed session (Promise.all over the per-session DELETE, or T1's bulk DELETE if present), refetches, and toasts.
- [ ] No new server route, no `api.ts` change, no migration, no `aiAvailable()` gating anywhere in the diff.
- [ ] `plan-week-export.ts` is pure (no imports beyond types from `api.ts`) and covered by `plan-week-export.test.ts`.
- [ ] `pnpm --filter client typecheck`, `pnpm --filter client test`, and `pnpm --filter client build` all pass.

## Tests

- [ ] **`sessionToMarkdown`** — given a fixed `PlanWeekSession` with a multi-turn transcript, returns deterministic Markdown containing the H1 title/week, the status + timestamps metadata line, and one labelled block per turn in order; a session with an empty transcript still produces the header (no throw).
- [ ] **`sessionToJson`** — round-trips: `JSON.parse(sessionToJson(s))` deep-equals `s`.
- [ ] **`exportFilename`** — returns `plan-week-<week_start>-<id>.<ext>` for both `'json'` and `'md'`, and contains no path separators or spaces.
- [ ] **Typecheck** covers the `Settings.tsx` wiring (union widening, resource, handlers, modal) — an incorrect T1 method/field name fails `pnpm --filter client typecheck`, which is the guard that this ticket bound to the real T1 contract.

```
pnpm --filter client typecheck
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] **Given** the Settings view, **when** I click **Logs**, **then** the tab activates (its button shows the `border-primary text-foreground` active styling) and the preferences/connections cards are hidden.
- [ ] **Given** the Logs tab with ≥1 recorded session, **when** it loads, **then** I see one row per session with its week/title, status, and created time.
- [ ] **Given** the Logs tab with no sessions, **when** it loads, **then** I see an empty-state line, not a broken/blank card.
- [ ] **Given** a session row, **when** I click **Review**, **then** a modal opens showing the full transcript with role labels, and closes on backdrop-click or the `X`.
- [ ] **Given** a session row, **when** I click **Export JSON** (or **Export Markdown**), **then** the browser downloads a file named `plan-week-<week>-<id>.json` (or `.md`) whose contents match `sessionToJson` (or `sessionToMarkdown`), with no page navigation.
- [ ] **Given** a session row, **when** I click **Delete** and confirm, **then** the session is deleted server-side (T1 `DELETE`), the list refetches without it, and a success toast shows; cancelling the confirm changes nothing.
- [ ] **Given** ≥1 session, **when** I click **Clear all** and confirm, **then** every session is deleted, the list becomes empty, and a success toast shows.
- [ ] **Given** the whole diff, **when** reviewed, **then** it touches no `server/**` file, no migration, no `api.ts`, and contains no `aiAvailable()` gate.

## Subtasks

1. [ ] **Reconcile with T1.** Read T1's merged `client/src/lib/api.ts` and `server/src/routes/plan-week.ts`; confirm the exact `api.planWeek.session.list/get/delete` names, their response envelopes, and the `PlanWeekSession*` type + transcript field name. Adjust the assumed shapes in this ticket's serializer/UI to T1's actual names. (If T1 is not yet merged into the base, block on it — do not stub the API.)
2. [ ] Create `client/src/lib/plan-week-export.ts` with `sessionToMarkdown`, `sessionToJson`, and `exportFilename`, importing only the T1 types from `../lib/api.js`.
3. [ ] Create `client/src/lib/plan-week-export.test.ts` (vitest) covering the three cases above.
4. [ ] In `Settings.tsx`: widen the `activeTab` union to include `'logs'`; add the five lucide imports (`ScrollText`, `Eye`, `Download`, `FileJson`, `FileText`).
5. [ ] Add the **Logs** tab `<button>` to the tab bar (lines 535-557), matching the existing active/inactive `classList` styling.
6. [ ] Add the local `sessions` resource (copy the `accounts` idiom, line 325) and a `reviewing` signal for the Review modal.
7. [ ] Add the `<Show when={activeTab() === 'logs'}>` body: a `<section class="card">` with a header (title + **Clear all** `btn-danger`, disabled when the list is empty), loading + empty states, and a `<For>` over `sessions()` rendering each row with **Review** (`Eye`), **Export JSON** (`FileJson`/`Download`), **Export Markdown** (`FileText`), and **Delete** (`Trash2`, `text-destructive`).
8. [ ] Implement the handlers: `reviewSession(id)` (get → `setReviewing`), `downloadSession(session, 'json'|'md')` (Blob + temp anchor + `revokeObjectURL`), `deleteSession(s)` (confirm → delete → refetch → toast), `clearAll()` (confirm once → Promise.all delete → refetch → toast).
9. [ ] Add the Review modal (`.modal-backdrop`/`.modal`, copy `ObjectiveModal.tsx:118-119`) rendering `reviewing()`'s transcript with role labels and an `X` close; also expose Export JSON/Markdown inside the modal for convenience.
10. [ ] Run `pnpm --filter client typecheck`, `pnpm --filter client test`, `pnpm --filter client build`; fix until green.

---
<!--
Working-model protocol (do not remove):
• On START, the working model comments: model name + UTC start time.
• On COMPLETE, the working model comments: total token count.
Use scripts/factory/factory.sh start|finish to post these automatically.
-->
