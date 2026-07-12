import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  createBlock,
  updateBlock,
  deleteBlock,
  moveBlockGroup,
  promoteBlockToScheduled,
  clearDayAutoBlocks,
  addTasksToBlock,
} from '../src/services/blocks.js';
import { setCategoryPref } from '../src/services/category-prefs.js';
import { resetDb, createOwner, SECOND_OWNER_ID } from './helpers.js';

/**
 * Phase W step 3.2 — direct service-level tests for services/blocks.ts.
 *
 * The REST route tests (block-recurrence/blocks-category/blocks-export/blocks-place/
 * block-task-sync/block-templates/pattern-blocks/time-blocks-owner/timeblocks) remain
 * the behavioral lock — those handlers went through them unchanged (all HTTP-level, so
 * they exercise the refactored routes end-to-end); this file only pins the service
 * *contract* the coming GraphQL TimeBlockType resolver (W3.3) will consume, plus adds
 * the cross-owner regression coverage blocks never had (mirrors tasks-service.test.ts's
 * W3.1a suite). Every handler in scope was verified already owner-scoped before
 * extraction — no latent IDOR here (unlike tasks' W3.1a/b) — so these tests are
 * defense-in-depth, proving the refactor preserved that scoping rather than fixing it.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

/** Narrow an `ok` result or fail the test — keeps the assertions type-safe. */
function unwrap<T extends { ok: boolean }>(res: T): Extract<T, { ok: true }> {
  expect(res.ok).toBe(true);
  return res as Extract<T, { ok: true }>;
}

/** Insert a bare time_blocks row directly (bypassing the service) under an explicit owner. */
function insertBlock(ownerId: string, over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = {
    id: undefined, owner_id: ownerId, title: 'Foreign block', block_kind: 'task',
    start_at: at('10:00'), end_at: at('11:00'), is_auto: 0, is_locked: 0,
    source_kind: 'manual', status: 'planned', ...over,
  };
  delete row.id;
  const keys = Object.keys(row);
  return (sqlite
    .prepare(`INSERT INTO time_blocks (id, ${keys.join(', ')}) VALUES (uuid7(), ${keys.map(() => '?').join(', ')}) RETURNING id`)
    .get(...keys.map((k) => row[k])) as { id: string }).id;
}

/** Insert a bare task row directly (bypassing the service) under an explicit owner. */
function insertTask(ownerId: string, title: string, over: Record<string, unknown> = {}): string {
  const row: Record<string, unknown> = { title, owner_id: ownerId, status: 'open', ...over };
  const keys = Object.keys(row);
  return (sqlite
    .prepare(`INSERT INTO tasks (id, ${keys.join(', ')}) VALUES (uuid7(), ${keys.map(() => '?').join(', ')}) RETURNING id`)
    .get(...keys.map((k) => row[k])) as { id: string }).id;
}

beforeEach(() => {
  resetDb();
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(OWNER);
});

