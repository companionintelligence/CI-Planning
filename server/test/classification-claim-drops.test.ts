import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { logger } from '../src/lib/logger.js';
import { startTestServer, resetDb, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';

/**
 * WHY the wizard's preview claim was dropped, asserted by reason.
 *
 * `classification-capture.test.ts` proves the outcome of a drop (the task is created, no row
 * is written). Several guards share that outcome: the `categories.length > 3` shape check and
 * the vocabulary check both refuse a list of four, and a title mismatch and an empty title
 * both leave the log empty. An outcome assertion cannot tell which guard fired, so a guard
 * could be deleted and the suite stay green. The only trace of the guard is the reason in the
 * debug line `settlePreviewClaim` writes, so this file spies on `logger.debug` and pins the
 * exact reason for each request. The spy is installed at any LOG_LEVEL; it does not need the
 * level the real line needs to print.
 */

const OWNER = SYSTEM_OWNER;
const TITLE = 'Gym session before work';
const DROPPED = 'classification-learning: preview claim dropped';

type Reason = 'shape' | 'no-categories-sent' | 'title' | 'vocabulary' | 'not-saved';

const spyDebug = () => vi.spyOn(logger, 'debug').mockImplementation(() => undefined as never);
let debug: ReturnType<typeof spyDebug>;

/** The `meta` of every drop line so far; other debug lines from the server are not ours. */
const dropped = () => debug.mock.calls.filter(([msg]) => msg === DROPPED).map(([, meta]) => meta);

function categoryTag(name: string, owner: string = OWNER): string {
  const found = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`)
    .get(owner, name) as { id: string } | undefined;
  if (found) return found.id;
  return (sqlite.prepare(`INSERT INTO tags (id, name, owner_id, kind) VALUES (uuid7(), ?, ?, 'category') RETURNING id`)
    .get(name, owner) as { id: string }).id;
}

function insertTask(title: string): string {
  return (sqlite
    .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority) VALUES (uuid7(), ?, ?, 'open', 3) RETURNING id`)
    .get(title, OWNER) as { id: string }).id;
}

const rows = () =>
  sqlite.prepare(`SELECT * FROM classification_log WHERE owner_id = ?`).all(OWNER) as { field: string }[];
const claim = (categories: unknown = ['leisure'], text: unknown = TITLE) => ({ text, categories });
const create = (extra: Record<string, unknown>) =>
  api(srv.url, '/api/tasks', { method: 'POST', json: { title: TITLE, ...extra } });

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => {
  await srv.close();
  // Leave no tags, owner or log rows behind for a file that does not reset the database itself.
  resetDb();
  sqlite.exec('DELETE FROM classification_log;');
});
beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM classification_log; DELETE FROM classification_exemplars; DELETE FROM classification_accuracy;');
  // Four real, unmuted names, so a list of four is refused for its length and not its content.
  for (const name of ['health', 'leisure', 'career', 'growth']) categoryTag(name);
  categoryTag('archived');
  sqlite.prepare(`UPDATE tags SET muted = 1 WHERE owner_id = ? AND name = 'archived'`).run(OWNER);
  createOwner(SECOND_OWNER_ID);
  categoryTag('secret', SECOND_OWNER_ID);
  debug = spyDebug();
});
afterEach(() => { debug.mockRestore(); });

