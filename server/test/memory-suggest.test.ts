import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { localISODate } from '../src/lib/dates.js';
import { suggestFromMemory, MEMORY_PENDING_CAP } from '../src/agents/memory-suggest.js';
import { upsertPossible } from '../src/agents/ingest.js';
import { runScheduledJob } from '../src/jobs/index.js';
import { resetDb, startTestServer, api, createOwner, type TestServer } from './helpers.js';

/**
 * Phase AA · AA1 — memory suggestion agent. Fixture-mode graph (2 events inside the
 * 48h window, 1 outside) → staged possibles with source_kind='memory' and
 * source_ref='ci:<node-id>'. Covers gating (flag / availability), idempotent
 * re-runs, dismissed-is-terminal, the pending cap, polish degradation, the
 * scheduled-job registration, the manual trigger route, multi-owner isolation
 * (0114 owner-scoped dedup), and the promote → auto-schedule integration driven
 * entirely through the real routes (source + 30m estimate carried; hands-off
 * places a block with zero manual engine calls).
 */

const OWNER = SYSTEM_OWNER;
const run = <T,>(fn: () => T | Promise<T>) => runWithOwner(OWNER, ALL_SCOPES, fn);

const SAVED = {
  url: process.env.CI_SERVER_URL,
  apiKey: process.env.CI_SERVER_API_KEY,
  mode: process.env.MEMORY_MODE,
};

let srv: TestServer;

beforeAll(async () => {
  srv = await startTestServer();
});

afterAll(async () => {
  await srv.close();
  const restore = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  restore('CI_SERVER_URL', SAVED.url);
  restore('CI_SERVER_API_KEY', SAVED.apiKey);
  restore('MEMORY_MODE', SAVED.mode);
});

beforeEach(async () => {
  resetDb(); // pins memory_pull_enabled = 0
  delete process.env.MEMORY_MODE; // fixture
  process.env.CI_SERVER_URL = 'http://ci.local:3000'; // availability via env creds
  delete process.env.CI_SERVER_API_KEY;
  // Flag round-trip through the real API (Z-phase lesson: not raw SQL only).
  const r = await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_pull_enabled: true } });
  expect(r.status).toBe(200);
});

const memoryPossibles = (status?: string) =>
  sqlite
    .prepare(
      `SELECT id, source_ref, raw_title, status FROM possible_tasks
        WHERE proposed_owner_id = ? AND source_kind = 'memory' ${status ? `AND status = '${status}'` : ''}
        ORDER BY source_ref`,
    )
    .all(OWNER) as { id: string; source_ref: string; raw_title: string; status: string }[];

describe('gating', () => {
  it('flag off → skipped, zero writes', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_pull_enabled: false } });
    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.status).toBe('flag_off');
    expect(memoryPossibles()).toEqual([]);
  });

  it('no creds → unavailable, zero writes', async () => {
    delete process.env.CI_SERVER_URL;
    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.status).toBe('unavailable');
    expect(memoryPossibles()).toEqual([]);
  });

  it('live-mode transport failure degrades to unavailable (never throws)', async () => {
    process.env.MEMORY_MODE = 'live';
    process.env.CI_SERVER_URL = 'http://127.0.0.1:9';
    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.status).toBe('unavailable');
    expect(memoryPossibles()).toEqual([]);
  });
});

