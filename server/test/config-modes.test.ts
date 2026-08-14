import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// Statically imported so they keep the ORIGINAL module instances: both pull in
// db/store.js, and re-importing that under vi.resetModules() would open a second
// database. Neither needs a fresh config — memoryMode() delegates to a getter and
// no-arg loadKek() reads process.env directly, which is exactly what's under test.
import { memoryMode } from '../src/connectors/memory.js';
import { loadKek } from '../src/lib/crypto/index.js';

/**
 * The connector-mode / env-pin shape in lib/config.ts (llm-6).
 *
 * These tests exist to pin an ASYMMETRY that reads like a bug and is not:
 * `config.memory.mode` re-reads `MEMORY_MODE` on every access, while
 * `config.google.mode` is captured once at boot. Both are deliberate, for opposite
 * reasons — connectors/memory.ts resolves its transport per call, while
 * services/google-config.ts hot-applies an in-app mode by MUTATING the singleton,
 * which a getter would silently overwrite. Without this file, "tidying" one to match
 * the other looks like an improvement.
 */
const KEYS = [
  'NODE_ENV', 'GOOGLE_MODE', 'MEMORY_MODE', 'CP_ALLOW_FIXTURE', 'AUTH_MODE',
  'CI_SERVER_URL', 'CP_GOOGLE_CLIENT_ID', 'CP_KEK_B64',
  'OLLAMA_FAST', 'OLLAMA_SMALL', 'OLLAMA_QUALITY', 'OLLAMA_MEDIUM', 'OLLAMA_EMBED',
  'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY',
] as const;
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

/** A config built from the CURRENT env (fresh module per test via resetModules). */
async function freshConfig() {
  return (await import('../src/lib/config.js')).config;
}

describe('config.memory — the mode is re-read on every access', () => {
  it('observes a MEMORY_MODE flipped AFTER config was constructed', async () => {
    delete process.env.MEMORY_MODE;
    const cfg = await freshConfig();
    expect(cfg.memory.mode).toBe('off');

    process.env.MEMORY_MODE = 'fixture';
    expect(cfg.memory.mode).toBe('fixture'); // the whole point of the getter
    process.env.MEMORY_MODE = 'live';
    expect(cfg.memory.mode).toBe('live');
    delete process.env.MEMORY_MODE;
    expect(cfg.memory.mode).toBe('off');
  });

  it('memoryMode() delegates to it, so the connector sees the same flip', () => {
    delete process.env.MEMORY_MODE;
    expect(memoryMode()).toBe('off');
    process.env.MEMORY_MODE = 'fixture';
    expect(memoryMode()).toBe('fixture');
    process.env.MEMORY_MODE = 'live';
    expect(memoryMode()).toBe('live');
  });

  it('fails closed on an unrecognized value', async () => {
    process.env.MEMORY_MODE = 'bananas';
    expect((await freshConfig()).memory.mode).toBe('off');
  });

  it('serverUrl (CI_SERVER_URL) is re-read the same way', async () => {
    delete process.env.CI_SERVER_URL;
    const cfg = await freshConfig();
    expect(cfg.memory.serverUrl).toBeUndefined();
    process.env.CI_SERVER_URL = 'http://ci.local:3000';
    expect(cfg.memory.serverUrl).toBe('http://ci.local:3000');
  });
});

describe('config.google — boot-pinned by design (do NOT "fix" this to match memory)', () => {
  it('does NOT observe a GOOGLE_MODE flipped after construction', async () => {
    delete process.env.GOOGLE_MODE;
    const cfg = await freshConfig();
    expect(cfg.google.mode).toBe('off');
    expect(cfg.pins.google).toBe(false);

    process.env.GOOGLE_MODE = 'fixture';
    expect(cfg.google.mode).toBe('off'); // captured at boot — see the file header
    expect(cfg.pins.google).toBe(false);
  });

  it('an explicit env value pins the mode', async () => {
    process.env.GOOGLE_MODE = 'live';
    process.env.CP_GOOGLE_CLIENT_ID = 'client-id.apps.googleusercontent.com';
    const cfg = await freshConfig();
    expect(cfg.google.mode).toBe('live');
    expect(cfg.pins.google).toBe(true);
  });

  it('config.pins.google mirrors config.google.envPinned rather than copying it', async () => {
    delete process.env.GOOGLE_MODE;
    const cfg = await freshConfig();
    expect(cfg.pins.google).toBe(false);
    cfg.google.envPinned = true; // what services/google-config.ts's own tests do
    expect(cfg.pins.google).toBe(true);
  });
});

