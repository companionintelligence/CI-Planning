import { describe, it, expect } from 'vitest';
import { TRUST_OPTIONS, DEFAULT_TRUST, resolveTrustValue, blurbFor } from './trust.js';

describe('trust dial model', () => {
  it('offers exactly the three states in dial order', () => {
    expect(TRUST_OPTIONS.map((o) => o.value)).toEqual(['cautious', 'balanced', 'hands_off']);
    expect(TRUST_OPTIONS.map((o) => o.label)).toEqual(['Cautious', 'Balanced', 'Hands-off']);
  });

  it('defaults to balanced', () => {
    expect(DEFAULT_TRUST).toBe('balanced');
  });

  describe('resolveTrustValue', () => {
    it('passes through each valid state', () => {
      expect(resolveTrustValue('cautious')).toBe('cautious');
      expect(resolveTrustValue('balanced')).toBe('balanced');
      expect(resolveTrustValue('hands_off')).toBe('hands_off');
    });
    it('falls back to balanced for absent / unknown values', () => {
      expect(resolveTrustValue(undefined)).toBe('balanced');
      expect(resolveTrustValue(null)).toBe('balanced');
      // a stale legacy auto_mode value is not a trust mode → default
      expect(resolveTrustValue('schedule' as never)).toBe('balanced');
    });
  });

  it('blurbFor returns a non-empty description for each state, empty for unknown', () => {
    for (const o of TRUST_OPTIONS) expect(blurbFor(o.value).length).toBeGreaterThan(0);
    expect(blurbFor('nope' as never)).toBe('');
  });
});
