import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
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
 * (0114 owner-scoped dedup), and the end-to-end auto-promote pipeline.
 *
 * Phase AF · AF-3 — every staged possible is AUTO-PROMOTED at the end of each run
 * (promoteAllPending): rows land as status='promoted' (the audit trail), the task
 * exists immediately, and the AB1 hook places its block at the event time. Nothing
 * stays 'pending' after a run, and promoted/dismissed refs are terminal on re-runs.
 *
 * Phase AB · AB2 — suggestions MIRROR the event: title = event name (no "Prep for"),
 * proposed_scheduled_for/task_time = the event start in the owner tz (UTC here),
 * estimate = event duration (fixture: 1h review → 60, 2h dinner → 120), due_at =
 * event start. Promote carries the intent to the task and places the block at the
 * event's exact UTC instant on the event's day in ANY trust mode (AB1).
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
  it('stages one possible per in-window event with source_kind=memory and ci:<id> refs, auto-promoted at run end (AF-3)', async () => {
    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.status).toBe('ran');
    expect(r.pulled).toBe(2); // the now+90h event is outside the 48h window
    expect(r.created).toBe(2);
    expect(r.promoted).toBe(2); // AF-3: the whole batch became tasks — no Inbox stop
    expect(memoryPossibles('pending')).toEqual([]);

    const rows = memoryPossibles('promoted');
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.source_ref).toMatch(/^ci:[0-9a-f-]{36}$/);
    const titles = rows.map((x) => x.raw_title).sort();
    expect(titles).toEqual(['Dinner with Sam', 'Quarterly planning review']); // AB2: the event name, no "Prep for"

    // Participants ride the payload; due_at anchors to the event start; AB2 mirror:
    // the estimate is the EVENT DURATION (dinner now+30h→now+32h = 120m) and the
    // START intent is the event start in the owner tz (UTC here), so
    // proposed_scheduled_for/task_time are exactly the due instant's date/HH:MM slices.
    const payloadRow = sqlite
      .prepare(
        `SELECT source_payload, proposed_due_at, proposed_estimated_minutes, proposed_scheduled_for, proposed_task_time
           FROM possible_tasks WHERE raw_title = 'Dinner with Sam'`,
      )
      .get() as {
      source_payload: string;
      proposed_due_at: string;
      proposed_estimated_minutes: number;
      proposed_scheduled_for: string;
      proposed_task_time: string;
    };
    expect(payloadRow.source_payload).toContain('Sam Rivera');
    expect(Date.parse(payloadRow.proposed_due_at)).toBeGreaterThan(Date.now());
    expect(payloadRow.proposed_estimated_minutes).toBe(120);
    expect(payloadRow.proposed_scheduled_for).toBe(payloadRow.proposed_due_at.slice(0, 10));
    expect(payloadRow.proposed_task_time).toBe(payloadRow.proposed_due_at.slice(11, 16));
  });

  it('re-runs are idempotent — promoted refs are settled, never re-staged or re-promoted (AF-3)', async () => {
    await run(() => suggestFromMemory({ polish: false }));
    const again = await run(() => suggestFromMemory({ polish: false }));
    expect(again.created).toBe(0);
    expect(again.updated).toBe(0); // promoted rows are terminal, not refreshed
    expect(again.promoted).toBe(0);
    expect(memoryPossibles('promoted').length).toBe(2);
    // No duplicate tasks either — one task per event ref across both runs.
    const tasks = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND source_kind = 'memory'`)
      .get(OWNER) as { n: number };
    expect(tasks.n).toBe(2);
  });

  it('a dismissed source_ref is terminal — never re-staged', async () => {
    await run(() => suggestFromMemory({ polish: false }));
    // AF-3: rows land 'promoted'; flip one to dismissed via the real route (dismiss is
    // a status write, valid on any settled row) to lock the terminal-ref behavior.
    const [victim] = memoryPossibles('promoted');
    const d = await api(srv.url, `/api/possible-tasks/${victim.id}/dismiss`, { method: 'POST' });
    expect(d.status).toBe(200);

    const r = await run(() => suggestFromMemory({ polish: false }));
    expect(r.skippedDismissed).toBe(1);
    expect(r.created).toBe(0);
    const still = sqlite.prepare(`SELECT status FROM possible_tasks WHERE id = ?`).get(victim.id) as { status: string };
    expect(still.status).toBe('dismissed');
    expect(memoryPossibles('promoted').length).toBe(1);
  });

  it('caps pending memory possibles within a staging pass; the auto-promote then drains the queue (AF-3)', async () => {
    // 5 pre-existing pending rows (staged outside the agent) fill the cap …
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
    // embedFn throws → inline dedupe skips deterministically (the 5 near-identical
    // 'Filler N' titles would otherwise dedupe under a live Ollama and flake counts).
    const noEmbed = async (): Promise<number[]> => { throw new Error('embeddings disabled (deterministic test)'); };
    const r = await run(() => suggestFromMemory({ polish: false, embedFn: noEmbed }));
    // … so this pass stages neither event (cap bites at staging time) …
    expect(r.created).toBe(0);
    expect(r.skippedCap).toBe(2);
    // … but the batch auto-promote drains ALL pending fillers into tasks.
    expect(r.promoted).toBe(MEMORY_PENDING_CAP);
    expect(memoryPossibles('pending')).toEqual([]);
    expect(memoryPossibles('promoted').length).toBe(MEMORY_PENDING_CAP);

    // With the queue drained, the next run stages (and promotes) the 2 events.
    const second = await run(() => suggestFromMemory({ polish: false }));
    expect(second.created).toBe(2);
    expect(second.skippedCap).toBe(0);
    expect(second.promoted).toBe(2);
    expect(memoryPossibles('pending')).toEqual([]);
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
    expect(memoryPossibles('promoted').map((x) => x.raw_title).sort()).toEqual([
      'Dinner with Sam',
      'Quarterly planning review',
    ]);
  });

  it('a working polish refines the drafts', async () => {
    const r = await run(() =>
      suggestFromMemory({
        polish: async (candidates) => new Map(candidates.map((c) => [c.node.id, { title: `Polished: ${c.node.name}` }])),
      }),
    );
    expect(r.created).toBe(2);
    expect(memoryPossibles('promoted').every((x) => x.raw_title.startsWith('Polished: '))).toBe(true);
  });
});

describe('scheduled job (W12 infra)', () => {
  it('the migration seeded the memory_suggest job', () => {
    const row = sqlite
      .prepare(`SELECT kind, cron, enabled FROM scheduled_jobs WHERE kind = 'memory_suggest'`)
      .get() as { kind: string; cron: string; enabled: number };
    expect(row).toMatchObject({ kind: 'memory_suggest', cron: '0 */6 * * *', enabled: 1 });
  });

  it('runScheduledJob stages + auto-promotes suggestions per owner and records a job run', async () => {
    await runScheduledJob('memory_suggest');
    expect(memoryPossibles('pending')).toEqual([]);
    expect(memoryPossibles('promoted').length).toBe(2);
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

  it('POST /api/memory/suggest stages, auto-promotes, and reports counts', async () => {
    const r = await api(srv.url, '/api/memory/suggest', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ran', created: 2, promoted: 2 });
    expect(memoryPossibles('pending')).toEqual([]);
    expect(memoryPossibles('promoted').length).toBe(2);
  });
});

describe('multi-owner isolation (0114 owner-scoped dedup)', () => {
  it("owner B stages its full set over the shared fixture; owner A's rows are untouched", async () => {
    // Owner A stages + auto-promotes both fixture events, then dismisses one via the
    // real route (AF-3: rows are 'promoted' after the run; dismiss still flips status).
    await run(() => suggestFromMemory({ polish: false }));
    const [victim] = memoryPossibles('promoted');
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
    // A's dismissal must not suppress B's suggestion, and A's settled row must not be
    // absorbed as an "update" — pre-0114 the unscoped dedup key did both.
    expect(r.created).toBe(2);
    expect(r.updated).toBe(0);
    expect(r.skippedDismissed).toBe(0);
    expect(r.promoted).toBe(2); // B's batch auto-promoted under B's own scope
    const bRows = sqlite
      .prepare(`SELECT status FROM possible_tasks WHERE proposed_owner_id = ? AND source_kind = 'memory'`)
      .all(B) as { status: string }[];
    expect(bRows.length).toBe(2);
    expect(bRows.every((x) => x.status === 'promoted')).toBe(true);
    // B's promoted tasks belong to B, not A (owner-scoped promotion end to end).
    const bTasks = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ? AND source_kind = 'memory'`)
      .get(B) as { n: number };
    expect(bTasks.n).toBe(2);

    // Owner A's rows are byte-identical: the dismissed one stays dismissed (terminal
    // per-owner, not globally) and the promoted one keeps its id/content — B's inline
    // dedupe + promote (owner-scoped) never touched them.
    const aRowsAfter = sqlite
      .prepare(`SELECT id, source_ref, raw_title, status FROM possible_tasks WHERE proposed_owner_id = ? ORDER BY source_ref`)
      .all(OWNER);
    expect(aRowsAfter).toEqual(aRowsBefore);
  });
});

