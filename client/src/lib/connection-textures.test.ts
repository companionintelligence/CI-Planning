import { describe, it, expect } from 'vitest';
import { connectionTextureStyle, CONNECTION_TEXTURE_OPACITY } from './textures.js';

/**
 * 0145 — the per-connection stripe overlay. The geometry is an owner spec ("2px wide
 * lines", "15% less transparent" → 85% opaque), so it is asserted literally: these are
 * the numbers someone would otherwise "tidy up" without realising they were chosen.
 */
describe('connectionTextureStyle', () => {
  it('is inert for none / unset / unknown, so an unconfigured source looks untouched', () => {
    expect(connectionTextureStyle('none', 'var(--primary)')).toBeUndefined();
    expect(connectionTextureStyle(null, 'var(--primary)')).toBeUndefined();
    expect(connectionTextureStyle(undefined, 'var(--primary)')).toBeUndefined();
    expect(connectionTextureStyle('not-a-texture', 'var(--primary)')).toBeUndefined();
  });

  it('draws 2px lines on a 4px period (2px line + 2px gap)', () => {
    const s = connectionTextureStyle('diagonal', 'var(--chart-1)')!;
    expect(s['background-image']).toBe(
      'repeating-linear-gradient(45deg, var(--chart-1) 0 2px, transparent 2px 4px)',
    );
  });

  it('renders at 85% opacity — the owner asked for a bold source marker, not a whisper', () => {
    expect(CONNECTION_TEXTURE_OPACITY).toBe(0.85);
    expect(connectionTextureStyle('vertical', 'var(--primary)')!.opacity).toBe(0.85);
  });

  it('each named geometry picks a distinct angle', () => {
    const angleOf = (t: string) =>
      (connectionTextureStyle(t, 'var(--primary)')!['background-image'] as string).match(/\(([-\d]+)deg/)?.[1];
    expect(angleOf('diagonal')).toBe('45');
    expect(angleOf('reverse')).toBe('-45');
    expect(angleOf('vertical')).toBe('90');
    expect(angleOf('horizontal')).toBe('0');
  });

  it('grid layers two gradients so it reads as a cross-hatch', () => {
    const img = connectionTextureStyle('grid', 'var(--primary)')!['background-image'] as string;
    expect(img.match(/repeating-linear-gradient/g)).toHaveLength(2);
    expect(img).toContain('45deg');
    expect(img).toContain('-45deg');
  });

  it('overlays without a background-color of its own, so the chip fill shows through', () => {
    const s = connectionTextureStyle('diagonal', 'var(--primary)')!;
    expect(s.position).toBe('absolute');
    expect(s.inset).toBe('0');
    expect(s['pointer-events']).toBe('none');
    expect(s['background-color']).toBeUndefined();
  });
});
