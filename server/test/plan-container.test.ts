import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, api, type TestServer } from './helpers.js';

/**
 * Plan-as-container / grouped movement (PR-C). A task block scheduled into a Plan
 * is a formal member via `parent_block_id`; moving the Plan — or any member —
 * shifts the whole group by one minute delta, atomically and tz-correctly. Deleting
 * a Plan detaches members (SET NULL) by default, or removes them with ?children=delete.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function insertTask(title: string, est = 30, tag?: string): string {
  const id = (sqlite.prepare(`INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, priority) VALUES (uuid7(), ?, ?, 'open', ?, 3) RETURNING id`).get(title, OWNER, est) as { id: string }).id;
  if (tag) {
    let tg = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tag) as { id: string } | undefined;
    if (!tg) tg = sqlite.prepare(`INSERT INTO tags (id, name, owner_id) VALUES (uuid7(), ?, ?) RETURNING id`).get(tag, OWNER) as { id: string };
    sqlite.prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(id, tg.id);
  }
  return id;
}

/** A Plan container (block_kind='timeblock', block_type='plan'). */
function insertPlan(startISO: string, endISO: string, tag?: string): string {
  return (sqlite
    .prepare(`INSERT INTO time_blocks (id, title, block_kind, block_type, tag, start_at, end_at, is_auto, status, owner_id) VALUES (uuid7(), 'Plan', 'timeblock', 'plan', ?, ?, ?, 0, 'planned', ?) RETURNING id`)
    .get(tag ?? null, startISO, endISO, OWNER) as { id: string }).id;
}
/** A task block inside a Plan (parent_block_id set). */
function insertChild(parentId: string | null, startISO: string, endISO: string, title = 'task'): string {
  return (sqlite
    .prepare(`INSERT INTO time_blocks (id, title, block_kind, start_at, end_at, is_auto, status, parent_block_id, owner_id) VALUES (uuid7(), ?, 'task', ?, ?, 1, 'planned', ?, ?) RETURNING id`)
    .get(title, startISO, endISO, parentId, OWNER) as { id: string }).id;
}
const row = (id: string) => sqlite.prepare(`SELECT * FROM time_blocks WHERE id = ?`).get(id) as
  { id: string; start_at: string; end_at: string; parent_block_id: string | null } | undefined;
const ms = (iso: string) => Date.parse(iso);

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); sqlite.exec(`DELETE FROM flight_plan;`); });

describe('Auto places members into a Plan', () => {
  it('sets parent_block_id = the Plan on each task placed into its tagged window', async () => {
    const planBlock = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Errands', block_kind: 'timeblock', tag: 'errands', start_at: at('16:00'), end_at: at('18:00') },
    })).body.block;
    const errand = insertTask('Post office', 30, 'errands');
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: errand } });

    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: DAY, block_id: planBlock.id } });
    const placed = sqlite.prepare(`SELECT * FROM time_blocks WHERE title = 'Post office'`).get() as { parent_block_id: string };
    expect(placed.parent_block_id).toBe(planBlock.id);
  });

  it('leaves parent_block_id NULL for a workday placement (no Plan)', async () => {
    const t = insertTask('Deep work', 60);
    await api(srv.url, '/api/flight-plan', { method: 'POST', json: { task_id: t } });
    await api(srv.url, '/api/auto/run', { method: 'POST', json: { date: DAY } });
    await api(srv.url, '/api/auto/priority', { method: 'POST', json: { date: DAY } }); // D5: workday fill is the explicit tap
    const placed = sqlite.prepare(`SELECT * FROM time_blocks WHERE title = 'Deep work'`).get() as { parent_block_id: string | null };
    expect(placed.parent_block_id).toBeNull();
  });
});

