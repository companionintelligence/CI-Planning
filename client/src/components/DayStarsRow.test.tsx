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
 *  - `../stores/index.js` — provides `tasks()` / `scheduledByTaskId()` as inert
 *                       signals so importing the component doesn't pull the whole
 *                       store graph (which fetches on import). The refetch trigger
 *                       under test is the reflection seam above; these are just the
 *                       other resource dependencies, held constant here.
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

// Inert store signals — held constant; the reflection SSE is the refetch trigger.
const [tasksSig] = createSignal<unknown[]>([]);
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
});