describe('integration: fixture graph → auto-promoted task → block AT the event time, zero clicks (AF-3 + AB1 + AB2)', () => {
  it('one suggestFromMemory run mirrors each event: task with start intent + block at the event UTC instant, estimate = duration — in the default BALANCED trust mode', async () => {
    // AF-3: the single agent run stages AND promotes AND places — no route call, no
    // Inbox stop. Trust stays 'balanced' (resetDb baseline): start-anchored placement
    // is NOT trust-gated — the suggestion stated the day/time. Deliberately NO engine
    // call and NO Plan container in this test.
    await run(() => suggestFromMemory({ polish: false }));

    const rows = sqlite
      .prepare(
        `SELECT raw_title, source_ref, proposed_due_at, promoted_task_id FROM possible_tasks
          WHERE proposed_owner_id = ? AND source_kind = 'memory' AND status = 'promoted'`,
      )
      .all(OWNER) as { raw_title: string; source_ref: string; proposed_due_at: string; promoted_task_id: string }[];
    expect(rows.length).toBe(2);
    const byTitle = new Map(rows.map((p) => [p.raw_title, p]));

    for (const [title, durMin] of [
      ['Quarterly planning review', 60], // fixture: now+20h → now+21h
      ['Dinner with Sam', 120], // fixture: now+30h → now+32h
    ] as const) {
      const possible = byTitle.get(title)!;
      expect(possible).toBeDefined();
      const task = sqlite
        .prepare(`SELECT * FROM tasks WHERE id = ?`)
        .get(possible.promoted_task_id) as Record<string, unknown> & { id: string };
      expect(task).toBeDefined();
      expect(task.source_kind).toBe('memory');
      expect(task.source_ref).toBe(possible.source_ref);
      expect(task.estimated_minutes).toBe(durMin);
      // AB2: the START intent rode proposed_* → tasks.scheduled_for/task_time (owner
      // tz = UTC, so they're the due instant's date/HH:MM slices).
      expect(task.scheduled_for).toBe(possible.proposed_due_at.slice(0, 10));
      expect(task.task_time).toBe(possible.proposed_due_at.slice(11, 16));

      // AB1 (fired from inside the batch promote): the block landed at the event's UTC
      // instant (minute precision — task_time is HH:MM) on the EVENT's day (not
      // "today"), sized to the event duration.
      const block = sqlite
        .prepare(`SELECT start_at, end_at, is_auto FROM time_blocks WHERE task_id = ? AND block_kind = 'task'`)
        .get(task.id) as { start_at: string; end_at: string; is_auto: number } | undefined;
      expect(block).toBeDefined();
      expect(block!.start_at).toBe(`${possible.proposed_due_at.slice(0, 16)}:00.000Z`);
      expect(Date.parse(block!.end_at) - Date.parse(block!.start_at)).toBe(durMin * 60_000);
      expect(block!.is_auto).toBe(0); // user-intent block: never wiped by clearPriorAuto
    }

    // The batch path broadcast one possible:promoted per item (the per-item SSE-order
    // contract vs placement is locked in possibles.test.ts).
    const events = sqlite
      .prepare(`SELECT seq, event FROM sync_events WHERE owner_id = ? ORDER BY seq ASC`)
      .all(OWNER) as { seq: number; event: string }[];
    const promotedSeqs = events.filter((e) => e.event === 'possible:promoted').map((e) => e.seq);
    expect(promotedSeqs.length).toBe(2);
  });
});
