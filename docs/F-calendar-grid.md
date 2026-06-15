# F — Calendar grid (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). Track-1 feature phase; **depends on B0** (owner-scoped queries via `lib/context.ts`, owner-scoped `broadcast`, migration runner). Mostly a client phase — the one correctness rule is **no timezone drift between a block's pixel position and its stored UTC instant**.

## Goal
1. Replace the day-list `Calendar.tsx` with a real **2-D time grid** in day / week / month views: a vertical time axis (minutes → pixels) crossed with one column per day.
2. **Drag-to-move** and **edge-resize-to-reschedule**, persisted through the existing `PATCH /api/blocks/:id`, with an optimistic update reconciled by the `block:updated` SSE event.
3. **All-day events**, a live **"now" line**, **conflict highlighting** for overlapping blocks, and **overlays filterable by tag AND priority** (combinable, both from the linked task).
4. Week/month **block-range fetch** that is owner-scoped and tz-correct, generalizing `dayRangeUTC` to multi-day ranges.

## Non-goals
- **No new block semantics** — recurrence (E), timers (D), and two-way sync (J) are their own phases. The grid renders and moves blocks that already exist.
- **No drag-to-create** of new blocks in v1 (move/resize only); creation stays via the existing `POST /api/blocks` path.
- **No cross-day drag** in week view for v1 (vertical move within a column + resize only) — see Risks; cross-column move is a fast-follow.
- No server scheduling/reflow changes — that is K. `PATCH` here just writes the times the user dragged to.

## Current state (what exists today)
- `client/src/views/Calendar.tsx` — a **day list**: a week strip of 7 buttons over a single `<For>` of `BlockCard`s sorted by `start_at`. It selects one day via `setBlockRange(dayRangeUTC(d))`; there is no 2-D axis, no drag, no overlap geometry.
- `client/src/components/BlockCard.tsx` — a flat card: colored left border by `block_kind` (CI teal palette), `fmtTime` via `toLocaleTimeString` (renders the stored UTC instant in the browser zone — the convention to preserve), Done/Skip buttons calling `api.blocks.update`, and a `Lock` icon when `is_locked`. No positioning logic.
- `client/src/lib/dates.ts` — `localISODate()` and **`dayRangeUTC(dateStr)`**, which builds UTC bounds from **local** `Date` parts (`new Date(y, m-1, d, …).toISOString()`) so a Pacific user's day maps to the correct UTC window. This is the reusable correctness primitive; F adds a `rangeUTC(fromDate, toDate)` beside it.
- `client/src/stores/index.ts` — `[blockRange, setBlockRange]` signal feeding a `createResource` (`blocks`) that calls `api.blocks.list(from, to)`; SSE `on('block:created'|'block:updated'|'block:deleted'|'schedule:done', refetchBlocks)`. The store already wires the refetch loop F reuses.
- `server/src/routes/blocks.ts` — `GET /api/blocks?from&to` (`gte(startAt, from)`, `lte(endAt, to)`), `POST`, **`PATCH /api/blocks/:id`** (already accepts `start_at`/`end_at`/`status`/`is_locked`), `DELETE`. Each mutation calls `broadcast('block:…', out)`. **Note:** these handlers do **not** yet owner-scope (`broadcast` takes no `ownerId`); B0 adds `currentOwnerId()` + `broadcast(ownerId, …)` — F builds on that, it does not re-do it.
- `server/src/db/schema.ts` — `timeBlocks` has `block_kind`, `start_at`, `end_at`, `is_locked`, `is_auto`, `status`, `task_id`. **There is no `all_day` column** and no tag/priority on the block — overlay tag/priority come from the linked `tasks` row (`priority` 1–5, `task_tags`). `Block` (`client/src/lib/api.ts`) mirrors these snake_case fields.

## Design

### 1. Range fetch for week / month (tz-correct, owner-scoped)
`dayRangeUTC` already proves the pattern; generalize it rather than hand-rolling new bounds:

```ts
// client/src/lib/dates.ts  (new, beside dayRangeUTC)
export function rangeUTC(fromDate: string, toDate: string): { from: string; to: string } {
  const [fy, fm, fd] = fromDate.split('-').map(Number);
  const [ty, tm, td] = toDate.split('-').map(Number);
  return {
    from: new Date(fy, fm - 1, fd, 0, 0, 0, 0).toISOString(),      // local-midnight → UTC
    to:   new Date(ty, tm - 1, td, 23, 59, 59, 999).toISOString(),
  };
}
export function weekDaysOf(anchor: string): string[] { /* Monday-based; reuse Calendar.tsx addDays */ }
export function monthGridOf(anchor: string): string[] { /* 6×7 leading/trailing days */ }
```

