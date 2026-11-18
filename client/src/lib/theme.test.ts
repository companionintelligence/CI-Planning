import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('device colorway preference', () => {
  const dataset: Record<string, string> = {};

  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(dataset)) delete dataset[key];
    vi.stubGlobal('localStorage', storage());
    vi.stubGlobal('document', { documentElement: { dataset } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['calm', 'cool', 'collected', 'colorful', 'grounding', 'void'] as const)('applies and persists %s', async (value) => {
    const { colorway, setColorway } = await import('./theme.js');
    setColorway(value);
    expect(colorway()).toBe(value);
    expect(dataset.colorway).toBe(value);
    expect(localStorage.getItem('ci-planning-colorway')).toBe(value);
  });
});