describe('a dropped preview claim says why', () => {
  // What the Add itself sends: a real category, so only the claim can be what is wrong.
  const SENT = ['health'];
  /** One representative request per row: the body that goes with the claim, and the one reason it must give. */
  const cases: { reason: Reason; what: string; extra: Record<string, unknown>; title?: string }[] = [
    // The claim is not the shape the route reads.
    { reason: 'shape', what: 'not an object', extra: { categories: SENT, classification_claim: 'leisure' } },
    { reason: 'shape', what: 'null', extra: { categories: SENT, classification_claim: null } },
    { reason: 'shape', what: 'an array', extra: { categories: SENT, classification_claim: ['leisure'] } },
    { reason: 'shape', what: 'without text', extra: { categories: SENT, classification_claim: { categories: ['leisure'] } } },
    { reason: 'shape', what: 'with an empty text', extra: { categories: SENT, classification_claim: claim(['leisure'], '') } },
    { reason: 'shape', what: 'whose categories are not a list', extra: { categories: SENT, classification_claim: claim('leisure') } },
    { reason: 'shape', what: 'whose list is empty', extra: { categories: SENT, classification_claim: claim([]) } },
    { reason: 'shape', what: 'whose name is not a string', extra: { categories: SENT, classification_claim: claim(['leisure', 5]) } },
    // Four names that are all real and unmuted: only the length check refuses these as 'shape';
    // without it they would be dropped for 'vocabulary' (the cap at three makes the counts differ).
    { reason: 'shape', what: 'with four names, each real', extra: { categories: SENT, classification_claim: claim(['leisure', 'health', 'career', 'growth']) } },
    // Ten thousand copies of one real name: 'vocabulary' would drop these too (they dedupe to one).
    { reason: 'shape', what: 'with a hostile number of names', extra: { categories: SENT, classification_claim: claim(new Array(10_000).fill('leisure')) } },
    {
      reason: 'shape', what: 'about a text over 500 characters, even for a title that long',
      extra: { categories: SENT, classification_claim: claim(['leisure'], 'a'.repeat(501)) }, title: 'a'.repeat(501),
    },

    // A list is the owner's answer; its absence is not.
    { reason: 'no-categories-sent', what: 'the Add sent no categories', extra: { classification_claim: claim() } },

    // The claim is about other text than the task's title.
    { reason: 'title', what: 'another text', extra: { categories: SENT, classification_claim: claim(['leisure'], 'Water the plants') } },
    { reason: 'title', what: 'the title in another case', extra: { categories: SENT, classification_claim: claim(['leisure'], 'gym session before work') } },
    { reason: 'title', what: 'the title with another spacing', extra: { categories: SENT, classification_claim: claim(['leisure'], 'Gym  session before work') } },

    // A name the model could not have been offered. All or nothing.
    { reason: 'vocabulary', what: 'an unknown name', extra: { categories: SENT, classification_claim: claim(['nonexistent']) } },
    { reason: 'vocabulary', what: 'an unknown name beside a real one', extra: { categories: SENT, classification_claim: claim(['leisure', 'nonexistent']) } },
    { reason: 'vocabulary', what: 'a muted name', extra: { categories: SENT, classification_claim: claim(['archived']) } },
    { reason: 'vocabulary', what: 'another owner’s name', extra: { categories: SENT, classification_claim: claim(['secret']) } },
    { reason: 'vocabulary', what: 'a duplicate', extra: { categories: SENT, classification_claim: claim(['leisure', 'leisure']) } },

    // Names were sent and none landed, so there is no answer to record.
    { reason: 'not-saved', what: 'none of the sent names exist', extra: { categories: ['nonexistent'], classification_claim: claim() } },
  ];

  for (const c of cases) {
    it(`${c.reason}: ${c.what}`, async () => {
      const res = await create({ ...(c.title ? { title: c.title } : {}), ...c.extra });
      // The create is what it would have been without the claim, and nothing was recorded.
      expect(res.status).toBe(201);
      expect(rows()).toHaveLength(0);
      // The exact reason, once, and nothing but the reason in the line's meta.
      expect(dropped()).toEqual([{ reason: c.reason }]);
    });
  }

  it('covers every reason the route can give', () => {
    const given = new Set(cases.map((c) => c.reason));
    expect([...given].sort()).toEqual(['no-categories-sent', 'not-saved', 'shape', 'title', 'vocabulary']);
  });
});

describe('the drop line is not noise', () => {
  it('is not written for a claim that is recorded', async () => {
    const res = await create({ categories: ['health'], classification_claim: claim() });
    expect(res.status).toBe(201);
    expect(rows()).toHaveLength(1);
    expect(dropped()).toEqual([]);
  });

  it('is not written when there is no claim at all', async () => {
    const res = await create({ categories: ['health'] });
    expect(res.status).toBe(201);
    expect(rows()).toHaveLength(0);
    expect(dropped()).toEqual([]);
  });

  it('is not written for the claim of a create that failed, which was never looked at', async () => {
    // The claim would be dropped for 'title' if the route ever read it, so a drop line here
    // means it was read before the create succeeded. That includes the empty title, which
    // the 'title' guard would refuse by itself and the log could not otherwise tell apart.
    const mismatched = claim(['leisure'], 'Water the plants');
    const withClaim = { categories: ['health'], classification_claim: mismatched };
    expect((await create({ ...withClaim, title: '' })).status).toBe(400);
    expect((await create({ ...withClaim, motivation: 'everyone' })).status).toBe(422);
    expect((await create({ ...withClaim, recurrence_rule: 'NOT A RULE' })).status).toBe(422);
    expect(rows()).toHaveLength(0);
    expect(dropped()).toEqual([]);
  });

  it('is not written for a create that fails on a dependency cycle, after its row was written', async () => {
    // The 409 comes AFTER the task row exists, which is when a careless settle would run.
    const blocker = insertTask('Blocker');
    sqlite.exec(
      `CREATE TRIGGER zz_claim_drops_cycle AFTER INSERT ON tasks WHEN NEW.title = 'Cycle me'
       BEGIN INSERT INTO task_dependencies (task_id, depends_on_id) VALUES ('${blocker}', NEW.id); END`,
    );
    try {
      const res = await create({
        title: 'Cycle me', depends_on: [blocker], categories: ['health'],
        classification_claim: claim(['leisure'], 'Water the plants'),
      });
      expect(res.status).toBe(409);
      expect(rows()).toHaveLength(0);
      expect(dropped()).toEqual([]);
    } finally {
      sqlite.exec(`DROP TRIGGER IF EXISTS zz_claim_drops_cycle`);
    }
  });
});
