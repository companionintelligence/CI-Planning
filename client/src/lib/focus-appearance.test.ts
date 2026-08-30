import { describe, it, expect } from 'vitest';
import {
  readFocusAppearance,
  writeFocusAppearance,
  resolveSessionMinutes,
  resolveFocusTint,
  FOCUS_APPEARANCE_DEFAULTS,
} from './focus-appearance.js';
import type { ViewPrefs } from './api.js';

const TAGS = [
  { id: 'w', name: 'Work', kind: 'direction' },
  { id: 'h', name: 'Home', kind: 'direction' },
  { id: 'x', name: 'errands', kind: 'context' },
];

describe('readFocusAppearance', () => {
  it('defaults to Breath with no override and no fixed session', () => {
    expect(readFocusAppearance(undefined)).toEqual(FOCUS_APPEARANCE_DEFAULTS);
    expect(readFocusAppearance({})).toEqual({ style: 'breath', colorToken: null, sessionMinutes: null });
  });

  it('reads a saved blob', () => {
    const vp: ViewPrefs = { focus: { style: 'signal', colorToken: 'tag-6', sessionMinutes: 50 } };
    expect(readFocusAppearance(vp)).toEqual({ style: 'signal', colorToken: 'tag-6', sessionMinutes: 50 });
  });

  it('falls back on a stale style id from an earlier build', () => {
    const vp = { focus: { style: 'horizon' } } as unknown as ViewPrefs;
    expect(readFocusAppearance(vp).style).toBe('breath');
  });

  it('treats junk session lengths as "follow the estimate"', () => {
    for (const bad of [0, -10, Number.NaN, 'soon']) {
      const vp = { focus: { sessionMinutes: bad } } as unknown as ViewPrefs;
      expect(readFocusAppearance(vp).sessionMinutes).toBeNull();
    }
  });

  it('treats an empty colour token as "follow the direction"', () => {
    const vp = { focus: { colorToken: '' } } as unknown as ViewPrefs;
    expect(readFocusAppearance(vp).colorToken).toBeNull();
  });
});

describe('writeFocusAppearance', () => {
  it('keeps the other view_prefs blobs', () => {
    const existing: ViewPrefs = { calendar: { prio: [1, 2] }, appearance: { direction_textures: false } };
    const out = writeFocusAppearance(existing, { style: 'signal' });
    expect(out.calendar).toEqual({ prio: [1, 2] });
    expect(out.appearance).toEqual({ direction_textures: false });
    expect(out.focus).toEqual({ style: 'signal' });
  });

  it('merges over an existing focus blob rather than replacing it', () => {
    const existing: ViewPrefs = { focus: { style: 'signal', colorToken: 'tag-2' } };
    expect(writeFocusAppearance(existing, { sessionMinutes: 25 }).focus)
      .toEqual({ style: 'signal', colorToken: 'tag-2', sessionMinutes: 25 });
  });

  it('writes null to clear an override (only undefined is skipped)', () => {
    const existing: ViewPrefs = { focus: { colorToken: 'tag-2', sessionMinutes: 25 } };
    const out = writeFocusAppearance(existing, { colorToken: null });
    expect(out.focus).toEqual({ colorToken: null, sessionMinutes: 25 });
  });
});

describe('resolveSessionMinutes', () => {
  it('a chosen session length wins over the estimate', () => {
    expect(resolveSessionMinutes(50, 25)).toBe(50);
  });
  it('falls back to the estimate, then to 30', () => {
    expect(resolveSessionMinutes(null, 45)).toBe(45);
    expect(resolveSessionMinutes(null, null)).toBe(30);
    expect(resolveSessionMinutes(null, undefined)).toBe(30);
  });
  it('keeps the pre-existing 15-minute floor', () => {
    expect(resolveSessionMinutes(null, 5)).toBe(15);
    expect(resolveSessionMinutes(1, 60)).toBe(15);
  });
  it('never returns a non-positive length from a junk estimate', () => {
    expect(resolveSessionMinutes(null, 0)).toBe(30);
    expect(resolveSessionMinutes(null, Number.NaN)).toBe(30);
  });
});

describe('resolveFocusTint', () => {
  const block = { color_token: 'chart-3' };

  it('uses the task direction colour by default (Work / Home / Community)', () => {
    const tint = resolveFocusTint({ task: { tags: ['Work'] }, tagDefs: TAGS, block });
    expect(tint).toBe('var(--chart-4)'); // BASE_TAG_DEFAULTS.work
  });

  it('prefers the owner-saved direction colour over the brand default', () => {
    const tint = resolveFocusTint({
      task: { tags: ['Home'] }, tagDefs: TAGS, patternPrefs: { h: { color_token: 'tag-9' } }, block,
    });
    expect(tint).toBe('var(--tag-9)');
  });

  it('an explicit override beats the direction', () => {
    const tint = resolveFocusTint({ override: 'tag-6', task: { tags: ['Work'] }, tagDefs: TAGS, block });
    expect(tint).toBe('var(--tag-6)');
  });

  it('falls back to the block colour when the task has no direction', () => {
    expect(resolveFocusTint({ task: { tags: ['errands'] }, tagDefs: TAGS, block })).toBe('var(--chart-3)');
    expect(resolveFocusTint({ task: null, tagDefs: TAGS, block })).toBe('var(--chart-3)');
  });

  it('falls back to primary with nothing to go on', () => {
    expect(resolveFocusTint({})).toBe('var(--primary)');
  });
});
