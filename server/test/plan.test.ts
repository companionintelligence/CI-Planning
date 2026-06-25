import { describe, it, expect } from 'vitest';
import { orderForToday } from '../src/agents/plan.js';

// Minimal Task/Prefs stand-ins — orderForToday only reads a few fields, and the
// guard paths below return before any model call, so casts are safe.
const task = (id: number, priority: number) =>
  ({ id, title: `T${id}`, priority, dueAt: null, estimatedMinutes: 30 }) as never;
const prefs = (planningMode: string) => ({ planningMode }) as never;

describe('orderForToday (AI ordering)', () => {
  it('returns the deterministic order unchanged when planning_mode is not smart', async () => {
    const ranked = [task(1, 1), task(2, 2), task(3, 3)];
    const out = await orderForToday(ranked, prefs('basic'));
    expect(out).toBe(ranked); // same reference — no reordering attempted, no model call
  });

  it('no-ops on a trivial (single-item) list even in smart mode', async () => {
    const ranked = [task(1, 1)];
    const out = await orderForToday(ranked, prefs('smart'));
    expect(out).toBe(ranked);
  });
});
