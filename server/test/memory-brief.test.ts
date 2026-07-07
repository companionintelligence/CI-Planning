import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { memoryBriefExcerpt, summarizeDay } from '../src/agents/summarize.js';
import { resetDb } from './helpers.js';

/**
 * Phase AA · AA2 — memory-informed Daily Brief. Verifies the enrichment seam
 * (memoryBriefExcerpt + its fold-in through summarizeDay's fallback prose) under the
 * three contract states:
 *   - flag ON + fixture graph  → a memory-derived phrase appears in the brief;
 *   - flag OFF                 → byte-identical to pre-AA2 (no memory phrase);
 *   - connector unavailable / throws (live mode, dead port) → byte-identical, no throw.
 *
 * The suite forces the deterministic fallback path (Ollama is not asserted up): with
 * time_sense OFF, summarizeDay tries a direct Ollama generate and — when unavailable —
 * falls back to fallbackProse(date, g, memoryExcerpt), which is what these tests read.
 * The excerpt itself is asserted directly via memoryBriefExcerpt so the memory-derived
 * phrase is checked independent of whether Ollama happens to be running in CI.
 */

const OWNER = SYSTEM_OWNER;
const KEY_B64 = randomBytes(32).toString('base64');

// The fixture events resolve to now+20h / now+30h / now+90h, so the brief window must be
// TODAY's real calendar day for them to fall inside [day-start, day-start+48h].
const TODAY = new Date().toISOString().slice(0, 10);

const SAVED = {
  kek: process.env.CP_KEK_B64,
  url: process.env.CI_SERVER_URL,
  apiKey: process.env.CI_SERVER_API_KEY,
  mode: process.env.MEMORY_MODE,
};

beforeAll(() => {
  process.env.CP_KEK_B64 = KEY_B64;
});

afterAll(() => {
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('CP_KEK_B64', SAVED.kek);
  restore('CI_SERVER_URL', SAVED.url);
  restore('CI_SERVER_API_KEY', SAVED.apiKey);
  restore('MEMORY_MODE', SAVED.mode);
});

function enablePull() {
  sqlite.prepare(`UPDATE scheduling_prefs SET memory_pull_enabled = 1 WHERE owner_id = ?`).run(OWNER);
}

/** Connector availability comes from creds resolving — the env fallback is enough here
 *  (standalone auth mode in tests keeps the env fallback live). MEMORY_MODE stays the
 *  default 'fixture', so no network is touched. */
function connectViaEnv() {
  process.env.CI_SERVER_URL = 'http://ci.local:3000';
  process.env.CI_SERVER_API_KEY = 'test-key';
}

describe('AA2 — memoryBriefExcerpt', () => {
  beforeEach(() => {
    resetDb(); // pins memory_pull_enabled = 0, timezone = 'UTC', clears connection_tokens
    delete process.env.CI_SERVER_URL;
    delete process.env.CI_SERVER_API_KEY;
    delete process.env.MEMORY_MODE; // default fixture
  });

  it('returns a memory-derived event phrase when the flag is ON and the connector resolves', async () => {
    enablePull();
    connectViaEnv();
    const excerpt = await memoryBriefExcerpt(OWNER, TODAY);
    // The fixture graph has "Dinner with Maya" (now+30h) and "Quarterly planning review"
    // (now+20h) in the 48h window; the excerpt names at least one, with a clock time.
    expect(excerpt).not.toBe('');
    expect(excerpt).toMatch(/Dinner with Maya|Quarterly planning review/);
    expect(excerpt).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/); // a 12h clock time is rendered
    expect(excerpt.length).toBeLessThanOrEqual(200); // char budget respected
  });

  it('names the linked participant on the event line (Maya)', async () => {
    enablePull();
    connectViaEnv();
    const excerpt = await memoryBriefExcerpt(OWNER, TODAY);
    // "Dinner with Maya" links to person "Maya Lindqvist" → "with Maya Lindqvist".
    if (excerpt.includes('Dinner with Maya')) {
      expect(excerpt).toContain('Maya Lindqvist');
    }
  });

  it('returns "" when the pull flag is OFF (connector otherwise available)', async () => {
    connectViaEnv(); // creds resolve…
    // …but memory_pull_enabled stays 0 (resetDb default).
    expect(await memoryBriefExcerpt(OWNER, TODAY)).toBe('');
  });

  it('returns "" when the flag is ON but no connector creds resolve', async () => {
    enablePull();
    // No CI_SERVER_URL, no settings row → memoryConnectorAvailable is false.
    expect(await memoryBriefExcerpt(OWNER, TODAY)).toBe('');
  });

  it('returns "" (never throws) when the connector is in live mode against a dead port', async () => {
    enablePull();
    process.env.MEMORY_MODE = 'live';
    process.env.CI_SERVER_URL = 'http://127.0.0.1:9'; // discard port — nothing listens
    process.env.CI_SERVER_API_KEY = 'test-key';
    // graphData throws MemoryUnavailable; the helper swallows it and returns ''.
    await expect(memoryBriefExcerpt(OWNER, TODAY)).resolves.toBe('');
  });
});

