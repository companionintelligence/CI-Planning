import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTextSize, TEXT_SIZE_KEY, textSize } from './text-size.js';

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, String(value)); },
    removeItem: (key) => { values.delete(key); },
    clear: () => values.clear(),
  } as Storage;
}

describe('device text-size preference', () => {
  const dataset: Record<string, string> = {};

  beforeEach(() => {
    dataset.textSize = 'default';
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('document', { documentElement: { dataset } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['large', 'larger'] as const)('applies and persists %s', (size) => {
    setTextSize(size);
    expect(textSize()).toBe(size);
    expect(dataset.textSize).toBe(size);
    expect(localStorage.getItem(TEXT_SIZE_KEY)).toBe(size);
  });

  it('restores default and removes the saved override', () => {
    setTextSize('larger');
    setTextSize('default');
    expect(textSize()).toBe('default');
    expect(dataset.textSize).toBe('default');
    expect(localStorage.getItem(TEXT_SIZE_KEY)).toBeNull();
  });
});
