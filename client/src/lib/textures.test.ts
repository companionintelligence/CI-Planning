import { describe, it, expect } from 'vitest';
import {
  textureSeed, textureStyle, motifFor, TEXTURE_OPACITY,
  stripeStyle, categoryStripeColors, elementTextureStyle,
} from './textures.js';

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

// ── Phase C: category stripes ────────────────────────────────────────────────

const TAGS = [
  { id: 'c-health', name: 'health', kind: 'category' },
  { id: 'c-fin', name: 'finance', kind: 'category' },
  { id: 'i-deep', name: 'deep', kind: 'intention' }, // same-name intention must NOT match
];
const PREFS = { 'c-health': { color_token: 'tag-1' }, 'c-fin': { color_token: 'tag-2' } };

describe('categoryStripeColors — name → colour var resolution', () => {
  it('maps category names to their pref tokens, order preserved, case-insensitive', () => {
    expect(categoryStripeColors(['Finance', 'health'], TAGS, PREFS)).toEqual(['var(--tag-2)', 'var(--tag-1)']);
  });
  it('drops unknown names and non-category kinds; empty inputs yield []', () => {
    expect(categoryStripeColors(['deep', 'nonsense'], TAGS, PREFS)).toEqual([]);
    expect(categoryStripeColors([], TAGS, PREFS)).toEqual([]);
    expect(categoryStripeColors(['health'], undefined, PREFS)).toEqual([]);
  });
});

describe('stripeStyle — even 1px/2px stripes of 1–3 colours', () => {
  it('one colour: a single 1px line per 3px period', () => {
    const s = stripeStyle(['var(--tag-1)'])!;
    expect(s['background-image']).toBe(
      'repeating-linear-gradient(45deg, var(--tag-1) 0px 1px, transparent 1px 3px)',
    );
  });
  it('two colours interleave line-by-line (even distribution, order = position)', () => {
    const s = stripeStyle(['var(--tag-2)', 'var(--tag-1)'])!;
    expect(s['background-image']).toBe(
      'repeating-linear-gradient(45deg, var(--tag-2) 0px 1px, transparent 1px 3px, var(--tag-1) 3px 4px, transparent 4px 6px)',
    );
  });
  it('empty input yields undefined (caller falls back to the motif)', () => {
    expect(stripeStyle([])).toBeUndefined();
  });
});

describe('elementTextureStyle — the one resolution rule', () => {
  const motif = { iconShape: 'square', seedTag: 'work' };

  it('texture_enabled=false suppresses everything, even with categories + a fallback', () => {
    expect(elementTextureStyle({ texture_enabled: false, categories: ['health'] }, TAGS, PREFS, motif)).toBeUndefined();
  });
  it('a colour override wins over categories', () => {
    const s = elementTextureStyle({ texture_color_token: 'tag-9', categories: ['health'] }, TAGS, PREFS, motif)!;
    expect(s['background-image']).toContain('var(--tag-9)');
    expect(s['background-image']).not.toContain('var(--tag-1)');
  });
  it('categories drive the stripes when no override', () => {
    const s = elementTextureStyle({ categories: ['health', 'finance'] }, TAGS, PREFS, motif)!;
    expect(s['background-image']).toContain('var(--tag-1)');
    expect(s['background-image']).toContain('var(--tag-2)');
  });
  it('no override/categories → the legacy motif fallback (mask-based)', () => {
    const s = elementTextureStyle({}, TAGS, PREFS, motif)!;
    expect(s['mask-image']).toBeDefined();
    expect(s['background-color']).toBe('currentColor');
  });
  it('nothing to derive and no fallback → undefined', () => {
    expect(elementTextureStyle({}, TAGS, PREFS)).toBeUndefined();
  });
});