describe('AA2 — brief fold-in / byte-identical discipline', () => {
  beforeEach(() => {
    resetDb();
    delete process.env.CI_SERVER_URL;
    delete process.env.CI_SERVER_API_KEY;
    delete process.env.MEMORY_MODE;
    // A single deterministic task so the fallback prose is stable and non-empty.
    sqlite
      .prepare(`INSERT INTO tasks (id, title, due_at, priority, owner_id, status) VALUES (uuid7(), ?, NULL, 3, ?, 'open')`)
      .run('Backlog task', OWNER);
  });

  it('flag OFF → the brief prose carries NO memory phrase (byte-identical shape)', async () => {
    connectViaEnv(); // creds resolve, but the flag is off
    const s = await summarizeDay(TODAY, { refresh: true });
    expect(s.prose).not.toMatch(/Dinner with Maya|Quarterly planning review|life context/);
    // The excerpt seam itself is empty, guaranteeing the prompt/prose match pre-AA2.
    expect(await memoryBriefExcerpt(OWNER, TODAY)).toBe('');
  });

  it('flag OFF: the excerpt seam is "" whether or not the connector is available', async () => {
    // The byte-identical guarantee rests on the excerpt being '' when the flag is off —
    // the facts/fallback handed to generation are then exactly pre-AA2. (Asserting the
    // excerpt, not the model prose, keeps this deterministic when Ollama is up.)
    expect(await memoryBriefExcerpt(OWNER, TODAY)).toBe(''); // off + no creds
    connectViaEnv();
    expect(await memoryBriefExcerpt(OWNER, TODAY)).toBe(''); // off + creds resolve
  });

  it('live-mode dead-port connector never breaks the brief (still produces prose)', async () => {
    enablePull();
    process.env.MEMORY_MODE = 'live';
    process.env.CI_SERVER_URL = 'http://127.0.0.1:9';
    process.env.CI_SERVER_API_KEY = 'test-key';
    const s = await summarizeDay(TODAY, { refresh: true });
    expect(s.prose.length).toBeGreaterThan(0);
    expect(s.prose).not.toMatch(/Dinner with Maya|Quarterly planning review/); // excerpt degraded to ''
  });

  it('flag ON + fixture connector: the fallback prose folds in a memory phrase', async () => {
    enablePull();
    connectViaEnv(); // fixture mode (default) — offline, deterministic
    const s = await summarizeDay(TODAY, { refresh: true });
    // The deterministic fallback appends the excerpt. When Ollama is up the model prose
    // may paraphrase it, so only assert the seam is non-empty and — in the fallback
    // shape (which starts with "Plan for") — that the phrase is present.
    const excerpt = await memoryBriefExcerpt(OWNER, TODAY);
    expect(excerpt).not.toBe('');
    if (s.prose.startsWith(`Plan for ${TODAY}:`)) {
      expect(s.prose).toContain(excerpt);
    }
  });
});
