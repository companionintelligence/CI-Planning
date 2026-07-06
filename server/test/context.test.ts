import { describe, it, expect } from 'vitest';
import { currentOwnerId, runWithOwner, SYSTEM_OWNER } from '../src/lib/context.js';

describe('owner request context', () => {
  it('returns SYSTEM_OWNER outside any bound context', () => {
    expect(currentOwnerId()).toBe(SYSTEM_OWNER);
  });

  it('binds the owner inside runWithOwner and restores it after', () => {
    const inside = runWithOwner(42, [], () => currentOwnerId());
    expect(inside).toBe(42);
    expect(currentOwnerId()).toBe(SYSTEM_OWNER);
  });

  it('propagates the owner across awaits', async () => {
    const seen = await runWithOwner(7, [], async () => {
      await Promise.resolve();
      return currentOwnerId();
    });
    expect(seen).toBe(7);
    expect(currentOwnerId()).toBe(SYSTEM_OWNER);
  });
});
