import { describe, it, expect } from 'vitest';
import { tagHueToken, tagColorVar, doneHatchStyle } from './textures.js';

/**
 * Per-tag hue (quick-complete done-hatch). A tag deterministically maps to one of
 * the 12 CI-Hub `--tag-N` tokens; the hatch background is that hue at 60% alpha.
 */
describe('tagHueToken', () => {
  it('always returns tag-1…tag-12', () => {
    for (const t of ['work', 'errands', 'gym', '', 'a-very-long-tag-name', '🎯']) {
      const tok = tagHueToken(t);
      const n = Number(tok.replace('tag-', ''));
      expect(tok).toMatch(/^tag-([1-9]|1[0-2])$/);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(12);
    }
  });

  it('is deterministic and distributes distinct tags across hues', () => {
    expect(tagHueToken('work')).toBe(tagHueToken('work')); // stable
    const hues = new Set(['work', 'errands', 'gym', 'family', 'reading', 'admin'].map(tagHueToken));
    expect(hues.size).toBeGreaterThan(1); // not all collapsed to one hue
  });

  it('null/undefined collapse to a single stable hue', () => {
    expect(tagHueToken(null)).toBe(tagHueToken(undefined));
  });
});

describe('tagColorVar + doneHatchStyle', () => {
  it('wraps the token as a CSS var', () => {
    expect(tagColorVar('work')).toBe(`var(--${tagHueToken('work')})`);
  });
  it('emits a 45° (upper-left→lower-right) repeating hatch at 60% alpha, 1px/8px', () => {
    const style = doneHatchStyle('work')['background-image'];
    expect(style).toContain('repeating-linear-gradient(45deg');
    expect(style).toContain('60%');
    expect(style).toContain('0 1px'); // 1px stroke
    expect(style).toContain('1px 9px'); // 8px gap (period 9)
  });
});
