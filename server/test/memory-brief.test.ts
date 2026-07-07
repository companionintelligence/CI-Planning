import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { memoryBriefExcerpt, summarizeDay } from '../src/agents/summarize.js';
import { addDays } from '../src/lib/dates.js';
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
    // Built for TODAY's date → the day-aware prefix is "Today:".
    expect(excerpt).toMatch(/^Today: /);
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

/**
 * Review-fix coverage (PR #298): the day-aware prefix (EOD passes tomorrow's date, so
 * its events must read "Tomorrow:") and the eventParticipants hardening (blank-id guard
 * + dedupe). Uses a controlled fixture dir via CP_MEMORY_FIXTURES_DIR so the assertions
 * are deterministic regardless of wall-clock time. An event at now+30h always lands
 * inside BOTH today's and tomorrow's [start, start+48h] window (tomorrow-start is 0–24h
 * from now; now+30h is then 6–30h past it — always ≥ start and ≤ start+48h).
 */
describe('AA2 — day-aware prefix + participant hardening (custom fixture)', () => {
  let dir: string;
  const created: string[] = [];
  const SAVED_FX = process.env.CP_MEMORY_FIXTURES_DIR;

  /** Write a graph.json into the temp dir and point the connector at it. */
  function writeFixture(graph: unknown) {
    writeFileSync(join(dir, 'graph.json'), JSON.stringify(graph), 'utf8');
  }

  beforeEach(() => {
    resetDb();
    delete process.env.CI_SERVER_URL;
    delete process.env.CI_SERVER_API_KEY;
    delete process.env.MEMORY_MODE; // fixture transport
    dir = mkdtempSync(join(tmpdir(), 'aa2-fx-'));
    created.push(dir);
    process.env.CP_MEMORY_FIXTURES_DIR = dir;
    enablePull();
    connectViaEnv();
  });

  afterAll(() => {
    if (SAVED_FX === undefined) delete process.env.CP_MEMORY_FIXTURES_DIR;
    else process.env.CP_MEMORY_FIXTURES_DIR = SAVED_FX;
    for (const d of created) rmSync(d, { recursive: true, force: true });
  });

  it('labels tomorrow\'s events "Tomorrow:" (EOD path) and today\'s "Today:"', async () => {
    writeFixture({
      nodes: [
        {
          entity_id: 'evt-1',
          entity_type: 'event',
          name: 'Dinner with Maya',
          description: 'Catch-up',
          properties: { start_time: 'now+30h', end_time: 'now+32h' },
        },
      ],
      links: [],
    });

    const todayExcerpt = await memoryBriefExcerpt(OWNER, TODAY);
    expect(todayExcerpt).toMatch(/^Today: Dinner with Maya /);

    // The EOD Alignment builds the excerpt for TOMORROW's date — must NOT say "Today".
    const tomorrowExcerpt = await memoryBriefExcerpt(OWNER, addDays(TODAY, 1));
    expect(tomorrowExcerpt).toMatch(/^Tomorrow: Dinner with Maya /);
    expect(tomorrowExcerpt).not.toMatch(/^Today:/);
  });

  it('uses a short weekday/date label for a day that is neither today nor tomorrow', async () => {
    // Anchor an event two days out, and read the excerpt for that same day (+2). The
    // window for date=+2 is [+2 start, +2 start+48h]; an event at +2 start + a few hours
    // sits inside it. Use now+54h (≈ +2 days plus up to 6h) to stay clear of the boundary.
    writeFixture({
      nodes: [
        {
          entity_id: 'evt-2',
          entity_type: 'event',
          name: 'Team offsite',
          description: null,
          properties: { start_time: 'now+54h', end_time: 'now+56h' },
        },
      ],
      links: [],
    });
    const excerpt = await memoryBriefExcerpt(OWNER, addDays(TODAY, 2));
    // Neither "Today:" nor "Tomorrow:" — a "Wkd, Mon D:" style label instead.
    expect(excerpt).not.toBe('');
    expect(excerpt).not.toMatch(/^Today:/);
    expect(excerpt).not.toMatch(/^Tomorrow:/);
    expect(excerpt).toMatch(/^[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}: Team offsite /);
  });

  it('dedupes repeated participant links and never matches a blank id', async () => {
    writeFixture({
      nodes: [
        {
          entity_id: 'evt-3',
          entity_type: 'event',
          name: 'Planning sync',
          description: null,
          properties: { start_time: 'now+30h', end_time: 'now+31h' },
        },
        { entity_id: 'p-1', entity_type: 'person', name: 'Maya Lindqvist', properties: {} },
        // A person node with a MISSING id → connector maps it to '' (mapNode). A link
        // to it must not spuriously match the event's blank-guarded walk.
        { entity_type: 'person', name: 'Ghost Person', properties: {} },
      ],
      links: [
        // Two links to the SAME person — the name must appear once, not twice.
        { relationship_id: 'l-1', source: 'evt-3', target: 'p-1', relationship_type: 'participant' },
        { relationship_id: 'l-2', source: 'evt-3', target: 'p-1', relationship_type: 'organizer' },
        // A link whose other endpoint is the blank-id ghost node.
        { relationship_id: 'l-3', source: 'evt-3', target: '', relationship_type: 'participant' },
      ],
    });

    const excerpt = await memoryBriefExcerpt(OWNER, TODAY);
    expect(excerpt).toMatch(/^Today: Planning sync with Maya Lindqvist /);
    // Deduped: exactly one occurrence of the name.
    expect(excerpt.match(/Maya Lindqvist/g)).toHaveLength(1);
    // The blank-id ghost never leaks in.
    expect(excerpt).not.toContain('Ghost Person');
  });
});
