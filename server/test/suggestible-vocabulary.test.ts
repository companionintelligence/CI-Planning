import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { suggestibleVocabulary } from '../src/services/tags.js';
import { tagUntaggedTasks } from '../src/services/auto-tag.js';
import { startTestServer, resetDb, api, type TestServer } from './helpers.js';

const OWNER = SYSTEM_OWNER;

function seedTag(name: string, kind = 'intention', muted = 0): string {
  sqlite
    .prepare(`INSERT OR IGNORE INTO tags (id, name, owner_id, kind, muted) VALUES (uuid7(), ?, ?, ?, ?)`)
    .run(name, OWNER, kind, muted);
  return (sqlite.prepare(`SELECT id FROM tags WHERE name = ? AND owner_id = ?`).get(name, OWNER) as { id: string }).id;
}
function insertTask(title: string): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority)
         VALUES (uuid7(), ?, ?, 'open', 30, 3) RETURNING id`,
      )
      .get(title, OWNER) as { id: string }
  ).id;
}
const tagNamesOn = (taskId: string) =>
  (sqlite
    .prepare(
      `SELECT g.name FROM entity_tags e JOIN tags g ON g.id = e.tag_id
        WHERE e.entity_kind = 'task' AND e.entity_id = ?`,
    )
    .all(taskId) as { name: string }[]).map((r) => r.name);

/**
 * ONE definition of "tags we may propose". Before this, the nightly sweep honoured
 * `muted` while quick-add, /suggest-tags and the wizard's ranking did not — so muting a
 * tag meant different things depending on which surface you were standing on.
 */
describe('suggestibleVocabulary', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  it('splits by axis', async () => {
    seedTag('work', 'direction');
    seedTag('health', 'category');
    seedTag('email');
    const v = await suggestibleVocabulary(OWNER);
    expect(v.directions).toContain('work');
    expect(v.categories).toContain('health');
    expect(v.others).toContain('email');
    // Axes never bleed: a category must not surface as an intention (and vice versa).
    expect(v.others).not.toContain('health');
    expect(v.others).not.toContain('work');
  });

  it('excludes muted tags on EVERY axis', async () => {
    seedTag('work', 'direction');
    seedTag('home', 'direction', 1);
    seedTag('health', 'category');
    seedTag('finance', 'category', 1);
    seedTag('email');
    seedTag('errands', 'intention', 1);

    const v = await suggestibleVocabulary(OWNER);
    expect(v.directions).toEqual(['work']);
    expect(v.categories).toEqual(['health']);
    expect(v.others).toEqual(['email']);
  });

  it('returns empty lists for an owner with no tags', async () => {
    expect(await suggestibleVocabulary(OWNER)).toEqual({ directions: [], categories: [], others: [] });
  });
});

describe('muted tags are never suggested — per surface', () => {
  let srv: TestServer;
  beforeAll(async () => { srv = await startTestServer(); });
  afterAll(() => srv.close());
  beforeEach(() => resetDb());

  // Ollama is unavailable in tests, so the deterministic heuristic supplies the tags —
  // which is exactly the path that would otherwise re-introduce a muted name.
  it('the Auto-tag sweep will not apply a muted tag', async () => {
    seedTag('email', 'intention', 1); // muted
    const t = insertTask('Send email to Rek');
    const r = await tagUntaggedTasks(OWNER);
    expect(r.tagged).toBe(0);
    expect(tagNamesOn(t)).toEqual([]);
  });

  it('the sweep still applies an UNMUTED tag (the control)', async () => {
    seedTag('email');
    const t = insertTask('Send email to Rek');
    await tagUntaggedTasks(OWNER);
    expect(tagNamesOn(t)).toContain('email');
  });

  it('POST /api/tasks/suggest-tags offers neither muted tags nor categories', async () => {
    seedTag('work', 'direction');
    seedTag('email', 'intention', 1);   // muted
    seedTag('health', 'category');      // wrong axis for entity_tags
    // With Ollama down the endpoint answers []; the contract under test is that the
    // vocabulary HANDED to the model excludes both, so nothing muted can come back.
    const { status, body } = await api(srv.url, '/api/tasks/suggest-tags', {
      method: 'POST', json: { title: 'Email about health at work' },
    });
    expect(status).toBe(200);
    expect(body.tags).not.toContain('email');
    expect(body.tags).not.toContain('health');
  });

  it('quick-add parse never returns a muted tag', async () => {
    seedTag('work', 'direction');
    seedTag('email', 'intention', 1); // muted
    const { status, body } = await api(srv.url, '/api/tasks/quick/parse', {
      method: 'POST', json: { text: 'send the email' },
    });
    expect(status).toBe(200);
    expect(body.parsed.tags).not.toContain('email');
  });

  // Muting is not deletion: an explicitly named #tag still applies. The parser reads
  // `#muted-name` straight from the text and never consults the suggestion vocabulary.
  it('an explicitly typed #tag still applies even when muted', async () => {
    seedTag('email', 'intention', 1);
    const { body } = await api(srv.url, '/api/tasks/quick/parse', {
      method: 'POST', json: { text: 'ping Rek #email' },
    });
    expect(body.parsed.tags).toContain('email');
  });
});