describe('staging from the fixture graph', () => {
  it('stages one possible per in-window event with source_kind=memory and ci:<id> refs', async () => {
    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.status).toBe('ran');
    expect(r.pulled).toBe(2); // the now+90h event is outside the 48h window
    expect(r.created).toBe(2);

    const rows = memoryPossibles('pending');
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.source_ref).toMatch(/^ci:[0-9a-f-]{36}$/);
    const titles = rows.map((x) => x.raw_title).sort();
    expect(titles).toEqual(['Prep for Dinner with Sam', 'Prep for Quarterly planning review']);

    // Participants ride the payload; the due date anchors to the event start; the
    // template's default 30m prep estimate persists (0114) so promote can carry it.
    const payloadRow = sqlite
      .prepare(`SELECT source_payload, proposed_due_at, proposed_estimated_minutes FROM possible_tasks WHERE raw_title = 'Prep for Dinner with Sam'`)
      .get() as { source_payload: string; proposed_due_at: string; proposed_estimated_minutes: number };
    expect(payloadRow.source_payload).toContain('Sam Rivera');
    expect(Date.parse(payloadRow.proposed_due_at)).toBeGreaterThan(Date.now());
    expect(payloadRow.proposed_estimated_minutes).toBe(30);
  });

  it('re-runs are idempotent on (source_kind, source_ref)', async () => {
    await run(() => suggestFromMemory({ polish: false }));
    const again = await run(() => suggestFromMemory({ polish: false }));
    expect(again.created).toBe(0);
    expect(again.updated).toBe(2);
    expect(memoryPossibles('pending').length).toBe(2);
  });

  it('a dismissed source_ref is terminal — never re-staged', async () => {
    await run(() => suggestFromMemory({ polish: false }));
    const [victim] = memoryPossibles('pending');
    const d = await api(srv.url, `/api/possible-tasks/${victim.id}/dismiss`, { method: 'POST' });
    expect(d.status).toBe(200);

    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.skippedDismissed).toBe(1);
    expect(r.created).toBe(0);
    const still = sqlite.prepare(`SELECT status FROM possible_tasks WHERE id = ?`).get(victim.id) as { status: string };
    expect(still.status).toBe('dismissed');
    expect(memoryPossibles('pending').length).toBe(1);
  });

  it('caps pending memory possibles per owner (updates still flow)', async () => {
    await run(() => {
      for (let i = 0; i < MEMORY_PENDING_CAP; i++) {
        upsertPossible(
          { title: `Filler ${i}`, priority: 3, tags: [], confidence: 0.5 },
          'memory',
          `ci:filler-${i}`,
          {},
        );
      }
    });
    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.created).toBe(0);
    expect(r.skippedCap).toBe(2);
    expect(memoryPossibles('pending').length).toBe(MEMORY_PENDING_CAP);

    // An UPDATE of an already-staged ref is not capped: dismiss one filler to free a
    // slot, stage one event, then re-run with the cap full again.
    const filler = memoryPossibles('pending')[0];
    sqlite.prepare(`DELETE FROM possible_tasks WHERE id = ?`).run(filler.id);
    const second = await run(() => suggestFromMemory({ polish: false }));
    expect(second.created).toBe(1);
    const third = await run(() => suggestFromMemory({ polish: false }));
    expect(third.updated).toBeGreaterThanOrEqual(1); // the staged event refreshes despite the full cap
  });

  it('polish failure degrades to templates (never blocks staging)', async () => {
    const r = await run(() =>
      suggestFromMemory({
        polish: async () => {
          throw new Error('boom — polish exploded');
        },
      }),
    );
    expect(r.status).toBe('ran');
    expect(r.created).toBe(2);
    expect(memoryPossibles('pending').map((x) => x.raw_title).sort()).toEqual([
      'Prep for Dinner with Sam',
      'Prep for Quarterly planning review',
    ]);
  });

  it('a working polish refines the drafts', async () => {
    const r = await run(() =>
      suggestFromMemory({
        polish: async (candidates) => new Map(candidates.map((c) => [c.node.id, { title: `Polished: ${c.node.name}` }])),
      }),
    );
    expect(r.created).toBe(2);
    expect(memoryPossibles('pending').every((x) => x.raw_title.startsWith('Polished: '))).toBe(true);
  });
});

describe('scheduled job (W12 infra)', () => {
  it('the migration seeded the memory_suggest job', () => {
    const row = sqlite
      .prepare(`SELECT kind, cron, enabled FROM scheduled_jobs WHERE kind = 'memory_suggest'`)
      .get() as { kind: string; cron: string; enabled: number };
    expect(row).toMatchObject({ kind: 'memory_suggest', cron: '0 */6 * * *', enabled: 1 });
  });

  it('runScheduledJob stages suggestions per owner and records a job run', async () => {
    await runScheduledJob('memory_suggest');
    expect(memoryPossibles('pending').length).toBe(2);
    const jr = sqlite
      .prepare(
        `SELECT jr.status, jr.items_created, jr.log FROM job_runs jr
           JOIN scheduled_jobs sj ON sj.id = jr.job_id
          WHERE sj.kind = 'memory_suggest' ORDER BY jr.started_at DESC LIMIT 1`,
      )
      .get() as { status: string; items_created: number; log: string };
    expect(jr.status).toBe('done');
    expect(jr.items_created).toBe(2);
  });

  it('flag off → the job is a logged no-op', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_pull_enabled: false } });
    await runScheduledJob('memory_suggest');
    expect(memoryPossibles()).toEqual([]);
    const jr = sqlite
      .prepare(
        `SELECT jr.status, jr.log FROM job_runs jr
           JOIN scheduled_jobs sj ON sj.id = jr.job_id
          WHERE sj.kind = 'memory_suggest' ORDER BY jr.started_at DESC LIMIT 1`,
      )
      .get() as { status: string; log: string };
    expect(jr.status).toBe('done');
    expect(jr.log).toContain('disabled');
  });
});

describe('manual trigger route', () => {
  it('POST /api/memory/suggest gates on the flag (400) and availability (503)', async () => {
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_pull_enabled: false } });
    const off = await api(srv.url, '/api/memory/suggest', { method: 'POST' });
    expect(off.status).toBe(400);
    expect(off.body.reason).toBe('disabled');

    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { memory_pull_enabled: true } });
    delete process.env.CI_SERVER_URL;
    const unavail = await api(srv.url, '/api/memory/suggest', { method: 'POST' });
    expect(unavail.status).toBe(503);
    expect(unavail.body.reason).toBe('unavailable');
  });

  it('POST /api/memory/suggest stages and reports counts', async () => {
    const r = await api(srv.url, '/api/memory/suggest', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ran', created: 2 });
    expect(memoryPossibles('pending').length).toBe(2);
  });
});

