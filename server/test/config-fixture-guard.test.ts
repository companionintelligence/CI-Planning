import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Boot guards around GOOGLE_MODE (fresh config import per test via resetModules).
 *
 * The guard under test: NODE_ENV=production + GOOGLE_MODE=fixture refuses to boot
 * unless CP_ALLOW_FIXTURE=true — fixture mode ingests committed sample data as real
 * tasks, which must never happen to a production user by default.
 */
const KEYS = ['NODE_ENV', 'GOOGLE_MODE', 'MEMORY_MODE', 'CP_ALLOW_FIXTURE', 'AUTH_MODE'] as const;
const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.resetModules();
  for (const k of KEYS) SAVED[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
});

async function freshConfig() {
  const mod = await import('../src/lib/config.js');
  return mod.config;
}

describe('GOOGLE_MODE parsing + production fixture guard', () => {
  it('unset GOOGLE_MODE resolves to off', async () => {
    delete process.env.GOOGLE_MODE;
    expect((await freshConfig()).google.mode).toBe('off');
  });

  it('an unrecognized value resolves to off (fail closed)', async () => {
    process.env.GOOGLE_MODE = 'bananas';
    expect((await freshConfig()).google.mode).toBe('off');
  });

  it('production + fixture refuses to boot', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'standalone'; // clear the separate AUTH_MODE=test guard
    process.env.GOOGLE_MODE = 'fixture';
    delete process.env.CP_ALLOW_FIXTURE;
    await expect(freshConfig()).rejects.toThrowError(/GOOGLE_MODE=fixture is forbidden in production/);
  });

  it('production + fixture boots with the explicit CP_ALLOW_FIXTURE escape hatch', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'standalone';
    process.env.GOOGLE_MODE = 'fixture';
    process.env.CP_ALLOW_FIXTURE = 'true';
    expect((await freshConfig()).google.mode).toBe('fixture');
  });

  it('production with GOOGLE_MODE unset boots with the integration off', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'standalone';
    delete process.env.GOOGLE_MODE;
    expect((await freshConfig()).google.mode).toBe('off');
  });
});

describe('MEMORY_MODE production fixture guard (mirrors the Google one)', () => {
  it('production + fixture refuses to boot', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'standalone';
    delete process.env.GOOGLE_MODE; // isolate: only the memory guard should fire
    process.env.MEMORY_MODE = 'fixture';
    delete process.env.CP_ALLOW_FIXTURE;
    await expect(freshConfig()).rejects.toThrowError(/MEMORY_MODE=fixture is forbidden in production/);
  });

  it('production + fixture boots with the explicit CP_ALLOW_FIXTURE escape hatch', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'standalone';
    delete process.env.GOOGLE_MODE;
    process.env.MEMORY_MODE = 'fixture';
    process.env.CP_ALLOW_FIXTURE = 'true';
    await expect(freshConfig()).resolves.toBeDefined();
  });

  it('production with MEMORY_MODE unset boots (connector off)', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'standalone';
    delete process.env.GOOGLE_MODE;
    delete process.env.MEMORY_MODE;
    await expect(freshConfig()).resolves.toBeDefined();
  });
});