describe('move-group: atomic, offset-preserving shift', () => {
  it('shifts the Plan + all children by the delta when anchored on the Plan', async () => {
    const plan = insertPlan(at('09:00'), at('12:00'), 'work');
    const a = insertChild(plan, at('09:00'), at('10:00'), 'A'); // offset 0
    const b = insertChild(plan, at('10:30'), at('11:00'), 'B'); // offset +90

    const r = await api(srv.url, `/api/blocks/${plan}/move-group`, { method: 'POST', json: { delta_minutes: 30 } });
    expect(r.status).toBe(200);
    expect(row(plan)!.start_at).toBe(at('09:30'));
    expect(row(plan)!.end_at).toBe(at('12:30'));
    expect(row(a)!.start_at).toBe(at('09:30'));
    expect(row(a)!.end_at).toBe(at('10:30'));
    expect(row(b)!.start_at).toBe(at('11:00'));
    expect(row(b)!.end_at).toBe(at('11:30'));
    // response returns the whole moved group
    expect(r.body.blocks.map((x: any) => x.id).sort()).toEqual([plan, a, b].sort());
  });

  it('moves the whole group identically when anchored on a child', async () => {
    const plan = insertPlan(at('09:00'), at('12:00'));
    const a = insertChild(plan, at('09:00'), at('10:00'), 'A');
    const b = insertChild(plan, at('10:30'), at('11:00'), 'B');

    await api(srv.url, `/api/blocks/${a}/move-group`, { method: 'POST', json: { delta_minutes: 15 } });
    expect(row(plan)!.start_at).toBe(at('09:15'));
    expect(row(a)!.start_at).toBe(at('09:15'));
    expect(row(b)!.start_at).toBe(at('10:45'));
  });

  it('delta 0 is a byte-identical no-op; negative deltas work', async () => {
    const plan = insertPlan(at('09:00'), at('12:00'));
    const a = insertChild(plan, at('09:00'), at('10:00'), 'A');
    const before = { p: row(plan)!, a: row(a)! };

    await api(srv.url, `/api/blocks/${plan}/move-group`, { method: 'POST', json: { delta_minutes: 0 } });
    expect(row(plan)!.start_at).toBe(before.p.start_at);
    expect(row(a)!.end_at).toBe(before.a.end_at);

    await api(srv.url, `/api/blocks/${plan}/move-group`, { method: 'POST', json: { delta_minutes: -60 } });
    expect(row(plan)!.start_at).toBe(at('08:00'));
    expect(row(a)!.start_at).toBe(at('08:00'));
  });

  it('property: random deltas preserve every relative offset + duration, no lost minutes', async () => {
    // crossing midnight, large, negative, and a US spring-forward window (the server
    // shifts pure UTC ms, so the property must hold regardless of wall-clock/DST).
    const deltas = [7, -23, 195, -777, 1440, -1, 13, 0];
    for (const d of deltas) {
      sqlite.exec(`DELETE FROM time_blocks;`);
      const plan = insertPlan('2026-03-08T08:00:00.000Z', '2026-03-08T12:00:00.000Z'); // spans US DST jump
      const a = insertChild(plan, '2026-03-08T08:00:00.000Z', '2026-03-08T09:30:00.000Z', 'A');
      const b = insertChild(plan, '2026-03-08T10:00:00.000Z', '2026-03-08T11:15:00.000Z', 'B');
      const orig = { p: row(plan)!, a: row(a)!, b: row(b)! };
      const gapAB = ms(orig.b.start_at) - ms(orig.a.start_at);
      const durP = ms(orig.p.end_at) - ms(orig.p.start_at);

      await api(srv.url, `/api/blocks/${plan}/move-group`, { method: 'POST', json: { delta_minutes: d } });

      const dMs = d * 60_000;
      for (const [k, before] of Object.entries(orig)) {
        const after = row((before as { id: string }).id)!;
        expect(ms(after.start_at) - ms((before as any).start_at)).toBe(dMs); // every member shifted by exactly d
        expect(ms(after.end_at) - ms((before as any).end_at)).toBe(dMs);
        expect(k).toBeTruthy();
      }
      // relative offsets + durations untouched
      expect(ms(row(b)!.start_at) - ms(row(a)!.start_at)).toBe(gapAB);
      expect(ms(row(plan)!.end_at) - ms(row(plan)!.start_at)).toBe(durP);
    }
  });

  it('404s for an unknown block', async () => {
    expect((await api(srv.url, '/api/blocks/999999/move-group', { method: 'POST', json: { delta_minutes: 30 } })).status).toBe(404);
  });
});

describe('delete a Plan', () => {
  it('default: SET NULLs children — they survive as loose task blocks', async () => {
    const plan = insertPlan(at('09:00'), at('12:00'));
    const a = insertChild(plan, at('09:00'), at('10:00'), 'A');
    const b = insertChild(plan, at('10:30'), at('11:00'), 'B');

    const del = await api(srv.url, `/api/blocks/${plan}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(row(plan)).toBeUndefined();
    expect(row(a)).toBeTruthy();
    expect(row(a)!.parent_block_id).toBeNull(); // detached
    expect(row(b)!.parent_block_id).toBeNull();
  });

  it('?children=delete: removes the member task blocks too', async () => {
    const plan = insertPlan(at('09:00'), at('12:00'));
    const a = insertChild(plan, at('09:00'), at('10:00'), 'A');
    const b = insertChild(plan, at('10:30'), at('11:00'), 'B');

    const del = await api(srv.url, `/api/blocks/${plan}?children=delete`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(row(plan)).toBeUndefined();
    expect(row(a)).toBeUndefined();
    expect(row(b)).toBeUndefined();
  });
});

describe('attach / detach via PATCH', () => {
  it('attaches a loose block (parent_block_id = plan) and detaches it (null)', async () => {
    const plan = insertPlan(at('09:00'), at('12:00'));
    const loose = insertChild(null, at('09:15'), at('09:45'), 'loose');
    expect(row(loose)!.parent_block_id).toBeNull();

    const att = await api(srv.url, `/api/blocks/${loose}`, { method: 'PATCH', json: { parent_block_id: plan } });
    expect(att.status).toBe(200);
    expect(att.body.block.parent_block_id).toBe(plan);
    expect(row(loose)!.parent_block_id).toBe(plan);

    const det = await api(srv.url, `/api/blocks/${loose}`, { method: 'PATCH', json: { parent_block_id: null } });
    expect(det.body.block.parent_block_id).toBeNull();
    expect(row(loose)!.parent_block_id).toBeNull();
  });

  it('GET exposes parent_block_id', async () => {
    const plan = insertPlan(at('09:00'), at('12:00'));
    insertChild(plan, at('09:00'), at('10:00'), 'A');
    const list = await api(srv.url, `/api/blocks?from=${at('00:00')}&to=${at('23:59')}`);
    const child = list.body.blocks.find((b: any) => b.title === 'A');
    expect(child.parent_block_id).toBe(plan);
  });
});
