import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
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
        `INSERT INTO possible_tasks (raw_title, proposed_priority, source_kind, source_ref, confidence, status)
         VALUES ('Sign the contract', 2, 'gmail', 'm1#0', 0.9, 'pending'),
                ('Maybe look into X', 3, 'gmail', 'm2#0', 0.3, 'pending')`
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
        `INSERT INTO possible_tasks (raw_title, source_kind, source_ref, confidence, status)
         VALUES ('Tagged task', 'text', 't1#0', 0.95, 'pending') RETURNING id`
      )
      .get() as { id: number };
    const tag = sqlite.prepare("INSERT INTO tags (name) VALUES ('legal') RETURNING id").get() as { id: number };
    sqlite.prepare('INSERT INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?)').run(p.id, tag.id);

    await runJob('promote_possibles');

    const row = sqlite
      .prepare(
        `SELECT t.title, tg.name FROM tasks t
         JOIN task_tags tt ON tt.task_id = t.id JOIN tags tg ON tg.id = tt.tag_id
         WHERE t.title = 'Tagged task'`
      )
      .get() as { name: string } | undefined;
    expect(row?.name).toBe('legal');
  });

  it('auto_schedule creates time blocks for open tasks and logs a run', async () => {
    sqlite
      .prepare(
        `INSERT INTO tasks (title, priority, owner_id, status, estimated_minutes)
         VALUES ('Write spec', 1, 1, 'open', 60), ('Review PR', 2, 1, 'open', 30)`
      )
      .run();

    await runJob('auto_schedule');

    const run = lastRun('auto_schedule');
    expect(run?.status).toBe('done');
    const blocks = sqlite.prepare("SELECT COUNT(*) AS n FROM time_blocks WHERE block_kind='task'").get() as { n: number };
    expect(blocks.n).toBeGreaterThanOrEqual(1);
  });

  it('nightly_grooming runs end-to-end and records a run (no hard LLM dependency)', async () => {
    sqlite
      .prepare(
        `INSERT INTO possible_tasks (raw_title, source_kind, source_ref, confidence, status)
         VALUES ('Groom me', 'text', 'g1#0', 0.8, 'pending')`
      )
      .run();
    await runJob('nightly_grooming');
    const run = lastRun('nightly_grooming');
    expect(run?.status).toBe('done');
  });

  it('generate_recurrences materializes instances from a template and logs a run', async () => {
    sqlite
      .prepare(
        `INSERT INTO tasks (title, status, owner_id, task_time, priority, recurrence_rule, recurrence_dtstart)
         VALUES ('Daily standup', 'recurring', 1, '09:00', 3, 'FREQ=DAILY', ?)`
      )
      .run(new Date().toISOString());

    await runJob('generate_recurrences');

    const run = lastRun('generate_recurrences');
    expect(run?.status).toBe('done');
    expect(run?.items_created).toBeGreaterThan(0);
    const instances = sqlite
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE recurrence_parent_id IS NOT NULL AND source_kind='recurrence'")
      .get() as { n: number };
    expect(instances.n).toBeGreaterThan(0);
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

  it('ingest_gcal mirrors calendar fixtures into meeting blocks', async () => {
    if (!up) return;
    await runJob('ingest_gcal');
    const run = lastRun('ingest_gcal');
    expect(run?.status).toBe('done');
    const meetings = sqlite.prepare("SELECT COUNT(*) AS n FROM time_blocks WHERE block_kind='meeting'").get() as { n: number };
    expect(meetings.n).toBeGreaterThan(0);
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