The view sets `setBlockRange(rangeUTC(firstVisibleDay, lastVisibleDay))`. The `blocks` resource and SSE refetch in `stores/index.ts` are reused **unchanged** — only the range widens. Month view fetches the whole 6×7 window in one request; the server query (`gte/lte` on the UTC bounds) and B0 owner-scoping already constrain it. Degrade gracefully: an empty range renders an empty grid, never an error.

### 2. The 2-D grid component (minutes ↔ pixels)
One axis function owns the mapping, so position and persistence can never disagree:

```ts
// client/src/lib/grid.ts
export const PX_PER_MIN = 0.8;                 // 48px/hour; one source of truth
export const SNAP_MIN = 15;

// Local minutes-since-midnight for a UTC instant, in the *column's* day.
export function minutesIntoDay(iso: string, dayStr: string): number {
  const d = new Date(iso);                                       // parsed as UTC, read as local
  const [y, m, day] = dayStr.split('-').map(Number);
  const midnight = new Date(y, m - 1, day, 0, 0, 0, 0).getTime();
  return (d.getTime() - midnight) / 60_000;                      // crosses DST correctly (real elapsed)
}
export const yOf   = (mins: number) => mins * PX_PER_MIN;
export const minsOf = (y: number)   => Math.round(y / PX_PER_MIN / SNAP_MIN) * SNAP_MIN;
```

```tsx
// client/src/components/CalendarGrid.tsx (sketch)
<div class="relative grid" style={{ 'grid-template-columns': `4rem repeat(${days().length}, 1fr)` }}>
  <TimeGutter />
  <For each={days()}>{(day) =>
    <div class="relative border-l border-surface-700" style={{ height: `${24 * 60 * PX_PER_MIN}px` }}>
      <For each={laidOut(blocksByDay()[day] ?? [])}>{(b) =>
        <BlockChip block={b.block} day={day}
          style={{ top: `${yOf(b.top)}px`, height: `${yOf(b.height)}px`,
                   left: `${b.col / b.cols * 100}%`, width: `${100 / b.cols}%` }} />}
      </For>
      <Show when={day === todayLocal()}><NowLine day={day} /></Show>
    </div>}
  </For>
</div>
```

- **Block height clamps to a visible minimum** (e.g. `Math.max(height, 18px)`) for short blocks, but the *stored* duration is untouched — clamp is display-only.
- **Overlap layout** (`laidOut`): sort by `start_at`, sweep into overlapping clusters, assign each block a `col` index within its cluster and `cols = clusterWidth`; columns split the day-column width. This is also what feeds **conflict highlighting** (§7): any block whose cluster width > 1 gets a `conflict` style.
- **Month view** is a different cell renderer (a 6×7 day grid, each cell a count + chips), not the time axis — share `blocksByDay()`, swap the cell component.

### 3. Drag-to-move + edge-resize → `PATCH /api/blocks` (the optimistic loop)
Pointer events on the chip body = move; on a 6px top/bottom handle = resize. Convert the pixel delta back through the **same** `minsOf`/`minutesIntoDay` math, rebuild the UTC instant from the column's local day, and `PATCH`:

```ts
function instantFor(dayStr: string, mins: number): string {           // inverse of minutesIntoDay
  const [y, m, d] = dayStr.split('-').map(Number);
  return new Date(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() + mins * 60_000).toISOString();
}

async function commitDrag(b: Block, day: string, newTopMin: number, newBottomMin: number) {
  if (b.is_locked || b.block_kind === 'meeting') return;             // §locked: reject, snap back
  const start_at = instantFor(day, newTopMin);
  const end_at   = instantFor(day, newBottomMin);
  setOverride(b.id, { start_at, end_at });                           // 1. optimistic: local override map
  try {
    await api.blocks.update(b.id, { start_at, end_at });             // 2. PATCH (one request per gesture)
  } catch (err) {
    clearOverride(b.id); showToast((err as Error).message, 'error'); // 3. rollback on failure
  }
  // 4. block:updated SSE → refetchBlocks() → resource replaces the row → clearOverride(b.id)
}
```

