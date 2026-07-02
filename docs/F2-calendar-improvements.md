# F2 — Calendar view improvements (implementation spec)

Companion to [F-calendar-grid.md](archive/F-calendar-grid.md) and [ROADMAP.md](ROADMAP.md). F2 revises the **Calendar** view (`client/src/views/Calendar.tsx` + `client/src/components/CalendarGrid.tsx`) — day/week/month — as distinct from the **Planner** (`Planner.tsx`, the 8h-window TODAY view). It ports two things the Planner already has and the Calendar doesn't (day-type texture, per-day availability), adds container framing the F-calendar-grid F′-4 ticket specced but never built, and upgrades the overlay filter.

**Migration head as of `origin/main`: `0088`.** `0087` (FU2B objective-sync versioning) and `0088` (Phase O · O0, `reflections.source_kind`/`source_ref`) are both **merged, not provisional** — O0 (the FOCUS card) shipped in [#192](https://github.com/companionintelligence/Companion-Planning/pull/192). Phase O further **reserves `0089`/`0090`** for its `day_stars` table + freeze job ([O-gamified-stars.md](archive/O-gamified-stars.md)). **The next free slot for anyone is `0091`.** **F2 is designed to need zero new migrations** — every ticket below reads columns/tables that already exist (`block_kind`, `parent_block_id`, `pattern_blocks`, `day_types`) or adds pure aggregation routes over them. This sidesteps migration numbering entirely; nothing here should renumber regardless of what else lands at `0091+`.

**A live coordination risk, not a numbering one:** [O-gamified-stars.md](archive/O-gamified-stars.md)'s Lane C (O1/O3, not yet started) plans to edit `CalendarGrid.tsx`'s date cells directly — a note-dot (O1) and up to 5 star pips + a perfect-day tint (O3), backed by a new `GET /api/stars?from&to`. That is the same DOM region F2-2 (clickable date → day-type popover) and F2-4 (container hover labels) touch. See the **Coordination with Phase O** risk note below for the layout convention this doc adopts up front to avoid a collision.

## Goal
1. Open day/week scrolled to ~1h before the day's earliest availability window, instead of always defaulting to midnight.
2. Let the user click any date in the header (day/week) or a month cell to set that date's Day Type, from the Calendar — not just day view.
3. Render each visible column's own day-type availability texture (the hatch + direction bands Planner already has), so the Calendar shows the same "today" look on every date, of every kind.
4. Render Time-Block containers as a 10px left-edge handle + outline around their contained tasks, with name/info always visible in day view and shown on hover in week/month.
5. Track per-day star ratings under the date — **deferred to Phase O**, since there is no day-score data yet (see Non-goals).
6. Extend the overlay filter with a Direction/pattern-tag facet and a Hide/Highlight mode toggle (AND-combinable with tag + priority, default mode = Hide).

## Non-goals
- **No 5-star day scoring in this phase.** [O-gamified-stars.md](archive/O-gamified-stars.md) owns the derivation (intention/habits/tasks/bonus/note → 5 stars). F2 does not add a placeholder score or speculative header slot for it — that would be dead code sitting idle until Phase O ships. When Phase O lands its data source, wiring it into the Calendar header is a small follow-up, not part of F2.
- **No axis rescale.** The grid's minute↔pixel mapping (`PX_PER_MIN`, `DAY_HEIGHT_PX`, `minutesIntoDay`/`instantFor` in [grid.ts](../client/src/lib/grid.ts)) is untouched. "Start 1h before the earliest window" is a **scroll position**, not a new coordinate origin — see F2-1's design note on why.
- **No new migrations.** See above.
- **No cross-day container drag** or other F-calendar-grid F′ gesture work — F2-4 is rendering only.

## Current state (what exists today)
- `client/src/views/Calendar.tsx` — view switcher (day/week/month), range nav, the overlay filter panel (tag + priority, AND-combined, lines 233–279), `DayTypeControl` mounted **only when `view() === 'day'`** (lines 282–286), `WeeklyReview` (week only).
- `client/src/components/CalendarGrid.tsx` — `TimeAxis` (day/week, 24h fixed axis from midnight) and `MonthGrid` (6×7 cells). Blocks render via `BlockChip`/`AllDayChip`; overlap layout via `layoutBlocks()`. No day-type texture, no container framing — every block, including `block_kind:'timeblock'` containers, renders as the same chip.
- `client/src/components/Planner.tsx` (the Today view, **not** Calendar) already does two things F2 ports over: resolves the day's day-type and fetches its windows (lines 555–560: `api.dayTypes.resolve` → `api.patternBlocks.forDay` → `computeBands`), then renders `DirectionColumn` + `PatternBlockOverlay` (lines 855, 864). Calendar has none of this — it's the gap F2-3 closes.
- `client/src/lib/day-windows.ts` — `computeBands(windows, tags, prefs)` is the pure, already-shared band computation (used by both `PatternBlockOverlay` and `DirectionColumn` so they never drift). F2 reuses it as-is, per-day.
- `client/src/components/DayTypeControl.tsx` — resolve + assign/clear UI, keyed off the shared `patternBlocks()` store signal so any mutation re-resolves. Already correct; F2-2 just needs it reachable from more places.
- `client/src/stores/index.ts` — `overlayTags`/`setOverlayTags`, `overlayPrio`/`setOverlayPrio`, and the `visibleBlocks` memo (AND-combined tag+priority filter over the fetched range). F2-6 extends this signal set.
- `server/src/routes/pattern-blocks.ts` — `GET /api/pattern-blocks/:dayType` returns one day-type's windows; no batch route for N day types in one call. F2-3 adds one.
- `server/src/db/schema.ts` — `timeBlocks.blockKind` (`'timeblock'` = container), `timeBlocks.parentBlockId` (self-ref FK, container → member) both already exist (lines 97, 113). `Block` DTO (`client/src/lib/api.ts`) mirrors both. F2-4 needs no schema change.

## Design

### F2-1 — Dynamic day start (scroll, not axis rework)

Recomputing `yOf`'s origin would mean subtracting a per-day offset from every position math call, including inside `instantFor`/`minutesIntoDay` — the exact pair the whole grid's no-tz-drift guarantee depends on ([grid.ts](../client/src/lib/grid.ts) lines 28–52). Touching that pair for a display convenience is the wrong trade. Instead, keep the full 24h axis and **auto-scroll** the `TimeAxis` container on mount / day-change:

```ts
// client/src/lib/day-windows.ts (new export, pure)
export function earliestStartMin(bands: Band[], blocks: Block[]): number {
  const bandMin = bands.length ? Math.min(...bands.map((b) => b.top)) : Infinity;
  const blockMin = blocks.length ? Math.min(...blocks.map((b) => /* yOf⁻¹ of b.start_at, see below */)) : Infinity;
  const earliest = Math.min(bandMin, blockMin);
  return Number.isFinite(earliest) ? Math.max(0, earliest - yOf(60)) : 0; // 1h before, clamped to top
}
```

`CalendarGrid`'s `TimeAxis` sets `container.scrollTop = earliestStartMin(...)` in an effect keyed on the visible day(s) changing — **not** on every blocks refetch tick, so a live SSE update doesn't yank the user's manual scroll mid-session. Month view has no time axis; this ticket doesn't touch it.

- **Goal.** Day/week view opens scrolled to ~1h before the earliest resolved availability window (or earliest block, if no day-type windows resolve), instead of always at 00:00.
- **Acceptance.** Opening Calendar in day/week scrolls near the first window/block; switching to a different date recomputes and re-scrolls; a manual scroll during the session is never fought by a background refetch.
- **Tests.** `earliestStartMin` unit-tested (pure): empty bands+blocks → 0; a single 09:00 window → clamps to 08:00; a window starting before 01:00 clamps to 0, not negative. A `CalendarGrid` test asserts the scroll-set effect fires once per day-change, not once per `blocks()` tick.
- **State.** not-started.

### F2-2 — Selectable date header → Day Type popover

Click the date number (not the whole cell) in the day/week header, or a month cell's date number, to open a small popover hosting the existing `DayTypeControl` for that date:

```tsx
// CalendarGrid.tsx header cell (day/week)
<button onClick={() => openDayTypePopover(day)} class="...">
  {dayLabel(day, { day: 'numeric' })}
</button>
<Show when={dayTypePopoverFor() === day}>
  <Popover anchor={...}><DayTypeControl date={day} /></Popover>
</Show>
```

The month cell already uses `onClick` on the cell body for click-to-create (`CalendarGrid.tsx` line 429); F2-2 moves that trigger to the cell body specifically and reserves the date-number span for the day-type popover, so the two don't collide.

Resolved day-type name renders as a small label/tint on the header cell once resolved — reuse the batched resolve from F2-3 rather than firing a `resolve()` per cell.

- **Goal.** Any visible date (day/week header, month cell) opens a Day Type menu on click; the choice reflects immediately as a label/tint on that date.
- **Acceptance.** Clicking a date's number opens the popover; choosing a type calls `api.dayTypes.assign`/`clearAssignment` (unchanged); the popover closes on select or outside-click; month's create-on-click still works via the cell body, unaffected.
- **Tests.** Simulated click → open → select → assign call → close; regression test that clicking a month cell's body (not its date number) still opens the Add wizard.
- **State.** not-started. *(Depends on F2-3's batched resolve to avoid a resolve-per-cell fetch storm; can stub with per-day `resolve()` calls first and swap the data source once F2-3 lands.)*

### F2-3 — Day-type texture per column (port Planner's bands)

Two new **additive, read-only** server routes (no schema change) so week (7 days) and month (42 cells) don't fire N requests:

```ts
// server/src/routes/day-types.ts (new route)
router.get('/api/day-types/resolve-many', (ctx) => {
  const dates = String(ctx.query.dates ?? '').split(',').filter(Boolean);
  ctx.body = { resolved: dates.map((d) => ({ date: d, ...resolveDayType(currentOwnerId(), d) })) };
});

// server/src/routes/pattern-blocks.ts (new route)
router.get('/api/pattern-blocks/for-keys', (ctx) => {
  const keys = String(ctx.query.keys ?? '').split(',').filter(Boolean);
  const owner = currentOwnerId();
  ctx.body = { windows: Object.fromEntries(keys.map((k) => [k, getPatternBlocks(owner, k)])) };
});
```

Client: one `createResource` keyed on the visible day set → `resolve-many` → dedupe to distinct day-type keys → `for-keys` → per-day `computeBands()` (unchanged, from [day-windows.ts](../client/src/lib/day-windows.ts)) → `bandsByDay: Record<string, Band[]>`. `TimeAxis` renders `PatternBlockOverlay` behind each day column using that day's bands. **`DirectionColumn`'s rotated labels stay day-view only** — 7 narrow week columns can't fit them without collision; week shows hatch only. Month renders a lightweight top-strip color swatch per cell from the same batched data (no per-cell hatch — hatch rendering at 42-cell density is the density risk F-calendar-grid.md already flagged for month).

- **Goal.** Every visible day/week column shows its own resolved day-type's texture; month shows a cheap color indicator from the same data, in one batched fetch.
- **Acceptance.** A weekday and a weekend column visibly differ (different bands/colors); switching view or date range issues at most 2 network calls total (`resolve-many` + `for-keys`), not one pair per day; month's swatch never triggers full hatch rendering.
- **Tests.** Server: `resolve-many`/`for-keys` return correct per-date/per-key data for a mixed set (server route test, no DB migration). Client: `bandsByDay` groups correctly per day from batched windows; month swatch component renders from `bandsByDay` without invoking `PatternBlockOverlay`.
- **State.** not-started. *(No dependency — can ship independently of F2-1/F2-2.)*

### F2-4 — Time-Block containers: 10px handle + outline

This is the unbuilt "F′-4" half from [F-calendar-grid.md](archive/F-calendar-grid.md#f′-4—time-block-outlines--pattern-textures-in-the-grid) concerning container outlines (the pattern-texture half is now F2-3, generalized to every day rather than just "today"). Both `block_kind` and `parent_block_id` already exist on `timeBlocks` — no schema work.

```ts
// CalendarGrid.tsx — group placed blocks per day
function groupContainers(placed: Placed[]): { containers: Placed[]; membersOf: Map<string, Placed[]> } {
  const containers = placed.filter((p) => p.block.block_kind === 'timeblock');
  const membersOf = new Map<string, Placed[]>();
  for (const c of containers) {
    membersOf.set(c.block.id, placed.filter((p) => p.block.parent_block_id === c.block.id));
  }
  return { containers, membersOf };
}
```

Render containers as a background layer **behind** member chips: a 10px solid left bar (container/category color) plus a full outline spanning the container's own start/end. Members render unchanged, inset within it. Day view keeps the container's name/info always visible (as today's chip content does); week/month show **only the 10px bar**, with name/info in a hover popover — reusing the same `Popover` primitive F2-2 introduces, not a native `title` (too slow, unstyled).

- **Goal.** `block_kind:'timeblock'` blocks render as a labelled 10px-handle outline framing their `parent_block_id` children, in every view; day view always shows the label, week/month reveal it on hover.
- **Acceptance.** A container draws its outline + 10px bar behind its members in all three views; day view's label is always visible; week/month's label appears only on hover and is absent otherwise; non-container blocks are unaffected; the existing conflict ring (`cols > 1`) still applies independently to members.
- **Tests.** `groupContainers` unit test (containers/members partition correctly, including a container with zero members). DOM test: 10px bar width; day-view label always in the DOM; week/month label absent until a hover event fires.
- **State.** not-started. *(Depends on F2-2's `Popover` primitive for the hover label in week/month; can stub with a native tooltip first and swap.)*

### F2-5 — Per-day stars (owned by Phase O, not F2 — but the cell layout must anticipate it)

[O-gamified-stars.md](archive/O-gamified-stars.md) now specs this concretely, not vaguely: **O3** renders "up to five tiny amber pips (one per earned star)" in each month cell, collapsing to a single glowing star + tinted cell on a perfect day, backed by one `GET /api/stars?from&to` range call per visible month. **O1** additionally adds a small note-dot to any date with a saved day-note. Both are **Phase O's Lane C, not started yet** — F2 still writes zero star/note code.

What F2 *does* need to do, because both efforts land in the same file: **reserve a stable layout convention for the month cell now**, in F2-2 and F2-4, so Phase O's O1/O3 slot in without a redesign later. Adopt this region split in `MonthGrid`'s cell:
- **top-left:** the date number (F2-2's click target → day-type popover).
- **top-right:** reserved for O1's note-dot.
- **body:** block chips (existing) + F2-4's container outlines.
- **bottom strip:** reserved for O3's star pips / perfect-day tint.

F2-2's implementation should claim only top-left and leave top-right/bottom-strip untouched (not even a spacer div — just don't lay anything into those regions), so O1/O3 can add to the cell later with a pure addition, not a rewrite.

- **State.** deferred to Phase O for the feature itself; F2-2/F2-4 adopt the region convention above so the two efforts don't collide.

### F2-6 — Filter: Direction facet + Hide/Highlight mode

Extend the existing `overlayTags`/`overlayPrio` signal pair with a `overlayDirections` (pattern-tag ids) and an `overlayMode` toggle:

```ts
// stores/index.ts
export const [overlayDirections, setOverlayDirections] = createSignal<string[]>([]); // pattern-tag ids
export const [overlayMode, setOverlayMode] = createSignal<'hide' | 'highlight'>('hide'); // default: today's behavior

// One predicate, shared by the hide-mode filter AND the highlight-mode chip styling —
// so the two modes can never disagree about what "matches" means.
export const matchesOverlay = (b: Block) => {
  const t = taskOf(b.task_id);
  const tagOk = !overlayTags().length || t?.tags?.some((x) => overlayTags().includes(x));
  const prioOk = !overlayPrio().length || (t && overlayPrio().includes(t.priority));
  const dirOk = !overlayDirections().length || t?.tags?.some((x) => overlayDirections().includes(x));
  return tagOk && prioOk && dirOk;
};

export const visibleBlocks = createMemo(() =>
  overlayMode() === 'hide' ? (blocks() ?? []).filter(matchesOverlay) : (blocks() ?? []),
);
```

`BlockChip`/`AllDayChip` read `overlayMode() === 'highlight' && !matchesOverlay(b())` to add `opacity-40`, and `matchesOverlay(b())` (in highlight mode, with any facet active) to add a ring — mirroring the existing `conflict()`/`done()` `classList` pattern already in `BlockChip` ([CalendarGrid.tsx](../client/src/components/CalendarGrid.tsx) lines 181–187). The filter panel gets a third chip row (Direction, sourced from `tags` where `kind === 'pattern'`) and a two-button Hide/Highlight toggle next to the existing Clear button. **Default mode is Hide** — unchanged from today, so existing behavior and tests hold with no facets active.

- **Goal.** The overlay panel filters by tag, priority, and now direction/pattern-tag, AND-combined; a mode toggle switches between hiding non-matches (today's behavior, default) and highlighting them in place.
- **Acceptance.** Direction chips appear in the panel; all three facets AND-combine in both modes; default mode on load is Hide (no regression); Highlight mode never changes the rendered block count, only opacity/ring styling.
- **Tests.** `matchesOverlay` unit test across all three facets combined (extends the existing overlay test, which only covered tag+priority). Hide-mode regression: existing filter tests unchanged. Highlight-mode test: block list length constant, `opacity-40`/ring classes applied per `matchesOverlay` result.
- **State.** not-started. *(No dependency — independent of F2-1 through F2-4.)*

## Tests (cross-cutting)
- All new pure functions (`earliestStartMin`, `groupContainers`, `matchesOverlay`) are DOM-free and unit-tested like `grid.test.ts`/`day-windows` conventions already in this codebase.
- No existing grid/tz test should need to change — F2 adds a scroll position and rendering layers; it never touches `minutesIntoDay`/`instantFor`/`yOf`.
- Server route tests for `resolve-many`/`for-keys` run against the existing schema — no migration fixture needed.

## Acceptance criteria
1. Day/week opens scrolled near the earliest window/block, not always at midnight; a manual scroll is never overridden by a background refetch.
2. Every date (day/week header, month cell) opens a Day Type menu on click; the resolved type is visible on the date.
3. Every visible column (day/week) shows its own day-type texture; month shows an equivalent cheap indicator; total added network calls per view load stay O(1), not O(days).
4. `block_kind:'timeblock'` containers render a 10px handle + outline around their members in all views; label is always visible in day view, hover-only in week/month.
5. No day-score/star or day-note rendering ships in F2; Phase O remains the sole owner of both. F2-2/F2-4's month-cell layout leaves the top-right and bottom-strip regions untouched so Phase O's O1/O3 can add to the cell later without a rewrite.
6. The overlay filter AND-combines tag, priority, and direction; a Hide/Highlight toggle exists and defaults to Hide.
7. Zero new migrations. Head stays at `0088` (`0089`/`0090` reserved by Phase O); F2 never needs to claim `0091`.

## Risks / notes
- **Coordination with Phase O (new).** [O-gamified-stars.md](archive/O-gamified-stars.md)'s Lane C (O1 note-dot, O3 star heatmap) is not started but is specced to edit the same `CalendarGrid.tsx` month cells F2-2 and F2-4 touch. F2 adopts the region convention in F2-5 above specifically so this composes. If Phase O's Lane C starts *before* F2-2 lands, re-check the convention against whatever O1/O3 actually ship rather than assuming this doc's guess was exact — the goal is non-overlap, not a specific pixel layout.
- **Scroll-vs-axis discipline (F2-1).** The temptation is to shift the coordinate origin instead of scrolling. Don't — that reopens the exact DST/tz-drift class of bug F-calendar-grid.md's `minutesIntoDay`/`instantFor` pair was built to close. Grep-gate (mirroring the existing hardcoded-`Z` gate) should reject any new offset term inside those two functions.
- **Request fan-out (F2-3).** Without the batched routes, week/month would fire 7–42 `resolve` + `forDay` calls per load. The batched routes are the whole point — don't let F2-2 or F2-4 accidentally reintroduce per-cell fetches when they need resolved day-type data.
- **Popover reuse (F2-2/F2-4).** Building the popover primitive once in F2-2 and reusing it for F2-4's hover label avoids two slightly-different floating-UI implementations drifting apart.
- **Migration coordination.** If either the Phase O lane or the planner-hygiene P1 lane merges `0087` before F2 ships, F2 is unaffected (it adds no migration). Re-verify this note is still true at merge time — a future F2 ticket that *does* need schema (e.g. persisting a per-column collapse preference) would need to claim the next free number, not `0087`.

## Effort
**M** overall — F2-1, F2-2, F2-6 are each S–M; F2-3 is M (mostly the batched-route plumbing); F2-4 is M–L (the container/member grouping + hover popover). F2-5 is a no-op tracked elsewhere. Total roughly comparable to one F-calendar-grid PR-sized phase, but safely splittable — see breakdown below.

## Suggested PR breakdown
1. **F2-6 (filter upgrade)** — fully independent, smallest risk, ships first.
2. **F2-1 (dynamic scroll)** — independent, small, no server change.
3. **F2-3 (batched textures)** — the two new read-only routes + `bandsByDay` + month swatch.
4. **F2-2 (date → day-type popover)** — depends on F2-3's batched resolve for cell labels (can stub-and-swap if sequencing changes).
5. **F2-4 (container outlines)** — depends on F2-2's popover primitive for the week/month hover label; land last.

Each PR is independently reviewable and none touches migrations, so none is blocked by migration numbering. **Land F2-2 before Phase O's Lane C (O1/O3) starts if the timing is in your control** — F2-2 is what establishes the month-cell region convention (F2-5) that O1/O3 then build alongside; landing it first avoids Phase O guessing at a convention that doesn't exist yet.
