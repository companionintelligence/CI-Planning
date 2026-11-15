import { describe, it, expect } from 'vitest';
import { clearedSince, createClearedMemory, type StorageLike } from './learning-cleared.js';

/**
 * The memory of clears: what keeps the Learning tab honest after an owner clears, leaves the
 * tab and comes back. Pure, so it runs with an injected storage and no browser.
 */

function fakeStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

const throwing = (): StorageLike => ({
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
});

describe('createClearedMemory', () => {
  it('starts empty', () => {
    expect(createClearedMemory(() => fakeStorage()).recall()).toEqual({});
  });

  it('remembers a clear per loop, and a later clear of the same loop replaces it', () => {
    const s = fakeStorage();
    const m = createClearedMemory(() => s);
    m.remember('dismissal', '2026-10-28');
    m.remember('placement', '2026-10-29');
    expect(m.recall()).toEqual({ dismissal: '2026-10-28', placement: '2026-10-29' });
    m.remember('dismissal', '2026-11-02');
    expect(m.recall().dismissal).toBe('2026-11-02');
    expect(m.recall().placement).toBe('2026-10-29');
  });

  it('survives a new instance over the same storage (a tab switch is not a reload, but a reload within the session is)', () => {
    const s = fakeStorage();
    createClearedMemory(() => s).remember('classification', '2026-10-28');
    expect(createClearedMemory(() => s).recall()).toEqual({ classification: '2026-10-28' });
  });

  it('is tied to the account that looked: another owner sees none of it, and the first owner still does', () => {
    const s = fakeStorage();
    const m = createClearedMemory(() => s);
    m.bind('owner-a');
    m.remember('dismissal', '2026-10-28');
    m.bind('owner-b');
    expect(m.recall()).toEqual({});
    // The store holds one account's record at a time, so B's clear replaces A's. The tab
    // shows only the account that is looking, never a mix.
    m.remember('placement', '2026-10-30');
    expect(m.recall()).toEqual({ placement: '2026-10-30' });
    m.bind('owner-a');
    expect(m.recall()).toEqual({});
  });

  it('ignores a date that cannot be read, and drops hand-edited junk on the way out', () => {
    const s = fakeStorage();
    const m = createClearedMemory(() => s);
    m.remember('dismissal', 'yesterday');
    m.remember('dismissal', '2026-02-31');
    expect(m.recall()).toEqual({});
    s.data.set(
      'planning.learning.cleared.v1',
      JSON.stringify({ owner: '', loops: { dismissal: 'soon', placement: '2026-10-28', other: '2026-10-28', classification: 7 } }),
    );
    expect(m.recall()).toEqual({ placement: '2026-10-28' });
  });

  it('survives corrupt stored text', () => {
    const s = fakeStorage();
    s.data.set('planning.learning.cleared.v1', '{not json');
    const m = createClearedMemory(() => s);
    expect(m.recall()).toEqual({});
    m.remember('dismissal', '2026-10-28');
    expect(m.recall()).toEqual({ dismissal: '2026-10-28' });
  });

  it('still works for the rest of the page when storage is missing or throws', () => {
    for (const make of [() => null, () => throwing()]) {
      const m = createClearedMemory(make);
      expect(m.recall()).toEqual({});
      m.remember('placement', '2026-10-28');
      expect(m.recall()).toEqual({ placement: '2026-10-28' });
    }
  });

  it('does not throw when the storage accessor itself throws', () => {
    const m = createClearedMemory(() => {
      throw new Error('SecurityError');
    });
    expect(() => m.remember('dismissal', '2026-10-28')).not.toThrow();
    expect(m.recall()).toEqual({ dismissal: '2026-10-28' });
  });

  it('forget drops everything', () => {
    const m = createClearedMemory(() => fakeStorage());
    m.remember('dismissal', '2026-10-28');
    m.forget();
    expect(m.recall()).toEqual({});
  });

  it('hands back a copy, so a caller cannot edit the memory by editing what it was given', () => {
    const m = createClearedMemory(() => fakeStorage());
    m.remember('dismissal', '2026-10-28');
    const got = m.recall();
    got.dismissal = '2030-01-01';
    expect(m.recall().dismissal).toBe('2026-10-28');
  });
});