describe('multi-owner isolation (0114 owner-scoped dedup)', () => {
  it("owner B stages its full set over the shared fixture; owner A's rows are untouched", async () => {
    // Owner A stages both fixture events, then dismisses one via the real route.
    await run(() => suggestFromMemory({ polish: false }));
    const [victim] = memoryPossibles('pending');
    const d = await api(srv.url, `/api/possible-tasks/${victim.id}/dismiss`, { method: 'POST' });
    expect(d.status).toBe(200);
    const aRowsBefore = sqlite
      .prepare(`SELECT id, source_ref, raw_title, status FROM possible_tasks WHERE proposed_owner_id = ? ORDER BY source_ref`)
      .all(OWNER);

    // Owner B, created AFTER the flag flip so the cloned prefs carry
    // memory_pull_enabled = 1; env creds resolve for any owner. Fixture mode means
    // both owners read the SAME graph.json → identical source_refs across owners.
    const B = createOwner();
    const r = await runWithOwner(B, ALL_SCOPES, () => suggestFromMemory({ polish: false }));
    expect(r.status).toBe('ran');
    // A's dismissal must not suppress B's suggestion, and A's pending row must not be
    // absorbed as an "update" — pre-0114 the unscoped dedup key did both.
    expect(r.created).toBe(2);
    expect(r.updated).toBe(0);
    expect(r.skippedDismissed).toBe(0);
    const bRows = sqlite
      .prepare(`SELECT status FROM possible_tasks WHERE proposed_owner_id = ? AND source_kind = 'memory'`)
      .all(B) as { status: string }[];
    expect(bRows.length).toBe(2);
    expect(bRows.every((x) => x.status === 'pending')).toBe(true);

    // Owner A's rows are byte-identical: the dismissed one stays dismissed (terminal
    // per-owner, not globally) and the pending one keeps its id/content.
    const aRowsAfter = sqlite
      .prepare(`SELECT id, source_ref, raw_title, status FROM possible_tasks WHERE proposed_owner_id = ? ORDER BY source_ref`)
      .all(OWNER);
    expect(aRowsAfter).toEqual(aRowsBefore);
  });
});

describe('integration: fixture graph → possible → promote → task (→ block under hands-off)', () => {
  it('promote via the real route carries source + 30m estimate; hands-off places a block with no manual engine call', async () => {
    await run(() => suggestFromMemory({ polish: false }));
    const list = await api(srv.url, '/api/possible-tasks');
    const possible = (list.body.possibles as { id: string; source_kind: string; source_ref: string }[]).find(
      (p) => p.source_kind === 'memory',
    )!;
    expect(possible).toBeDefined();

    // Hands-off through the real prefs API. The route's post-promote auto-schedule
    // runs on TODAY, so give it a full-day 'home'-tagged Plan container (memory
    // suggestions carry the 'home' direction tag, D4) — placement then can't depend
    // on time-of-day (same fixture shape as possibles.test.ts).
    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { trust_mode: 'hands_off' } });
    const today = localISODate();
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_auto, source_kind, status, owner_id)
         VALUES (uuid7(), 'Plan', 'timeblock', 'scheduled', 'home', ?, ?, 0, 'manual', 'planned', ?)`,
      )
      .run(`${today}T00:00:00.000Z`, `${today}T23:59:00.000Z`, OWNER);

    const promoted = await api(srv.url, `/api/possible-tasks/${possible.id}/promote`, { method: 'POST' });
    expect(promoted.status).toBe(201);
    expect(promoted.body.task.source_kind).toBe('memory');
    expect(promoted.body.task.source_ref).toBe(possible.source_ref);
    const taskId = promoted.body.task.id as string;

    // The template's default 30m prep estimate rode possible_tasks.proposed_estimated_minutes
    // → tasks.estimated_minutes, so the route's own TM-5 auto-schedule (requireEstimate)
    // must have placed a block — deliberately NO autoScheduleOnIngest call in this test.
    const task = sqlite.prepare(`SELECT estimated_minutes FROM tasks WHERE id = ?`).get(taskId) as { estimated_minutes: number };
    expect(task.estimated_minutes).toBe(30);
    const block = sqlite
      .prepare(`SELECT id FROM time_blocks WHERE task_id = ? AND block_kind = 'task'`)
      .get(taskId) as { id: string } | undefined;
    expect(block).toBeDefined();

    await api(srv.url, '/api/prefs', { method: 'PATCH', json: { trust_mode: 'balanced' } });
  });
});
