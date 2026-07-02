import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb } from './helpers.js';

// ingest_gcal must run without Ollama and without creating meeting blocks (WP5). Mock the
// agent so the job body exercises ONLY the placement-gating change.
vi.mock('../src/agents/ingest.js', () => ({
  ingestEvents: vi.fn(async () => ({ itemsProcessed: 1, possiblesCreated: 1, possiblesUpdated: 0, blocksCreated: 0 })),
  ingestEmails: vi.fn(async () => ({ itemsProcessed: 0, possiblesCreated: 0, possiblesUpdated: 0, blocksCreated: 0 })),
}));

// sync_calendar must run without a real Google connection. The mock simulates applyInbound
// having mirrored one meeting (returns a SyncResult with created:1) so the job's
// autoScheduleOnIngest packs around it.
vi.mock('../src/agents/sync.js', () => ({
  syncAll: vi.fn(async () => [
    { provider: 'google', account: 'jobs@example.com', created: 1, updated: 0, deleted: 0, conflicts: 0, errors: [] },
  ]),
}));

import { runJob } from '../src/jobs/index.js';

const OWNER = SYSTEM_OWNER;
// The job calls autoScheduleOnIngest() with no explicit date → it places for TODAY. Build
// the Plan window on today's UTC date so the tag-matched placement (Pass 1) can route into it.
const DATE = new Date().toISOString().slice(0, 10);

function lastRun(kind: string) {
  return sqlite
    .prepare(
      `SELECT r.* FROM job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
       WHERE j.kind = ? ORDER BY r.id DESC LIMIT 1`,
    )
    .get(kind) as { status: string; items_created: number; items_updated: number; log: string } | undefined;
}

function setMode(mode: 'suggest' | 'schedule'): void {
  // TM-4: autoScheduleOnIngest now gates on trust_mode='hands_off' (was auto_mode='schedule').
  const trust = mode === 'schedule' ? 'hands_off' : 'balanced';
  sqlite.prepare(`UPDATE scheduling_prefs SET trust_mode = ? WHERE owner_id = ?`).run(trust, OWNER);
}

/** A tagged, scheduled Plan container — what schedule-mode placement routes tag-matched work into. */
function makePlan(tag: string, start: string, end: string): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_auto, source_kind, status, owner_id)
         VALUES (uuid7(), 'Plan', 'timeblock', 'scheduled', ?, ?, ?, 0, 'manual', 'planned', ?) RETURNING id`,
      )
      .get(tag, start, end, OWNER) as { id: string }
  ).id;
}

function makeTask(title: string, tag: string, est = 30): string {
  const id = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`).get(title, OWNER, est) as { id: string }).id;
  let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: string } | undefined;
  if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name, kind, owner_id) VALUES (uuid7(), ?, 'pattern', ?) RETURNING id`).get(tag, OWNER) as { id: string };
  sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  return id;
}

const taskBlocks = () =>
  (sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE block_kind = 'task' AND is_auto = 1`).get() as { n: number }).n;

describe('autoScheduleOnIngest moved from ingest_gcal → sync_calendar (WP5)', () => {
  beforeEach(() => {
    resetDb();
    sqlite.exec(`DELETE FROM flight_plan;`);
    setMode('schedule'); // would auto-place IF the job called autoScheduleOnIngest
    makePlan('errands', `${DATE}T16:00:00.000Z`, `${DATE}T18:00:00.000Z`);
    makeTask('Post office', 'errands');
  });

  it('ingest_gcal no longer auto-places and its log drops the meeting-blocks count', async () => {
    await runJob('ingest_gcal');

    // Even though a placeable task + matching Plan exist in schedule mode, ingest_gcal does
    // NOT place any task blocks anymore.
    expect(taskBlocks()).toBe(0);

    const run = lastRun('ingest_gcal');
    expect(run?.status).toBe('done');
    expect(run?.log).toContain('new possibles');
    expect(run?.log).not.toContain('meeting blocks');
    expect(run?.log).not.toContain('auto-placed');
  });

  it('sync_calendar places after applyInbound and its log reports the auto-placed count', async () => {
    await runJob('sync_calendar');

    // Placement now runs in sync_calendar (schedule mode) → the task is packed into the Plan.
    expect(taskBlocks()).toBeGreaterThanOrEqual(1);

    const run = lastRun('sync_calendar');
    expect(run?.status).toBe('done');
    expect(run?.log).toContain('Synced 1 connector');
    expect(run?.log).toContain('auto-placed');
  });
});