- **One PATCH per gesture** (on pointer-up), never per pointer-move — the move only mutates the local override.
- **Optimistic override map** is a `createSignal<Record<number, Partial<Block>>>`; the chip reads `override[id] ?? block`. On the `block:updated` SSE the refetched authoritative row supersedes it and the override is cleared — closing the **drag → PATCH → optimistic → SSE** loop already half-built in `stores/index.ts`.
- **Resize clamps to a minimum duration** (e.g. `SNAP_MIN`); dragging an edge past the opposite edge clamps, it does not invert.
- **No tz drift (the critical property):** `start_at`/`end_at` are only ever produced by `instantFor`, the exact inverse of `minutesIntoDay`. The grid never formats a wall-clock string with a literal `Z`; UTC↔local stays inside these two functions. A block dragged 0px PATCHes back a byte-identical instant.

### 4. All-day events (no new mutable wall-clock)
There is no `all_day` column today. Add one via a **new numbered migration through the B0 runner** (`server/src/db/migrations/00NN_block_all_day.ts`, idempotent add-column), default `false`, plus `all_day` on the `Block` DTO and the `PATCH` allow-list in `routes/blocks.ts`. Render all-day blocks in a **pinned header lane** above the time axis (one row per visible day), not on the minute axis:

```tsx
<Show when={allDayOf(day).length}>
  <div class="all-day-lane"><For each={allDayOf(day)}>{(b) => <AllDayChip block={b} />}</For></div>
</Show>
```

All-day blocks are excluded from `minutesIntoDay`/overlap layout and are **not vertically draggable** (they have no minute position); v1 leaves them move-by-edit only. Degrade gracefully: a DB lacking the column (pre-migration boot race) treats `all_day` as `false`.

### 5. The "now" line
A thin absolutely-positioned rule at the current local minute, only in today's column, ticking once a minute:

```tsx
function NowLine(props: { day: string }) {
  const [mins, setMins] = createSignal(minutesIntoDay(new Date().toISOString(), props.day));
  const t = setInterval(() => setMins(minutesIntoDay(new Date().toISOString(), props.day)), 60_000);
  onCleanup(() => clearInterval(t));
  return <div class="now-line" style={{ top: `${yOf(mins())}px` }} />;
}
```

Uses the same `minutesIntoDay`/`yOf` as blocks, so the line and the blocks share one coordinate system. Deterministic given a fixed clock (tests inject a frozen `now`).

### 6. Locked / meeting blocks reject drag
`is_locked` blocks and `block_kind === 'meeting'` are **non-interactive**: pointer-down on them does not start a gesture (guarded in `commitDrag` and at gesture start), they render with the `Lock` affordance `BlockCard` already shows, and the cursor stays default. A locked block can never emit a PATCH. (Meetings become externally-owned in J; treating them immovable now avoids fighting sync later.)

### 7. Overlays — tag AND priority (combinable) + conflict highlighting
Overlay filter is **client-side** over the already-fetched range (no new endpoint), AND-combined:

```ts
// stores/index.ts
export const [overlayTags, setOverlayTags] = createSignal<string[]>([]);     // tag names; empty = all
export const [overlayPrio, setOverlayPrio] = createSignal<number[]>([]);     // priorities 1–5; empty = all
export const visibleBlocks = createMemo(() => (blocks() ?? []).filter((b) => {
  const t = taskOf(b.task_id);                                               // block → linked task
  const tagOk  = !overlayTags().length || t?.tags?.some((x) => overlayTags().includes(x));
  const prioOk = !overlayPrio().length || (t && overlayPrio().includes(t.priority));
  return tagOk && prioOk;                                                     // both must hold → combinable
}));
```

- Tag/priority live on the **task**, not the block; blocks with no `task_id` (break/buffer) pass only when no filter is set. The filter UI reuses the `tags` resource and a 1–5 priority chip row.
- **Conflict highlighting** is independent of the overlay: it comes from §2's cluster width on the *visible* set, so highlighting reflects what the user is actually looking at.