describe('the fixture-in-production guard (one helper, two verbatim messages)', () => {
  it('MEMORY_MODE=fixture + production + no CP_ALLOW_FIXTURE throws the exact message', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'standalone'; // clear the separate AUTH_MODE=test guard
    delete process.env.GOOGLE_MODE;
    process.env.MEMORY_MODE = 'fixture';
    delete process.env.CP_ALLOW_FIXTURE;
    await expect(freshConfig()).rejects.toThrowError(
      'MEMORY_MODE=fixture is forbidden in production — it serves committed sample memory data as real suggestions. ' +
        'Set MEMORY_MODE=live (with a CI-Server connection), unset it to disable the memory connector, ' +
        'or set CP_ALLOW_FIXTURE=true to explicitly allow fixtures (demo appliances only).',
    );
  });

  it('GOOGLE_MODE=fixture + production + no CP_ALLOW_FIXTURE throws the exact message', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTH_MODE = 'standalone';
    process.env.GOOGLE_MODE = 'fixture';
    delete process.env.MEMORY_MODE;
    delete process.env.CP_ALLOW_FIXTURE;
    await expect(freshConfig()).rejects.toThrowError(
      'GOOGLE_MODE=fixture is forbidden in production — it ingests committed sample data as real tasks. ' +
        'Set GOOGLE_MODE=live (with OAuth credentials), unset it to disable Google integration, ' +
        'or set CP_ALLOW_FIXTURE=true to explicitly allow fixtures (demo appliances only).',
    );
  });
});

describe('config.pins — one shape for every env pin', () => {
  it('OLLAMA_FAST set ⇒ pins.ollama.fast', async () => {
    process.env.OLLAMA_FAST = 'llama3.2:latest';
    delete process.env.OLLAMA_SMALL;
    delete process.env.OLLAMA_QUALITY;
    delete process.env.OLLAMA_MEDIUM;
    delete process.env.OLLAMA_EMBED;
    const cfg = await freshConfig();
    expect(cfg.pins.ollama).toEqual({ fast: true, quality: false, embed: false });
    expect(cfg.ollamaFastModel).toBe('llama3.2:latest');
  });

  it('the legacy OLLAMA_SMALL / OLLAMA_MEDIUM aliases still count as pins', async () => {
    delete process.env.OLLAMA_FAST;
    delete process.env.OLLAMA_QUALITY;
    delete process.env.OLLAMA_EMBED;
    process.env.OLLAMA_SMALL = 'small-legacy';
    process.env.OLLAMA_MEDIUM = 'medium-legacy';
    const cfg = await freshConfig();
    expect(cfg.pins.ollama).toEqual({ fast: true, quality: true, embed: false });
    expect(cfg.ollamaFastModel).toBe('small-legacy');
    expect(cfg.ollamaQualityModel).toBe('medium-legacy');
  });

  it('the new name wins over the alias when both are set', async () => {
    process.env.OLLAMA_FAST = 'new-name';
    process.env.OLLAMA_SMALL = 'old-name';
    expect((await freshConfig()).ollamaFastModel).toBe('new-name');
  });

  it('vapid pins only when BOTH halves of the keypair are set', async () => {
    process.env.VAPID_PUBLIC_KEY = 'pub';
    delete process.env.VAPID_PRIVATE_KEY;
    expect((await freshConfig()).pins.vapid).toBe(false);

    vi.resetModules();
    process.env.VAPID_PRIVATE_KEY = 'priv';
    expect((await freshConfig()).pins.vapid).toBe(true);
  });
});

describe('AuthConfig.kekB64 is gone — lib/crypto reads CP_KEK_B64 directly', () => {
  it('config.auth carries no KEK field, and the real consumer still resolves it', async () => {
    process.env.CP_KEK_B64 = Buffer.alloc(32, 5).toString('base64');
    const cfg = await freshConfig();
    expect('kekB64' in cfg.auth).toBe(false);
    expect((await loadKek()).byteLength).toBe(32);
  });
});
