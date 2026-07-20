import { describe, it, expect } from 'vitest';
import {
  ACCENT_TOKENS,
  accentColor,
  accentIndex,
  leafObjectiveByTask,
  objectiveOfBlock,
  type AccentSource,
} from './objective-accent.js';

/**
 * #386 — the pure objective→task→block join behind the Planner accent
 * (spike #361 option (c)). No DOM; runs in the node `unit` project.
 */

const leaf = (id: string, taskIds: string[], title = id): AccentSource => ({
  id,
  title,
  tasks: taskIds.map((t) => ({ id: t })),
  children: [],
});

const parent = (id: string, children: AccentSource[], title = id): AccentSource => ({
  id,
  title,
  tasks: [], // AF-2: non-leaves always carry []
  children,
});

const block = (id: string, taskId?: string | null) => ({ id, task_id: taskId });

describe('objectiveOfBlock', () => {
  it('maps a block to its objective via task_id → objective.tasks[].id', () => {
    const map = objectiveOfBlock([leaf('obj-a', ['t1'], 'Ship it')], [block('b1', 't1')]);
    expect(map.get('b1')).toMatchObject({ id: 'obj-a', title: 'Ship it' });
  });

  it('non-contiguous members map to the same objective (the 09:00/15:00 pair)', () => {
    const map = objectiveOfBlock(
      [leaf('obj-a', ['t1', 't2'])],
      [block('b-morning', 't1'), block('b-afternoon', 't2')],
    );
    expect(map.get('b-morning')!.id).toBe('obj-a');
    expect(map.get('b-afternoon')!.id).toBe('obj-a');
    expect(map.get('b-morning')!.colorIndex).toBe(map.get('b-afternoon')!.colorIndex);
  });

  it('a task serving two objectives resolves to the LOWEST objective id, not array order', () => {
    // Same fixtures, both orders — the resolution must not depend on tree order.
    const forward = objectiveOfBlock([leaf('obj-a', ['t1']), leaf('obj-b', ['t1'])], [block('b1', 't1')]);
    const reversed = objectiveOfBlock([leaf('obj-b', ['t1']), leaf('obj-a', ['t1'])], [block('b1', 't1')]);
    expect(forward.get('b1')!.id).toBe('obj-a');
    expect(reversed.get('b1')!.id).toBe('obj-a');
  });

  it('a block with task_id null/undefined gets no entry (break/buffer/container)', () => {
    const map = objectiveOfBlock([leaf('obj-a', ['t1'])], [block('b-null', null), block('b-undef')]);
    expect(map.size).toBe(0);
  });

  it('a task with no objective gets no entry — the chip renders unchanged', () => {
    const map = objectiveOfBlock([leaf('obj-a', ['t1'])], [block('b1', 't-unrelated')]);
    expect(map.has('b1')).toBe(false);
  });

  it('only LEAF objectives contribute — a parent with children never claims tasks', () => {
    // Defensive: even if a non-leaf illegally carried a task link, the walk must
    // ignore it (the server 422s non-leaf links; AF-2 keeps non-leaf tasks []).
    const p = parent('obj-parent', [leaf('obj-child', ['t1'])]);
    (p as { tasks: { id: string }[] }).tasks = [{ id: 't1' }];
    const byTask = leafObjectiveByTask([p]);
    expect(byTask.get('t1')!.id).toBe('obj-child');
  });
});

describe('accentIndex / accentColor', () => {
  it('is stable across calls and independent of tree order', () => {
    expect(accentIndex('obj-a')).toBe(accentIndex('obj-a'));
    const a = objectiveOfBlock([leaf('obj-a', ['t1']), leaf('obj-b', ['t2'])], [block('b1', 't1')]);
    const b = objectiveOfBlock([leaf('obj-b', ['t2']), leaf('obj-a', ['t1'])], [block('b1', 't1')]);
    expect(a.get('b1')!.colorIndex).toBe(b.get('b1')!.colorIndex);
  });

  it('always lands inside the palette and resolves to a CSS var from ACCENT_TOKENS', () => {
    for (const id of ['a', 'obj-1', 'obj-2', '0198fa7e-1111-7000-8000-abcdefabcdef', '']) {
      const idx = accentIndex(id);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(ACCENT_TOKENS.length);
      expect(accentColor({ id })).toBe(`var(--${ACCENT_TOKENS[idx]})`);
    }
  });

  it('#391 — a user-chosen color_token wins; the hash is the fallback', () => {
    // A set token overrides the hash entirely…
    expect(accentColor({ id: 'obj-a', color_token: 'tag-7' })).toBe('var(--tag-7)');
    // …and null/undefined fall back to the stable hash for that id.
    expect(accentColor({ id: 'obj-a', color_token: null })).toBe(`var(--${ACCENT_TOKENS[accentIndex('obj-a')]})`);
    expect(accentColor({ id: 'obj-a' })).toBe(`var(--${ACCENT_TOKENS[accentIndex('obj-a')]})`);
  });
});
