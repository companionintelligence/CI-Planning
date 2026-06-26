import { describe, it, expect } from 'vitest';
import { textureSeed, textureStyle, motifFor, TEXTURE_OPACITY, blockColorVar, tagColorVar } from './textures.js';

describe('textureSeed — deterministic + well-distributed', () => {
  it('is stable for the same tag across calls', () => {
    expect(textureSeed('work')).toBe(textureSeed('work'));
    expect(textureSeed('errands')).toBe(textureSeed('errands'));
  });

  it('differs for different tags', () => {
    expect(textureSeed('work')).not.toBe(textureSeed('family'));
    expect(textureSeed('a')).not.toBe(textureSeed('b'));
  });

  it('always returns a non-negative 32-bit integer', () => {
    for (const tag of ['', 'x', 'a-long-tag-name', '日本語']) {
      const s = textureSeed(tag);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('distributes a realistic tag set with no collisions', () => {
    const tags = ['work', 'family', 'errands', 'health', 'admin', 'focus', 'home',
      'finance', 'social', 'learning', 'fitness', 'chores', 'project-x', 'project-y'];
    const seeds = new Set(tags.map(textureSeed));
    expect(seeds.size).toBe(tags.length);
  });

  it('treats null/undefined/empty as the same stable seed', () => {
    expect(textureSeed(null)).toBe(textureSeed(undefined));
    expect(textureSeed(null)).toBe(textureSeed(''));
  });
});

describe('motifFor — shape mapping (incl. user-defined fallback)', () => {
  it('maps the three built-in shapes', () => {
    expect(motifFor('circle')).toBe('circle');
    expect(motifFor('square')).toBe('square');
    expect(motifFor('triangle')).toBe('triangle');
  });
  it('is case-insensitive', () => {
    expect(motifFor('Circle')).toBe('circle');
    expect(motifFor('TRIANGLE')).toBe('triangle');
  });
  it('falls back to square for unknown / user-defined shapes', () => {
    expect(motifFor('hexagon')).toBe('square');
    expect(motifFor(null)).toBe('square');
    expect(motifFor(undefined)).toBe('square');
  });
});

describe('textureStyle — deterministic, shape-correct, subtle', () => {
  it('is identical for identical (shape, tag)', () => {
    expect(textureStyle('circle', 'work')).toEqual(textureStyle('circle', 'work'));
  });

  it('produces a visibly different tile for a different tag', () => {
    const a = textureStyle('circle', 'work')['mask-image'];
    const b = textureStyle('circle', 'family')['mask-image'];
    expect(a).not.toBe(b);
  });

  it('encodes the motif that matches the pattern type', () => {
    // The SVG is URI-encoded inside the mask url(); decode and inspect the shape tag.
    const decode = (s: string | number) => decodeURIComponent(String(s));
    expect(decode(textureStyle('circle', 't')['mask-image'])).toContain('<circle');
    expect(decode(textureStyle('square', 't')['mask-image'])).toContain('<rect');
    expect(decode(textureStyle('triangle', 't')['mask-image'])).toContain('<polygon');
  });

  it('stays a low-contrast whisper (≤ 8%) and is theme-adaptive', () => {
    const style = textureStyle('square', 'errands');
    expect(Number(style.opacity)).toBeLessThanOrEqual(0.08);
    expect(style['background-color']).toBe('currentColor'); // flips with light/dark
    expect(style['mask-image']).toBe(style['-webkit-mask-image']); // both prefixes set
  });
});

describe('blockColorVar — precedence: stamp → live prefs → tag hash (0069)', () => {
  it('prefers the stamped color_token — immutable, forward-only', () => {
    expect(blockColorVar({ color_token: 'chart-1', category_id: 'c1', tag: 'work' }, { c1: { color_token: 'tag-5' } }))
      .toBe('var(--chart-1)'); // stamp wins over both live prefs and tag
  });
  it('falls back to live category prefs when there is no stamp', () => {
    expect(blockColorVar({ category_id: 'c1', tag: 'work' }, { c1: { color_token: 'tag-5' } })).toBe('var(--tag-5)');
  });
  it('falls back to the tag hash when there is no stamp or category pref', () => {
    expect(blockColorVar({ tag: 'work' })).toBe(tagColorVar('work'));
    expect(blockColorVar({ category_id: 'c1', tag: 'work' })).toBe(tagColorVar('work')); // category w/o a pref row
  });
  it('handles a bare block (no stamp/category/tag) via the tag hash', () => {
    expect(blockColorVar({})).toBe(tagColorVar(undefined));
  });
});
