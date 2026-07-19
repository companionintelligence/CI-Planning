import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { startTestServer, api, resetDb, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterEach(() => resetDb());

describe('GET /api/export', () => {
  it('returns a JSON file with the correct structure', async () => {
    const res = await fetch(`${srv.url}/api/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment.*filename="companion-export/);
    const body = await res.json() as Record<string, unknown>;
    expect(body.version).toBe('9'); // '9': +life_priorities, planning_sessions (post-v8-audit tables)
    expect(typeof body.owner_id).toBe('string');
    expect(typeof body.exported_at).toBe('string');
    for (const key of ['tasks', 'patterns', 'tags', 'scheduling_prefs']) {
      expect(Array.isArray(body[key]), `${key} should be an array`).toBe(true);
    }
  });

  it('includes seeded tasks in the export', async () => {
    sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id) SELECT uuid7(), 'export-me', id FROM owners LIMIT 1`
    ).run();
    const res = await fetch(`${srv.url}/api/export`);
    const body = await res.json() as { tasks: { title: string }[] };
    expect(body.tasks.some((t) => t.title === 'export-me')).toBe(true);
  });
});

describe('POST /api/import', () => {
  it('restores a full round-trip (export → wipe → import → re-export)', async () => {
    sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id) SELECT uuid7(), 'round-trip-task', id FROM owners LIMIT 1`
    ).run();

    const exp1 = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    const tasksBefore = (exp1.tasks as { id: string; title: string }[]);
    expect(tasksBefore.some((t) => t.title === 'round-trip-task')).toBe(true);

    resetDb();
    const { status, body } = await api<{ imported: Record<string, number> }>(
      srv.url, '/api/import', { method: 'POST', json: exp1 }
    );
    expect(status).toBe(200);
    expect(body.imported.tasks).toBe(tasksBefore.length);

    const exp2 = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    const tasksAfter = (exp2.tasks as { id: string }[]).map((t) => t.id).sort();
    const tasksBeforeIds = tasksBefore.map((t) => t.id).sort();
    expect(tasksAfter).toEqual(tasksBeforeIds);
  });

  it('imports a v6-shaped payload by remapping pattern-axis fields', async () => {
    await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'v6-direction', kind: 'direction' } });
    await api(srv.url, '/api/tags', { method: 'POST', json: { name: 'v6-intention', directions: ['v6-direction'] } });
    const { id: ownerId } = sqlite.prepare('SELECT id FROM owners LIMIT 1').get() as { id: string };
    const directionTag = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = 'v6-direction'`).get(ownerId) as { id: string };
    sqlite.prepare(
      `INSERT INTO tag_prefs (id, owner_id, tag_id, kind, color_token, default_minutes)
       VALUES (uuid7(), ?, ?, 'direction', 'primary', 30)`,
    ).run(ownerId, directionTag.id);

    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    const v6 = JSON.parse(JSON.stringify(exp)) as Record<string, unknown>;
    v6.version = '6';
    const v7Directions = Array.isArray(v6.tag_directions) ? (v6.tag_directions as Record<string, unknown>[]) : [];
    v6.tag_patterns = v7Directions.map((row) => {
      const { direction_tag_id, ...rest } = row;
      return { ...rest, pattern_tag_id: direction_tag_id };
    });
    delete v6.tag_directions;
    for (const key of ['tags', 'tag_prefs']) {
      const rows = v6[key];
      if (!Array.isArray(rows)) continue;
      for (const row of rows as Record<string, unknown>[]) {
        if (row.kind === 'direction') row.kind = 'pattern';
      }
    }

    resetDb();
    const { status } = await api(srv.url, '/api/import', { method: 'POST', json: v6 });
    expect(status).toBe(200);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM tags WHERE kind = 'pattern'`).get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM tag_prefs WHERE kind = 'pattern'`).get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare(
      `SELECT COUNT(*) AS n
         FROM tag_directions td
         JOIN tags it ON it.id = td.intention_tag_id
         JOIN tags dt ON dt.id = td.direction_tag_id
        WHERE it.name = 'v6-intention' AND dt.name = 'v6-direction'`,
    ).get() as { n: number }).n).toBe(1);
  });

  it('writes an audit row', async () => {
    const exp = await (await fetch(`${srv.url}/api/export`)).json();
    const before = (sqlite.prepare('SELECT count(*) as n FROM audit_log').get() as { n: number }).n;
    await api(srv.url, '/api/import', { method: 'POST', json: exp });
    const after = (sqlite.prepare('SELECT count(*) as n FROM audit_log').get() as { n: number }).n;
    expect(after).toBe(before + 1);
  });

  it('rejects a mismatched owner_id with 403', async () => {
    const exp = await (await fetch(`${srv.url}/api/export`)).json();
    const { status } = await api(srv.url, '/api/import', {
      method: 'POST',
      json: { ...exp, owner_id: 'different-owner-id' },
    });
    expect(status).toBe(403);
  });

  it('rejects an unknown version with 400', async () => {
    const exp = await (await fetch(`${srv.url}/api/export`)).json();
    const { status } = await api(srv.url, '/api/import', {
      method: 'POST',
      json: { ...exp, version: '99' },
    });
    expect(status).toBe(400);
  });

  it('rejects a missing version with 400', async () => {
    const { version: _v, ...noVersion } = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    const { status } = await api(srv.url, '/api/import', { method: 'POST', json: noVersion });
    expect(status).toBe(400);
  });

  it('rejects a payload with a missing required array with 400', async () => {
    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    const { tasks: _t, ...noTasks } = exp;
    const { status } = await api(srv.url, '/api/import', { method: 'POST', json: noTasks });
    expect(status).toBe(400);
  });

  it('includes daily_recap in export and restores it on import', async () => {
    const { id: ownerId } = sqlite.prepare('SELECT id FROM owners LIMIT 1').get() as { id: string };
    sqlite
      .prepare(
        `INSERT INTO daily_recap (owner_id, date, prose, stats, focus, inputs_hash)
         VALUES (?, '2026-06-22', 'Test briefing', '{}', '[]', 'hash-abc')`
      )
      .run(ownerId);

    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    expect(Array.isArray(exp['daily_recap'])).toBe(true);
    expect((exp['daily_recap'] as { date: string }[]).some((r) => r.date === '2026-06-22')).toBe(true);

    resetDb();
    await api(srv.url, '/api/import', { method: 'POST', json: exp });

    const restored = sqlite
      .prepare(`SELECT date FROM daily_recap WHERE date = '2026-06-22'`)
      .get() as { date: string } | undefined;
    expect(restored?.date).toBe('2026-06-22');
  });

  it('restores objectives, objective_tasks, and reflections on a round-trip (G-EXPORT-MISSING)', async () => {
    const { id: ownerId } = sqlite.prepare('SELECT id FROM owners LIMIT 1').get() as { id: string };
    const taskId = (sqlite.prepare('SELECT uuid7() AS id').get() as { id: string }).id;
    const objId = (sqlite.prepare('SELECT uuid7() AS id').get() as { id: string }).id;
    const linkId = (sqlite.prepare('SELECT uuid7() AS id').get() as { id: string }).id;

    // A task, an objective linked to it, and a today-goal reflection — the three
    // owner-scoped kinds that a pre-v4 export → import silently dropped.
    sqlite.prepare(`INSERT INTO tasks (id, title, owner_id) VALUES (?, 'obj-task', ?)`).run(taskId, ownerId);
    sqlite.prepare(
      `INSERT INTO objectives (id, owner_id, title, created_at, updated_at)
       VALUES (?, ?, 'Ship the thing', '2026-06-22T00:00:00.000Z', '2026-06-22T00:00:00.000Z')`
    ).run(objId, ownerId);
    sqlite.prepare(`INSERT INTO objective_tasks (id, objective_id, task_id) VALUES (?, ?, ?)`).run(linkId, objId, taskId);
    sqlite.prepare(
      `INSERT INTO reflections (owner_id, kind, period_key, position, body, created_at, updated_at)
       VALUES (?, 'today_goal', '2026-06-22', 0, 'Focus on export coverage', '2026-06-22T00:00:00.000Z', '2026-06-22T00:00:00.000Z')`
    ).run(ownerId);

    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    expect((exp.objectives as { id: string }[]).some((o) => o.id === objId)).toBe(true);
    expect((exp.objective_tasks as { objective_id: string }[]).some((l) => l.objective_id === objId)).toBe(true);
    expect((exp.reflections as { body: string }[]).some((r) => r.body === 'Focus on export coverage')).toBe(true);

    resetDb();
    // Prove the wipe really cleared them, so a surviving import isn't a false positive.
    expect((sqlite.prepare('SELECT count(*) as n FROM objectives').get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare('SELECT count(*) as n FROM reflections').get() as { n: number }).n).toBe(0);

    const { status, body } = await api<{ imported: Record<string, number> }>(
      srv.url, '/api/import', { method: 'POST', json: exp }
    );
    expect(status).toBe(200);
    expect(body.imported.objectives).toBe(1);
    expect(body.imported.objective_tasks).toBe(1);
    expect(body.imported.reflections).toBe(1);

    const obj = sqlite.prepare('SELECT title FROM objectives WHERE id = ?').get(objId) as { title: string } | undefined;
    expect(obj?.title).toBe('Ship the thing');
    const link = sqlite.prepare('SELECT task_id FROM objective_tasks WHERE objective_id = ?').get(objId) as { task_id: string } | undefined;
    expect(link?.task_id).toBe(taskId);
    const refl = sqlite.prepare(`SELECT body FROM reflections WHERE period_key = '2026-06-22'`).get() as { body: string } | undefined;
    expect(refl?.body).toBe('Focus on export coverage');
  });

  it('restores copy_history, external_events, and outbound_queue on a round-trip (v8 / G-CASCADEXPORT)', async () => {
    const { id: ownerId } = sqlite.prepare('SELECT id FROM owners LIMIT 1').get() as { id: string };
    const blockId = (sqlite.prepare('SELECT uuid7() AS id').get() as { id: string }).id;
    // A container time_block for the sync rows to hang off (outbound_queue.block_id is NOT NULL).
    sqlite.prepare(
      `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at)
       VALUES (?, ?, 'blk', 'timeblock', '2026-06-22T10:00:00.000Z', '2026-06-22T11:00:00.000Z')`
    ).run(blockId, ownerId);
    sqlite.prepare(
      `INSERT INTO copy_history (id, owner_id, surface, signature) VALUES (uuid7(), ?, 'brief', 'sig-xyz')`
    ).run(ownerId);
    sqlite.prepare(
      `INSERT INTO external_events (id, owner_id, provider, account, external_id, block_id)
       VALUES (uuid7(), ?, 'google', 'acct@ci.test', 'ext-1', ?)`
    ).run(ownerId, blockId);
    sqlite.prepare(
      `INSERT INTO outbound_queue (id, owner_id, block_id, provider, account)
       VALUES (uuid7(), ?, ?, 'google', 'acct@ci.test')`
    ).run(ownerId, blockId);

    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    expect((exp.copy_history as { signature: string }[]).some((r) => r.signature === 'sig-xyz')).toBe(true);
    expect((exp.external_events as { external_id: string }[]).some((r) => r.external_id === 'ext-1')).toBe(true);
    expect((exp.outbound_queue as { block_id: string }[]).some((r) => r.block_id === blockId)).toBe(true);

    resetDb();
    // Prove the wipe cleared them, so a surviving import isn't a false positive.
    expect((sqlite.prepare('SELECT count(*) as n FROM copy_history').get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare('SELECT count(*) as n FROM external_events').get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare('SELECT count(*) as n FROM outbound_queue').get() as { n: number }).n).toBe(0);

    const { status, body } = await api<{ imported: Record<string, number> }>(
      srv.url, '/api/import', { method: 'POST', json: exp }
    );
    expect(status).toBe(200);
    expect(body.imported.copy_history).toBe(1);
    expect(body.imported.external_events).toBe(1);
    expect(body.imported.outbound_queue).toBe(1);
  });

  it('restores life_priorities and planning_sessions on a round-trip (v9)', async () => {
    const { id: ownerId } = sqlite.prepare('SELECT id FROM owners LIMIT 1').get() as { id: string };
    sqlite.prepare(
      `INSERT INTO life_priorities (id, owner_id, category, satisfaction, importance, target_hours_per_week)
       VALUES (uuid7(), ?, 'health', 7, 9, 5)`
    ).run(ownerId);
    sqlite.prepare(
      `INSERT INTO planning_sessions (id, owner_id, entry_branch, status, summary)
       VALUES (uuid7(), ?, 'fill_week', 'completed', 'Planned the week')`
    ).run(ownerId);

    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    expect((exp.life_priorities as { category: string }[]).some((r) => r.category === 'health')).toBe(true);
    expect((exp.planning_sessions as { summary: string | null }[]).some((r) => r.summary === 'Planned the week')).toBe(true);

    resetDb();
    // Prove the wipe cleared them, so a surviving import isn't a false positive.
    expect((sqlite.prepare('SELECT count(*) as n FROM life_priorities').get() as { n: number }).n).toBe(0);
    expect((sqlite.prepare('SELECT count(*) as n FROM planning_sessions').get() as { n: number }).n).toBe(0);

    const { status, body } = await api<{ imported: Record<string, number> }>(
      srv.url, '/api/import', { method: 'POST', json: exp }
    );
    expect(status).toBe(200);
    expect(body.imported.life_priorities).toBe(1);
    expect(body.imported.planning_sessions).toBe(1);
    const lp = sqlite.prepare(`SELECT satisfaction, importance FROM life_priorities WHERE category = 'health'`).get() as
      { satisfaction: number; importance: number } | undefined;
    expect(lp).toEqual({ satisfaction: 7, importance: 9 });
  });

  it('accepts a v8 dump (absent v9 keys restore as empty)', async () => {
    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    delete exp.life_priorities;
    delete exp.planning_sessions;
    const { status } = await api(srv.url, '/api/import', { method: 'POST', json: { ...exp, version: '8' } });
    expect(status).toBe(200);
  });

  it('rolls back entirely when a row violates a NOT NULL constraint', async () => {
    // Seed one task so the DB is non-empty before the failed import.
    sqlite.prepare(
      `INSERT INTO tasks (id, title, owner_id) SELECT uuid7(), 'should-survive', id FROM owners LIMIT 1`
    ).run();
    const rowsBefore = (sqlite.prepare('SELECT count(*) as n FROM tasks').get() as { n: number }).n;

    const exp = await (await fetch(`${srv.url}/api/export`)).json() as Record<string, unknown>;
    // Append a row with a null PK — violates the NOT NULL constraint mid-insert.
    const broken = { ...exp, tasks: [...(exp.tasks as unknown[]), { id: null, title: null, owner_id: null }] };

    // The import may succeed or throw; either way we check DB state.
    await api(srv.url, '/api/import', { method: 'POST', json: broken }).catch(() => {});

    const rowsAfter = (sqlite.prepare('SELECT count(*) as n FROM tasks').get() as { n: number }).n;
    // Transaction rolled back — original row count restored.
    expect(rowsAfter).toBe(rowsBefore);
  });
});
