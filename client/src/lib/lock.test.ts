import { describe, it, expect } from 'vitest';
import { providerLabel, sourceLine, lockAffordance, lockActionLabel } from './lock.js';

/**
 * Phase 1 — the lock model's pure decisions. Decision 1: a synced calendar event
 * cannot be unlocked and shows its SOURCE where a native block shows a toggle.
 */

describe('providerLabel', () => {
  it('names the known providers', () => {
    expect(providerLabel('google')).toBe('Google');
    expect(providerLabel('caldav')).toBe('CalDAV');
  });

  it('title-cases an unknown provider rather than dropping it', () => {
    expect(providerLabel('fastmail')).toBe('Fastmail');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(providerLabel('  GOOGLE ')).toBe('Google');
  });

  it('falls back to a generic word when the provider is blank', () => {
    expect(providerLabel('')).toBe('calendar');
  });
});

describe('sourceLine', () => {
  it('names the provider and the account', () => {
    expect(sourceLine({ source_provider: 'google', source_account: 'work' }))
      .toBe('Synced from Google · work');
  });

  it('is null for a locally created block', () => {
    expect(sourceLine({ source_provider: null, source_account: null })).toBeNull();
  });

  it('keys on the ACCOUNT, not the provider — provider alone is stamped locally too', () => {
    // `source_kind`/`source_provider` are set on rows the owner created here, so a
    // provider-only row is not external and must not claim to be synced.
    expect(sourceLine({ source_provider: 'google', source_account: null })).toBeNull();
  });

  it('still renders when the account is known but the provider is not', () => {
    expect(sourceLine({ source_provider: null, source_account: 'work' }))
      .toBe('Synced from calendar · work');
  });
});

describe('lockAffordance', () => {
  it('a synced event gets its source, never a control', () => {
    expect(lockAffordance({ source_account: 'work' })).toBe('source');
  });

  it('anything created here gets the toggle', () => {
    expect(lockAffordance({ source_account: null })).toBe('toggle');
  });
});

describe('lockActionLabel', () => {
  it('words both directions, and says what the lock DOES', () => {
    expect(lockActionLabel(false).label).toBe('Lock');
    expect(lockActionLabel(false).title).toMatch(/reflow/i);
    expect(lockActionLabel(true).label).toBe('Unlock');
    expect(lockActionLabel(true).title).toMatch(/reflow/i);
  });
});