describe('createBlock', () => {
  it('inserts the block, mirrors tags, and writes audit', async () => {
    const res = unwrap(await createBlock(OWNER, { title: 'Focus', tag: 'work', start_at: at('09:00'), end_at: at('10:00') }));
    expect(res.block.title).toBe('Focus');
    expect(res.block.ownerId).toBe(OWNER);
    expect(res.api.secondary_tags).toEqual([]);
    // rationale is NOT attached on the create path (only fetchBlocksForRange attaches it).
    expect('rationale' in res.api).toBe(false);

    const audit = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'create' AND entity = ?`)
      .get(`block:${res.block.id}`) as { n: number };
    expect(audit.n).toBe(1);
  });

  it('AF-4: a block may carry BOTH a direction tag and a category (create + update), both persist', async () => {
    const catId = (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, 'cat', 'category') RETURNING id`).get(OWNER) as { id: string }).id;
    setCategoryPref(OWNER, catId, { color_token: 'chart-2' });

    // Create with both → succeeds, both persist, and the entity_tags level-1 mirror
    // still fires even with a category present.
    const created = unwrap(await createBlock(OWNER, { title: 'Both', tag: 'work', category_id: catId, start_at: at('09:00'), end_at: at('10:00') }));
    expect(created.block.tag).toBe('work');
    expect(created.block.categoryId).toBe(catId);
    const lvl1 = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM entity_tags et JOIN tags t ON t.id = et.tag_id WHERE et.entity_kind = 'time_block' AND et.entity_id = ? AND et.level = 1 AND t.name = 'work'`)
      .get(created.block.id) as { n: number };
    expect(lvl1.n).toBe(1);

    // Update path: a tag block may later ADD a category (merged row carries both) …
    const tagFirst = unwrap(await createBlock(OWNER, { title: 'Tag first', tag: 'work', start_at: at('11:00'), end_at: at('12:00') }));
    const addedCat = unwrap(await updateBlock(OWNER, tagFirst.block.id, { category_id: catId }));
    expect(addedCat.block.tag).toBe('work');
    expect(addedCat.block.categoryId).toBe(catId);

    // … and a category block may later ADD a tag.
    const catFirst = unwrap(await createBlock(OWNER, { title: 'Cat first', category_id: catId, start_at: at('13:00'), end_at: at('14:00') }));
    const addedTag = unwrap(await updateBlock(OWNER, catFirst.block.id, { tag: 'work' }));
    expect(addedTag.block.tag).toBe('work');
    expect(addedTag.block.categoryId).toBe(catId);
  });

  it('AF-4 color precedence: with both tag and category set, the category-frozen color_token wins at create', async () => {
    const catId = (sqlite.prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, 'cat', 'category') RETURNING id`).get(OWNER) as { id: string }).id;
    setCategoryPref(OWNER, catId, { color_token: 'chart-4' });
    const res = unwrap(await createBlock(OWNER, { title: 'Both', tag: 'work', category_id: catId, start_at: at('09:00'), end_at: at('10:00') }));
    // Direction styling is unchanged; the block's frozen color comes from the category.
    expect(res.block.colorToken).toBe('chart-4');
  });

  it('mirrors placement onto a linked task (REQ2) and flips it to scheduled', async () => {
    const taskId = insertTask(OWNER, 'Write report', { estimated_minutes: 30 });
    const res = unwrap(await createBlock(OWNER, { task_id: taskId, title: 'Write report', start_at: at('09:00'), end_at: at('09:30') }));
    expect(res.syncedTaskId).toBe(taskId);
    const task = sqlite.prepare(`SELECT status, scheduled_for FROM tasks WHERE id = ?`).get(taskId) as { status: string; scheduled_for: string | null };
    expect(task.status).toBe('scheduled');
    expect(task.scheduled_for).toBe(DAY);
  });
});

describe('updateBlock — I10 inbound read-only guard', () => {
  it('rejects a title/time edit on an inbound-mirrored block with a discriminated result (no mutation)', async () => {
    const blockId = insertBlock(OWNER, { title: 'Standup' });
    sqlite.prepare(`INSERT INTO external_events (owner_id, block_id, direction, provider, account, external_id) VALUES (?, ?, 'inbound', 'google', 'me@example.com', 'evt-1')`).run(OWNER, blockId);

    const res = await updateBlock(OWNER, blockId, { title: 'Hijacked' });
    expect(res).toEqual({ ok: false, error: 'inbound_readonly' });
    const row = sqlite.prepare(`SELECT title FROM time_blocks WHERE id = ?`).get(blockId) as { title: string };
    expect(row.title).toBe('Standup');
  });

  it('still allows a non-title/time PATCH (e.g. secondary_tags) on an inbound block', async () => {
    const blockId = insertBlock(OWNER, { title: 'Standup' });
    sqlite.prepare(`INSERT INTO external_events (owner_id, block_id, direction, provider, account, external_id) VALUES (?, ?, 'inbound', 'google', 'me@example.com', 'evt-2')`).run(OWNER, blockId);
    const res = unwrap(await updateBlock(OWNER, blockId, { secondary_tags: ['x'] }));
    expect(res.api.secondary_tags).toEqual(['x']);
  });
});

