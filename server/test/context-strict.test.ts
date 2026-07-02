import { describe, it, expect } from 'vitest';
import { runWithOwner, currentOwnerId, SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * T0: currentOwnerId() must fail loud outside a runWithOwner scope in a non-test
 * build — a missing wrapper is a cross-tenant bug, not a silent SYSTEM_OWNER
 * default. In test mode the SYSTEM_OWNER fallback is kept so the suite runs as the
 * single system owner. This file imports no DB, so it runs even where the native
 * driver can't load.
 */
describe('currentOwnerId — fail-loud outside a context', () => {
  it('returns the bound owner inside runWithOwner', () => {
    expect(runWithOwner('owner-x', () => currentOwnerId())).toBe('owner-x');
  });

  it('falls back to SYSTEM_OWNER outside a context in test mode', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      expect(currentOwnerId()).toBe(SYSTEM_OWNER);
    } finally {
      process.env.NODE_ENV = orig;
    }
  });

  it('throws outside a context in a non-test (production) build', () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => currentOwnerId()).toThrow(/runWithOwner/);
      // ...but still resolves cleanly when properly scoped, even in prod mode.
      expect(runWithOwner('owner-y', () => currentOwnerId())).toBe('owner-y');
    } finally {
      process.env.NODE_ENV = orig;
    }
  });
});
