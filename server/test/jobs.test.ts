import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { config } from '../src/lib/config.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, runWithOwner, ALL_SCOPES } from '../src/lib/context.js';
import { runJob } from '../src/jobs/index.js';
import {
  resetDb,
  ollamaAvailable,
  createOwner,
  SECOND_OWNER_ID,
  boundEmailLookbackToOneDay,
} from './helpers.js';

function lastRun(kind: string) {
  return sqlite
    .prepare(
      `SELECT r.* FROM job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
       WHERE j.kind = ? ORDER BY r.id DESC LIMIT 1`
    )
    .get(kind) as { status: string; items_created: number; items_updated: number; log: string } | undefined;
}

describe('jobs', () => {
  beforeEach(() => resetDb());

  it('promote_possibles (manual run) promotes ALL pending possibles — no confidence gate (AF-3)', async () => {
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, proposed_priority, source_kind, source_ref, confidence, status)
         VALUES (uuid7(), 'Sign the contract', 2, 'gcal', 'm1#0', 0.9, 'pending'),
                (uuid7(), 'Maybe look into X', 3, 'gcal', 'm2#0', 0.3, 'pending')`
      )
      .run();

    // The cron row is gone (0118) so no job_runs row is recorded, but the kind stays
    // executable for manual runs and now sweeps EVERYTHING pending.
    await runJob('promote_possibles');

    const tasks = sqlite.prepare('SELECT * FROM tasks').all() as { title: string }[];
    expect(tasks.map((t) => t.title).sort()).toEqual(['Maybe look into X', 'Sign the contract']);
    const pending = sqlite.prepare(`SELECT COUNT(*) AS n FROM possible_tasks WHERE status = 'pending'`).get() as { n: number };
    expect(pending.n).toBe(0);
    expect(lastRun('promote_possibles')).toBeUndefined(); // no scheduled_jobs row → no run row
  });

  it('the promote_possibles cron row was retired by 0118; nightly_grooming remains scheduled', () => {
    const promoteRow = sqlite.prepare(`SELECT id FROM scheduled_jobs WHERE kind = 'promote_possibles'`).get();
    expect(promoteRow).toBeUndefined();
    const grooming = sqlite.prepare(`SELECT enabled FROM scheduled_jobs WHERE kind = 'nightly_grooming'`).get() as { enabled: number };
    expect(grooming).toBeDefined();
  });

  it('promotion carries suggested tags across to the new task', async () => {
    const p = sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status)
         VALUES (uuid7(), 'Tagged task', 'text', 't1#0', 0.95, 'pending') RETURNING id`
      )
      .get() as { id: string };
    const tag = sqlite.prepare("INSERT INTO tags (id, name, owner_id) VALUES (uuid7(), 'legal', ?) RETURNING id").get(SYSTEM_OWNER) as { id: string };
    sqlite.prepare('INSERT INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?)').run(p.id, tag.id);

    await runJob('promote_possibles');

    const row = sqlite
      .prepare(
        `SELECT t.title, tg.name FROM tasks t
         JOIN entity_tags et ON et.entity_kind = 'task' AND et.entity_id = t.id
         JOIN tags tg ON tg.id = et.tag_id
         WHERE t.title = 'Tagged task'`
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('legal');
  });

  it('auto_schedule is retired: it proposes candidates into the flight-plan, not blocks (Phase G)', async () => {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, priority, owner_id, status, estimated_minutes)
         VALUES (uuid7(), 'Write spec', 1, ?, 'open', 60), (uuid7(), 'Review PR', 2, ?, 'open', 30)`
      )
      .run(SYSTEM_OWNER, SYSTEM_OWNER);

    await runJob('auto_schedule');

    const run = lastRun('auto_schedule');
    expect(run?.status).toBe('done');
    // No blocks are packed any more — Auto only touches the flight-plan.
    const blocks = sqlite.prepare("SELECT COUNT(*) AS n FROM time_blocks WHERE block_kind='task'").get() as { n: number };
    expect(blocks.n).toBe(0);
    // The two open tasks were proposed into the flight-plan (unselected).
    const staged = sqlite.prepare(`SELECT COUNT(*) AS n FROM flight_plan WHERE owner_id = ?`).get(SYSTEM_OWNER) as { n: number };
    expect(staged.n).toBe(2);
    expect(run?.items_created).toBe(2);
  });

  it('nightly_grooming runs end-to-end, sweeps stragglers unconditionally, and records a run (no hard LLM dependency)', async () => {
    // A LOW-confidence straggler: pre-AF-3 the 0.7 threshold kept it pending forever;
    // the sweeper now promotes it.
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status)
         VALUES (uuid7(), 'Groom me', 'text', 'g1#0', 0.2, 'pending')`
      )
      .run();
    await runJob('nightly_grooming');
    const run = lastRun('nightly_grooming');
    expect(run?.status).toBe('done');
    expect(run?.items_created).toBe(1); // the sweeper promoted the straggler
    const task = sqlite.prepare(`SELECT id FROM tasks WHERE title = 'Groom me'`).get();
    expect(task).toBeDefined();
    const pending = sqlite.prepare(`SELECT COUNT(*) AS n FROM possible_tasks WHERE status = 'pending'`).get() as { n: number };
    expect(pending.n).toBe(0);
  });

  it('nightly_grooming is owner-scoped: each owner\'s run sweeps and counts ONLY its own rows (AF-CU1)', async () => {
    createOwner(SECOND_OWNER_ID);
    // One pending straggler + one overdue open task per owner. One pending row per
    // owner keeps dedupe in its <2-rows early return — no embeddings dependency.
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, status, proposed_owner_id)
         VALUES (uuid7(), 'Mine straggler', 'text', 'mine#0', 'pending', ?),
                (uuid7(), 'Theirs straggler', 'text', 'theirs#0', 'pending', ?)`
      )
      .run(SYSTEM_OWNER, SECOND_OWNER_ID);
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, priority, due_at)
         VALUES (uuid7(), 'Mine overdue', ?, 'open', 3, '2020-01-01T00:00:00.000Z'),
                (uuid7(), 'Theirs overdue', ?, 'open', 3, '2020-01-01T00:00:00.000Z')`
      )
      .run(SYSTEM_OWNER, SECOND_OWNER_ID);

    // Owner B's fan-out iteration: only THEIR straggler promotes, only THEIR overdue bumps.
    await runWithOwner(SECOND_OWNER_ID, ALL_SCOPES, () => runJob('nightly_grooming'));
    const theirRun = lastRun('nightly_grooming');
    expect(theirRun?.items_created).toBe(1); // job_runs credit = their row only
    expect(theirRun?.items_updated).toBe(1); // 0 dups + their 1 overdue bump
    const status = (title: string) =>
      (sqlite.prepare(`SELECT status FROM possible_tasks WHERE raw_title = ?`).get(title) as { status: string }).status;
    const prio = (title: string) =>
      (sqlite.prepare(`SELECT priority FROM tasks WHERE title = ?`).get(title) as { priority: number }).priority;
    expect(status('Theirs straggler')).toBe('promoted');
    expect(status('Mine straggler')).toBe('pending'); // untouched by the other owner's run
    expect(prio('Theirs overdue')).toBe(2);
    expect(prio('Mine overdue')).toBe(3); // untouched by the other owner's run
    const theirTask = sqlite
      .prepare(`SELECT owner_id FROM tasks WHERE title = 'Theirs straggler'`)
      .get() as { owner_id: string };
    expect(theirTask.owner_id).toBe(SECOND_OWNER_ID);

    // The default owner's own iteration then sweeps its rows.
    await runJob('nightly_grooming');
    const myRun = lastRun('nightly_grooming');
    expect(myRun?.items_created).toBe(1);
    expect(status('Mine straggler')).toBe('promoted');
    expect(prio('Mine overdue')).toBe(2);
    expect(prio('Theirs overdue')).toBe(2); // not double-bumped by the default owner's run
  });

  it('NULL-owner legacy possibles are claimed only by the DEFAULT owner\'s run (AF-CU1 deterministic backfill)', async () => {
    createOwner(SECOND_OWNER_ID);
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, status)
         VALUES (uuid7(), 'Legacy row', 'text', 'legacy#0', 'pending')`
      )
      .run();
    const legacy = () =>
      sqlite
        .prepare(`SELECT status, proposed_owner_id FROM possible_tasks WHERE raw_title = 'Legacy row'`)
        .get() as { status: string; proposed_owner_id: string | null };

    // A non-default owner's run must NOT grab it (pre-fix: whichever owner ran first did).
    await runWithOwner(SECOND_OWNER_ID, ALL_SCOPES, () => runJob('promote_possibles'));
    expect(legacy()).toEqual({ status: 'pending', proposed_owner_id: null });

    // The default (SYSTEM_OWNER) run claims it: backfill + promote.
    await runJob('promote_possibles');
    expect(legacy()).toEqual({ status: 'promoted', proposed_owner_id: SYSTEM_OWNER });
    const task = sqlite.prepare(`SELECT owner_id FROM tasks WHERE title = 'Legacy row'`).get() as { owner_id: string };
    expect(task.owner_id).toBe(SYSTEM_OWNER);
  });

  it('an unknown job kind does not create a run row', async () => {
    await runJob('does_not_exist');
    const run = lastRun('does_not_exist');
    expect(run).toBeUndefined();
  });
});

// Timeout raised above the 120s global, same reasoning as run-now's in 3648674: these
// bodies only ever ran where Ollama is unreachable, so nothing had ever measured them
// against real inference. Both ingest at tier 'quality', one generation per item, and
// measured 47.6s (gcal) and 21.5s (gmail, bounded to a one-day lookback) on an idle box.
// Treat those as a floor, not a budget — they are wholly at the mercy of what else holds
// the GPU. With an unrelated 27B model resident in VRAM the same gmail body took 241s and
// gcal ran past 300s outright. Where Ollama is unreachable (CI) both return in ~1ms.
describe('ingestion jobs (require Ollama)', { timeout: 300_000 }, () => {
  let up = false;
  beforeAll(async () => {
    up = await ollamaAvailable();
  });
  beforeEach(() => resetDb());

  it('ingest_gcal produces possibles from calendar fixtures and creates NO meeting blocks (WP5)', async () => {
    if (!up) return;
    await runJob('ingest_gcal');
    const run = lastRun('ingest_gcal');
    expect(run?.status).toBe('done');
    // WP5: the locked meeting mirror is now created exclusively by sync.ts applyInbound;
    // ingest_gcal only mines possibles, so it must not create any meeting blocks.
    const meetings = sqlite.prepare("SELECT COUNT(*) AS n FROM time_blocks WHERE block_kind='meeting'").get() as { n: number };
    expect(meetings.n).toBe(0);
    const possibles = sqlite.prepare("SELECT COUNT(*) AS n FROM possible_tasks WHERE source_kind='gcal'").get() as { n: number };
    expect(possibles.n).toBeGreaterThan(0);
  });

  it('ingest_gmail produces possible_tasks from email fixtures', async () => {
    if (!up) return;
    // Cost bound, not a behavioural one: the rebased fixtures all sit inside the baseline's
    // 7-day window, and 24 real generations at tier 'quality' outrun any sane budget.
    boundEmailLookbackToOneDay();
    await runJob('ingest_gmail');
    const run = lastRun('ingest_gmail');
    expect(run?.status).toBe('done');
    // 'gmail', not 'gcal' — ingest_gmail stamps the kind it was handed (ingest.ts:372).
    // The 'gcal' filter here was a copy-paste from the test above and could only ever
    // count 0, but the ollamaAvailable() tag bug meant this body had never once run.
    const possibles = sqlite.prepare("SELECT COUNT(*) AS n FROM possible_tasks WHERE source_kind='gmail'").get() as { n: number };
    expect(possibles.n).toBeGreaterThan(0);
  });

  it('ingest_gmail skips without running when live mode and enableGmail is false', async () => {
    config.google.mode = 'live';
    config.google.enableGmail = false;
    try {
      await runJob('ingest_gmail');
      const run = lastRun('ingest_gmail');
      expect(run?.log).toContain('skipped');
      const possibles = sqlite.prepare("SELECT COUNT(*) AS n FROM possible_tasks WHERE source_kind='gcal'").get() as { n: number };
      expect(possibles.n).toBe(0);
    } finally {
      config.google.mode = 'fixture';
    }
  });
});
