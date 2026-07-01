import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { DayStar } from '../lib/api.js';

/**
 * Feature pilot — DayStarsRow's LIVE header reactivity, proven at the DOM level.
 *
 * DayStarsRow keys a createResource on `[props.date, tasks(), scheduledByTaskId()]`
 * and additionally refetches when a reflection SSE event fires (the intention
 * done-state → S1 and the day note → S5 are written via the reflections routes,
 * which don't flow through the tasks store). This is the exact "header updates as
 * you check things off" behaviour that pure-function tests (lib/stars.test.ts)
 * cannot cover — it needs a real render + a real reactive re-run.
 *
 * SEAMS mocked (smallest set that still exercises the resource re-running):
 *  - `../lib/api.js`  — so `api.stars.range` returns total:3 first, total:4 next,
 *                       with NO network. We assert 3/5 → 4/5 across a refetch.
 *  - `../lib/sse.js`  — `on()` in the real module constructs an `EventSource`,
 *                       which jsdom does not provide, and there'd be no stream to
 *                       drive anyway. We capture the handler DayStarsRow registers
 *                       for `reflection:updated` and invoke it directly — that is
 *                       precisely the reactive dependency the component subscribes
 *                       to, so firing it re-runs the resource for real.
 *  - `../stores/index.js` — provides `tasks()` / `scheduledByTaskId()` as REAL
 *                       Solid signals (created with this test file's own
 *                       `createSignal`, from a module mocked at a different
 *                       specifier than the component's other imports). Below,
 *                       one test drives the refetch via the SSE callback; the
 *                       other drives it by calling the exposed setter and
 *                       relying on the component's own `createResource` to pick
 *                       up the change through its `[props.date, tasks(),
 *                       scheduledByTaskId()]` source array — a genuine
 *                       cross-module Solid dependency read, not a plain callback.
 *                       Both must pass for the resource's dual reactive wiring to
 *                       be proven; either one regressing fails only that test.
 */

// Serve total:3 on the first call, total:4 on every call after — modelling a
// live star being earned between renders.
const star3: DayStar = { date: '2026-07-01', frozen: false, objective: true, habits: true, tasks: true, bonus: false, note: false, total: 3 };
const star4: DayStar = { ...star3, bonus: true, total: 4 };
const rangeMock = vi.fn(async (_from: string, _to: string): Promise<DayStar[]> => []);

vi.mock('../lib/api.js', () => ({
  api: {
    stars: {
      range: (from: string, to: string) => rangeMock(from, to),
    },
  },
}));

// Capture the reflection handlers DayStarsRow registers so the test can fire them.
const sseHandlers = new Map<string, Set<() => void>>();
vi.mock('../lib/sse.js', () => ({
  on: (event: string, handler: () => void) => {
    if (!sseHandlers.has(event)) sseHandlers.set(event, new Set());
    sseHandlers.get(event)!.add(handler);
    return () => sseHandlers.get(event)?.delete(handler);
  },
}));

// Real signals, exposed so tests can drive the OTHER reactive dependency
// (see the module doc above). `setTasks` models a task completion updating the
// app-wide store — DayStarsRow never sees a "completion", it only reads `tasks()`.
const [tasksSig, setTasks] = createSignal<unknown[]>([]);
const [schedSig] = createSignal(new Map<string, unknown>());
vi.mock('../stores/index.js', () => ({
  tasks: () => tasksSig(),
  scheduledByTaskId: () => schedSig(),
}));

// Import AFTER the mocks are registered so the component binds to them.
const { DayStarsRow } = await import('./DayStarsRow.js');

function fireSse(event: string) {
  sseHandlers.get(event)?.forEach((h) => h());
}

describe('DayStarsRow — live header reactivity', () => {
  beforeEach(() => {
    rangeMock.mockReset();
    sseHandlers.clear();
    setTasks([]);
    rangeMock.mockResolvedValueOnce([star3]).mockResolvedValue([star4]);
  });

  it('renders the served tally, then refetches + updates the DOM on a reflection event', async () => {
    const { findByText, getByText } = render(() => <DayStarsRow date="2026-07-01" />);

    // First render: the resource resolves to total:3.
    expect(await findByText('3/5')).toBeInTheDocument();
    expect(rangeMock).toHaveBeenCalledTimes(1);

    // A reflection change (e.g. saving the day note) broadcasts reflection:updated.
    // DayStarsRow's handler calls refetch() → the resource re-runs → total:4.
    fireSse('reflection:updated');

    await waitFor(() => expect(getByText('4/5')).toBeInTheDocument());
    expect(rangeMock).toHaveBeenCalledTimes(2);
  });

  it('also refetches + updates the DOM when the tasks store signal changes', async () => {
    const { findByText, getByText } = render(() => <DayStarsRow date="2026-07-01" />);

    expect(await findByText('3/5')).toBeInTheDocument();
    expect(rangeMock).toHaveBeenCalledTimes(1);

    // A task completion updates the app-wide `tasks()` store signal directly —
    // no SSE event involved. This is the OTHER half of DayStarsRow's resource
    // key ([props.date, tasks(), scheduledByTaskId()]) and the concrete
    // regression this pilot exists to catch: if `tasks()` is ever dropped from
    // that key, this assertion fails even though the SSE test above still
    // passes. Because `tasksSig`/`setTasks` live in a module mocked at a
    // different specifier than the component under test, this read only
    // works if Solid is correctly deduped (GOTCHA 1) — a duplicate instance
    // would make the resource's dependency tracking miss this signal entirely.
    setTasks([{ id: 'task-1' }]);

    await waitFor(() => expect(getByText('4/5')).toBeInTheDocument());
    expect(rangeMock).toHaveBeenCalledTimes(2);
  });
});
