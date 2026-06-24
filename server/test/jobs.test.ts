import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { runJob } from '../src/jobs/index.js';
import { resetDb, ollamaAvailable } from './helpers.js';

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

  it('promote_possibles promotes high-confidence possibles into tasks and logs a run', async () => {
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, proposed_priority, source_kind, source_ref, confidence, status)
         VALUES (uuid7(), 'Sign the contract', 2, 'gmail', 'm1#0', 0.9, 'pending'),
                (uuid7(), 'Maybe look into X', 3, 'gmail', 'm2#0', 0.3, 'pending')`
      )
      .run();

    await runJob('promote_possibles');

    const tasks = sqlite.prepare('SELECT * FROM tasks').all() as { title: string }[];
    expect(tasks.some((t) => t.title === 'Sign the contract')).toBe(true);
    expect(tasks.length).toBe(1); // low-confidence one stays pending

    const run = lastRun('promote_possibles');
    expect(run?.status).toBe('done');
    expect(run?.items_created).toBe(1);
  });

  it('promotion carries suggested tags across to the new task', async () => {
    const p = sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status)
         VALUES (uuid7(), 'Tagged task', 'text', 't1#0', 0.95, 'pending') RETURNING id`
      )
      .get() as { id: string };
    const tag = sqlite.prepare("INSERT INTO tags (id, name) VALUES (uuid7(), 'legal') RETURNING id").get() as { id: string };
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

  it('nightly_grooming runs end-to-end and records a run (no hard LLM dependency)', async () => {
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status)
         VALUES (uuid7(), 'Groom me', 'text', 'g1#0', 0.8, 'pending')`
      )
      .run();
    await runJob('nightly_grooming');
    const run = lastRun('nightly_grooming');
    expect(run?.status).toBe('done');
  });

  it('an unknown job kind does not create a run row', async () => {
    await runJob('does_not_exist');
    const run = lastRun('does_not_exist');
    expect(run).toBeUndefined();
  });
});

describe('ingestion jobs (require Ollama)', () => {
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
    await runJob('ingest_gmail');
    const run = lastRun('ingest_gmail');
    expect(run?.status).toBe('done');
    const possibles = sqlite.prepare("SELECT COUNT(*) AS n FROM possible_tasks WHERE source_kind='gmail'").get() as { n: number };
    expect(possibles.n).toBeGreaterThan(0);
  });
});
