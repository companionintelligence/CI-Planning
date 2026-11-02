import { describe, it, expect } from 'vitest';
import { learningCanReset } from './learning-access.js';

/**
 * The one rule that decides whether the Learning tab offers its clear buttons. Settings has
 * no test file, so this is where a typo in the role string or an inverted condition is caught.
 */
describe('learningCanReset', () => {
  it('is null while the account is still loading, whatever it will turn out to be', () => {
    expect(learningCanReset(true, undefined)).toBeNull();
    expect(learningCanReset(true, { role: 'viewer' })).toBeNull();
    expect(learningCanReset(true, { role: 'operator' })).toBeNull();
    expect(learningCanReset(true, null)).toBeNull();
  });

  it('is false for a viewer, who can read but is refused every clear', () => {
    expect(learningCanReset(false, { role: 'viewer' })).toBe(false);
  });

  it.each(['operator', 'member'])('is true for %s', (role) => {
    expect(learningCanReset(false, { role })).toBe(true);
  });

  it('is true when there is no account: no sign-in, or /auth/me failed (the server still decides)', () => {
    expect(learningCanReset(false, null)).toBe(true);
    expect(learningCanReset(false, undefined)).toBe(true);
    expect(learningCanReset(false, {})).toBe(true);
    expect(learningCanReset(false, { role: null })).toBe(true);
  });

  it('matches the role exactly: a near miss is not a viewer', () => {
    expect(learningCanReset(false, { role: 'Viewer' })).toBe(true);
    expect(learningCanReset(false, { role: 'viewers' })).toBe(true);
  });
});
