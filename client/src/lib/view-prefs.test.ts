import { describe, it, expect } from 'vitest';
import {
  serializeDeselected,
  deserializeDeselected,
  deserializePrio,
  deserializeAxisState,
  buildCalendarViewPrefs,
} from './view-prefs.js';
import { emptyAxisDeselected } from './overlay.js';
import type { AxisDeselected } from './overlay.js';
import { DEFAULT_AXIS_STATE } from './day-axis.js';

function axes(o: Partial<Record<'direction' | 'intention' | 'category', string[]>>): AxisDeselected {
  const base = emptyAxisDeselected();
  for (const [k, v] of Object.entries(o)) base[k as keyof AxisDeselected] = new Set(v);
  return base;
}

describe('view-prefs (de)serialization', () => {
  describe('serializeDeselected — Sets → sorted arrays', () => {
    it('emits sorted arrays only for non-empty axes', () => {
      expect(serializeDeselected(axes({ direction: ['Work', 'Home'], category: ['Errands'] }))).toEqual({
        direction: ['Home', 'Work'], // sorted
        category: ['Errands'],
      });
    });
    it('emits {} when nothing is deselected', () => {
      expect(serializeDeselected(emptyAxisDeselected())).toEqual({});
    });
  });

  describe('deserializeDeselected — arrays → Sets, forgiving', () => {
    it('rehydrates per-axis Sets', () => {
      const out = deserializeDeselected({ deselected: { direction: ['Home', 'Work'], intention: ['Focus'] } });
      expect([...out.direction].sort()).toEqual(['Home', 'Work']);
      expect([...out.intention]).toEqual(['Focus']);
      expect(out.category.size).toBe(0);
    });
    it('round-trips through serialize', () => {
      const start = axes({ direction: ['Home', 'Work'], category: ['Errands'] });
      const back = deserializeDeselected({ deselected: serializeDeselected(start) });
      expect([...back.direction].sort()).toEqual(['Home', 'Work']);
      expect([...back.category]).toEqual(['Errands']);
      expect(back.intention.size).toBe(0);
    });
    it('degrades to all-on for missing/malformed input', () => {
      expect(deserializeDeselected(undefined)).toEqual(emptyAxisDeselected());
      expect(deserializeDeselected({})).toEqual(emptyAxisDeselected());
      // Non-array / non-string junk is filtered, not thrown on.
      const dirty = deserializeDeselected({ deselected: { direction: [1, 'Home', null] as unknown as string[] } });
      expect([...dirty.direction]).toEqual(['Home']);
    });
  });

  describe('deserializePrio', () => {
    it('keeps numbers, drops junk, defaults to []', () => {
      expect(deserializePrio({ prio: [1, 2, 3] })).toEqual([1, 2, 3]);
      expect(deserializePrio({ prio: [1, 'x' as unknown as number, 2] })).toEqual([1, 2]);
      expect(deserializePrio(undefined)).toEqual([]);
      expect(deserializePrio({})).toEqual([]);
    });
  });

  describe('deserializeAxisState', () => {
    it('reads booleans and falls back to DEFAULT_AXIS_STATE (both collapsed)', () => {
      expect(deserializeAxisState({ topExpanded: true, bottomExpanded: false })).toEqual({
        topExpanded: true,
        bottomExpanded: false,
      });
      expect(deserializeAxisState(undefined)).toEqual(DEFAULT_AXIS_STATE);
      expect(deserializeAxisState({})).toEqual(DEFAULT_AXIS_STATE);
      // A partial/garbled blob keeps the missing flag at its default.
      expect(deserializeAxisState({ topExpanded: true })).toEqual({
        topExpanded: true,
        bottomExpanded: DEFAULT_AXIS_STATE.bottomExpanded,
      });
    });
  });

  describe('buildCalendarViewPrefs', () => {
    it('assembles a sorted, serializable blob from live state', () => {
      const blob = buildCalendarViewPrefs(axes({ direction: ['Work', 'Home'] }), [3, 1], {
        topExpanded: false,
        bottomExpanded: true,
      });
      expect(blob).toEqual({
        deselected: { direction: ['Home', 'Work'] },
        prio: [1, 3], // sorted
        topExpanded: false,
        bottomExpanded: true,
      });
    });
  });
});