## Tests
- **Grid math (`grid.test.ts`, deterministic):** `minutesIntoDay` ∘ `instantFor` is identity for sampled instants; a 30-min block at 09:00 local maps to the expected `top`/`height` at a fixed `PX_PER_MIN`; **a drag across a spring-forward DST day produces the correct elapsed minutes** (reuse the day a `lib/tz` test already covers) — no off-by-60-min drift.
- **No-tz-drift (the headline test):** dragging a block by 0px PATCHes a `start_at`/`end_at` byte-identical to the input; dragging +1h shifts exactly 60 min and round-trips through `GET /api/blocks` unchanged.
- **Drag/resize (`@solidjs/testing-library`):** one move gesture emits exactly **one** PATCH on pointer-up (none on pointer-move); resize below `SNAP_MIN` clamps; resizing the bottom past the top clamps, never inverts.
- **Locked/meeting:** pointer-down on `is_locked` or `block_kind==='meeting'` starts no gesture and emits no PATCH.
- **Optimistic + SSE:** an optimistic override shows immediately, is superseded by the `block:updated` refetch, and is rolled back on a 4xx/5xx PATCH (toast shown, original position restored).
- **Overlays:** tag-only, priority-only, and tag+priority combined each filter correctly; clearing both shows all; a block with no `task_id` only appears unfiltered.
- **All-day:** all-day blocks render in the header lane, are absent from the minute axis, and survive a refetch; pre-migration (`all_day` absent) degrades to `false`.
- **Range/server:** week and month ranges fetch the right block set; the range query stays owner-scoped (B0) — a second owner's blocks never appear. Standing Vitest + container Playwright suites stay green; the migration adds an `idempotent-migration` fixture case.

## Acceptance criteria
1. Day, week, and month views render blocks at consistent positions from one axis function; switching views never moves a block in time.
2. Drag-to-move and edge-resize persist via a single `PATCH /api/blocks/:id` per gesture and **survive reload** (server is authoritative).
3. **No tz drift:** a moved block's stored UTC instant is the exact inverse of its grid position; a 0-distance drag is a no-op write.
4. `is_locked` and `meeting` blocks are immovable and emit no PATCH.
5. All-day events render in a separate lane; the now-line tracks the current local minute in today's column.
6. Overlays filter by tag and priority **combinably**; conflict highlighting marks overlapping visible blocks.
7. Range fetch is owner-scoped and tz-correct via the `dayRangeUTC`/`rangeUTC` convention; existing suites green.

## Risks / notes
- **DST is the trap.** Position math must use **real elapsed milliseconds** (`getTime()` deltas), never `start_at.slice(11,16)` wall-clock arithmetic — a focus block spanning a DST boundary would otherwise jump 60px. The `minutesIntoDay`/`instantFor` pair is the only sanctioned converter; a grep gate (mirroring B0's hardcoded-`Z` gate) should reject literal `Z`/`slice(11,…)` wall-clock parsing in client view code.
- **Cross-day drag deferred.** Moving a block to another column changes its calendar day, not just its minute — punted to a fast-follow to keep v1's gesture math one-dimensional.
- **Month density.** A 6×7 month range can fetch many blocks; cap rendered chips per cell (overflow "+N") and lean on the existing `gte/lte` range query — do not fetch per-cell.
- **Optimistic vs SSE ordering.** If `block:updated` arrives before the PATCH promise resolves, the override is already superseded — clearing it twice must be idempotent (keyed by block id).
- **Overlap layout cost.** The sweep is O(n log n) per day; fine at realistic block counts, but the month renderer should skip full overlap layout (counts/chips only).
- **`all_day` migration ordering.** Ship the column migration before the client reads it; a client built against `all_day` talking to an un-migrated server must treat it as `false`, not crash.

## Effort
**L** — the largest Track-1 phase. ~1 week: most of it is the grid geometry, overlap layout, and the gesture→PATCH→optimistic→SSE loop with airtight DST/tz handling. The server change is one idempotent `all_day` migration plus adding `all_day` to the `PATCH` allow-list; everything else is client.

## Suggested PR breakdown
1. **Static grid + range fetch** (no interaction): `lib/grid.ts`, `rangeUTC`/`weekDaysOf`/`monthGridOf`, `CalendarGrid.tsx` day/week/month rendering, overlap layout + conflict highlighting, now-line. Ship with `grid.test.ts`.
2. **Drag/resize + optimistic loop:** pointer gestures, override map, `commitDrag` → `PATCH`, locked/meeting guards, rollback; the no-tz-drift and one-PATCH-per-gesture tests.
3. **All-day + overlays:** `00NN_block_all_day` migration + DTO/PATCH wiring, all-day lane, tag+priority overlay filter UI and `visibleBlocks` memo, their tests.

Splitting this way lands a usable read-only grid first (PR 1), then makes it editable (PR 2), then adds the schema-touching extras (PR 3) — each diff stays reviewable and the DST/tz risk is concentrated in PR 2.