describe('updateBlock — returns updatedKeys for the caller to stampRow', () => {
  it('column PATCH reports the camelCase keys written', async () => {
    const blockId = insertBlock(OWNER);
    const res = unwrap(await updateBlock(OWNER, blockId, { title: 'Renamed', is_locked: true }));
    expect(res.updatedKeys.sort()).toEqual(['isLocked', 'title'].sort());
  });

  it('a tags-only PATCH (no column changes) reports an empty updatedKeys', async () => {
    const blockId = insertBlock(OWNER);
    const res = unwrap(await updateBlock(OWNER, blockId, { secondary_tags: ['a'] }));
    expect(res.updatedKeys).toEqual([]);
  });
});

/**
 * W3.2 — cross-owner regression. Every handler here was already owner-scoped before
 * extraction (verified clean in the audit); these tests pin that a naive refactor
 * couldn't have silently dropped it, mirroring the W3.1a lock for tasks.
 */
describe('owner-scoping (W3.2) — a cross-owner id is rejected with no mutation', () => {
  it('updateBlock: not_found and leaves the foreign block untouched', async () => {
    createOwner();
    const foreignId = insertBlock(SECOND_OWNER_ID, { title: 'Foreign update' });
    expect(await updateBlock(OWNER, foreignId, { title: 'Hijacked', is_locked: true })).toEqual({ ok: false, error: 'not_found' });
    const row = sqlite.prepare(`SELECT title, is_locked FROM time_blocks WHERE id = ?`).get(foreignId) as { title: string; is_locked: number };
    expect(row).toEqual({ title: 'Foreign update', is_locked: 0 });
  });

  it('updateBlock (I10 guard): a cross-owner inbound block returns not_found, not inbound_readonly (no existence/state oracle)', async () => {
    createOwner();
    // A second owner's block that IS an inbound calendar mirror. Ownership is checked
    // before the I10 guard AND the guard's external_events lookup is owner-scoped, so a
    // title edit from OWNER must 404 (not_found) — never leak the foreign block's
    // inbound state via a 422 inbound_readonly.
    const foreignId = insertBlock(SECOND_OWNER_ID, { title: 'Foreign standup' });
    sqlite.prepare(`INSERT INTO external_events (owner_id, block_id, direction, provider, account, external_id) VALUES (?, ?, 'inbound', 'google', 'them@example.com', 'evt-foreign')`).run(SECOND_OWNER_ID, foreignId);
    expect(await updateBlock(OWNER, foreignId, { title: 'Hijacked' })).toEqual({ ok: false, error: 'not_found' });
    const row = sqlite.prepare(`SELECT title FROM time_blocks WHERE id = ?`).get(foreignId) as { title: string };
    expect(row.title).toBe('Foreign standup');
  });

  it('updateBlock (tags-only PATCH): not_found before touching the foreign block’s tags', async () => {
    createOwner();
    const foreignId = insertBlock(SECOND_OWNER_ID, { title: 'Foreign tags' });
    expect(await updateBlock(OWNER, foreignId, { secondary_tags: ['hijack-tag'] })).toEqual({ ok: false, error: 'not_found' });
    const tagCount = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM entity_tags WHERE entity_kind = 'time_block' AND entity_id = ?`)
      .get(foreignId) as { n: number };
    expect(tagCount.n).toBe(0);
  });

  it('deleteBlock: not_found and leaves the foreign block intact', async () => {
    createOwner();
    const foreignId = insertBlock(SECOND_OWNER_ID, { title: 'Foreign delete' });
    expect(await deleteBlock(OWNER, foreignId)).toEqual({ ok: false, error: 'not_found' });
    const row = sqlite.prepare(`SELECT title FROM time_blocks WHERE id = ?`).get(foreignId) as { title: string } | undefined;
    expect(row?.title).toBe('Foreign delete');
  });

  it('moveBlockGroup: not_found and leaves the foreign block at its original time', async () => {
    createOwner();
    const foreignId = insertBlock(SECOND_OWNER_ID, { title: 'Foreign move', start_at: at('10:00'), end_at: at('11:00') });
    expect(await moveBlockGroup(OWNER, foreignId, 30)).toEqual({ ok: false, error: 'not_found' });
    const row = sqlite.prepare(`SELECT start_at, end_at FROM time_blocks WHERE id = ?`).get(foreignId) as { start_at: string; end_at: string };
    expect(row).toEqual({ start_at: at('10:00'), end_at: at('11:00') });
  });

  it('promoteBlockToScheduled: not_found and leaves the foreign block un-promoted', async () => {
    createOwner();
    const foreignId = insertBlock(SECOND_OWNER_ID, { title: 'Foreign concept', block_type: 'someday', duration_minutes: 45 });
    expect(await promoteBlockToScheduled(OWNER, foreignId, { start_at: at('14:00') })).toEqual({ ok: false, error: 'not_found' });
    const row = sqlite.prepare(`SELECT block_type FROM time_blocks WHERE id = ?`).get(foreignId) as { block_type: string | null };
    expect(row.block_type).toBe('someday');
  });

  it('addTasksToBlock: a foreign container is a silent no-op (zero counts), foreign task never attached', async () => {
    createOwner();
    const foreignContainer = insertBlock(SECOND_OWNER_ID, { title: 'Foreign container', block_kind: 'timeblock', start_at: at('09:00'), end_at: at('12:00') });
    const foreignTask = insertTask(SECOND_OWNER_ID, 'Foreign task', { estimated_minutes: 30 });
    const result = addTasksToBlock(OWNER, foreignContainer, [foreignTask]);
    expect(result).toEqual({ blockId: foreignContainer, blocksCreated: 0, placed: 0, unplaced: 0, skipped: 0 });
    const children = sqlite.prepare(`SELECT COUNT(*) AS n FROM time_blocks WHERE parent_block_id = ?`).get(foreignContainer) as { n: number };
    expect(children.n).toBe(0);
    // No audit entry either — addTasksToBlock only writes one when blocksCreated > 0.
    const audit = sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'add-tasks' AND entity = ?`).get(`block:${foreignContainer}`) as { n: number };
    expect(audit.n).toBe(0);
  });

  it('clearDayAutoBlocks: clearing OWNER’s day never removes a second owner’s auto block on the same day', async () => {
    createOwner();
    const foreignAuto = insertBlock(SECOND_OWNER_ID, {
      title: 'Foreign auto', is_auto: 1, is_locked: 0, source_kind: 'agent',
      start_at: at('09:00'), end_at: at('10:00'),
    });
    const ownAuto = insertBlock(OWNER, {
      title: 'Own auto', is_auto: 1, is_locked: 0, source_kind: 'agent',
      start_at: at('11:00'), end_at: at('12:00'),
    });

    const result = clearDayAutoBlocks(OWNER, DAY);
    expect(result.removedCount).toBe(1); // only the caller's own block

    expect(sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ?`).get(foreignAuto)).toBeTruthy(); // untouched
    expect(sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ?`).get(ownAuto)).toBeFalsy(); // cleared
  });

  it('the legit-owner path still works for each mutator (sanity — the guard above never regresses the happy path)', async () => {
    const blockId = insertBlock(OWNER, { title: 'Mine' });
    expect(unwrap(await updateBlock(OWNER, blockId, { title: 'Renamed' })).block.title).toBe('Renamed');
    expect(unwrap(await moveBlockGroup(OWNER, blockId, 15)).blocks).toHaveLength(1);

    const conceptId = insertBlock(OWNER, { title: 'Concept', block_type: 'someday', duration_minutes: 30 });
    expect(unwrap(await promoteBlockToScheduled(OWNER, conceptId, { start_at: at('14:00') })).block.blockType).toBe('scheduled');

    expect(unwrap(await deleteBlock(OWNER, blockId)).block.id).toBe(blockId);
  });
});