describe('createClearedMemory: a refused clear', () => {
  it('starts not refused', () => {
    expect(createClearedMemory(() => fakeStorage()).isForbidden()).toBe(false);
  });

  it('remembers a refusal, and a new instance over the same storage still knows (a reload within the session)', () => {
    const s = fakeStorage();
    createClearedMemory(() => s).markForbidden();
    expect(createClearedMemory(() => s).isForbidden()).toBe(true);
  });

  it('is tied to the account that was refused: another owner is not affected, and the first still is', () => {
    const s = fakeStorage();
    const m = createClearedMemory(() => s);
    m.bind('owner-a');
    m.markForbidden();
    expect(m.isForbidden()).toBe(true);
    m.bind('owner-b');
    expect(m.isForbidden()).toBe(false);
    m.bind('owner-a');
    expect(m.isForbidden()).toBe(true);
  });

  it('a refusal does not erase the remembered clears, and a clear does not erase the refusal', () => {
    const m = createClearedMemory(() => fakeStorage());
    m.remember('dismissal', '2026-10-28');
    m.markForbidden();
    expect(m.recall()).toEqual({ dismissal: '2026-10-28' });
    expect(m.isForbidden()).toBe(true);
    m.remember('placement', '2026-10-29');
    expect(m.isForbidden()).toBe(true);
    expect(m.recall()).toEqual({ dismissal: '2026-10-28', placement: '2026-10-29' });
  });

  it('a different owner remembering a clear starts from a clean record, not the first owner\'s refusal', () => {
    const m = createClearedMemory(() => fakeStorage());
    m.bind('owner-a');
    m.markForbidden();
    m.bind('owner-b');
    m.remember('dismissal', '2026-10-28');
    expect(m.isForbidden()).toBe(false);
  });

  it('is written to the storage, not only kept in the page', () => {
    const s = fakeStorage();
    createClearedMemory(() => s).markForbidden();
    expect(JSON.parse(s.data.get('planning.learning.cleared.v1')!)).toEqual({ owner: '', loops: {}, forbidden: true });
  });

  it('only a real true counts: hand-edited junk and the older record shape mean not refused', () => {
    for (const forbidden of ['yes', 1, null, {}]) {
      const s = fakeStorage();
      s.data.set('planning.learning.cleared.v1', JSON.stringify({ owner: '', loops: {}, forbidden }));
      expect(createClearedMemory(() => s).isForbidden()).toBe(false);
    }
    const old = fakeStorage();
    old.data.set('planning.learning.cleared.v1', JSON.stringify({ owner: '', loops: { dismissal: '2026-10-28' } }));
    const m = createClearedMemory(() => old);
    expect(m.isForbidden()).toBe(false);
    expect(m.recall()).toEqual({ dismissal: '2026-10-28' });
  });

  it('still works for the rest of the page when storage is missing or throws', () => {
    for (const make of [() => null, () => throwing()]) {
      const m = createClearedMemory(make);
      m.markForbidden();
      expect(m.isForbidden()).toBe(true);
    }
  });

  it('forget drops it too', () => {
    const m = createClearedMemory(() => fakeStorage());
    m.markForbidden();
    m.forget();
    expect(m.isForbidden()).toBe(false);
  });
});

describe('clearedSince', () => {
  it('is true for a clear after the reading, and on the same day (the pass runs early on Monday)', () => {
    expect(clearedSince('2026-10-28', '2026-10-26')).toBe(true);
    expect(clearedSince('2026-10-26', '2026-10-26')).toBe(true);
  });

  it('is false for a clear before the reading: the reading already reflects it', () => {
    expect(clearedSince('2026-10-25', '2026-10-26')).toBe(false);
  });

  it('is false when there was no clear, or either date cannot be read', () => {
    expect(clearedSince(undefined, '2026-10-26')).toBe(false);
    expect(clearedSince('', '2026-10-26')).toBe(false);
    expect(clearedSince('soon', '2026-10-26')).toBe(false);
    expect(clearedSince('2026-10-28', 'not-a-date')).toBe(false);
  });

  it('compares calendar days across the 2026-11-01 DST change', () => {
    expect(clearedSince('2026-11-02', '2026-10-26')).toBe(true);
    expect(clearedSince('2026-10-31', '2026-11-01')).toBe(false);
  });
});
