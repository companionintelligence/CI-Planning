import { describe, it, expect } from 'vitest';
import { orderForToday } from '../src/agents/plan.js';

// Minimal task/pref shapes — orderForToday only reads a few fields.
const tasks = [
  { id: 1, title: 'A', priority: 1, dueAt: null, estimatedMinutes: 30 },
  { id: 2, title: 'B', priority: 2, dueAt: null, estimatedMinutes: 30 },
] as any[];

describe('plan.orderForToday (AI ordering gate)', () => {
  it('is a no-op in ritual mode — placement stays deterministic, no model call', async () => {
    const out = await orderForToday(tasks, { planningMode: 'ritual' } as any);
    expect(out).toEqual(tasks);
  });

  it('is a no-op for fewer than two tasks even in auto mode', async () => {
    const one = tasks.slice(0, 1);
    const out = await orderForToday(one, { planningMode: 'auto' } as any);
    expect(out).toEqual(one);
  });
});
