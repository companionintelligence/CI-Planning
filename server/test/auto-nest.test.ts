import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { createBlock } from '../src/services/blocks.js';
import { chooseContainer, type NestCandidate } from '../src/services/auto-nest.js';
import { resetDb } from './helpers.js';

/**
 * Focus × Time Blocks, Phase 5 — a task block created inside a matching Time Block's
 * span nests into it automatically.
 *
 * The owner's rule (decision 4): BOTH coordinates must match — the direction
 * (WORK/HOME/COMMUNITY) and the life-balance category (Career, Health, …). "Priority"
 * in the owner's phrasing means the life-balance category, not P1–P3.
 *
 * Two layers: `chooseContainer` is pure and carries the semantics, so the interesting
 * cases (tie-breaks, partial overlap, missing coordinates) are tested without a DB;
 * the service tests then prove the rule is actually wired into every creation path via
 * `createBlock`, including the explicit-intent escapes.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;
const ms = (hhmm: string) => Date.parse(at(hhmm));

// ── Pure matcher ──────────────────────────────────────────────────────────────

const candidate = (over: Partial<NestCandidate> = {}): NestCandidate => ({
  id: 'tb1',
  startMs: ms('12:00'),
  endMs: ms('14:00'),
  directions: ['work'],
  categories: ['career'],
  ...over,
});

const subject = (over: Partial<Parameters<typeof chooseContainer>[0]> = {}) => ({
  startMs: ms('12:30'),
  endMs: ms('13:30'),
  directions: ['work'],
  categories: ['career'],
  ...over,
});

describe('chooseContainer — the auto-nest rule', () => {
  it('nests when the span contains it and both coordinates match', () => {
    expect(chooseContainer(subject(), [candidate()])).toBe('tb1');
  });

  it('does not nest on a direction mismatch', () => {
    expect(chooseContainer(subject({ directions: ['home'] }), [candidate()])).toBeNull();
  });

  it('does not nest on a life-balance category mismatch (decision 4)', () => {
    expect(chooseContainer(subject({ categories: ['health'] }), [candidate()])).toBeNull();
  });

  it('a container with no categories matches on direction alone', () => {
    const c = candidate({ categories: [] });
    expect(chooseContainer(subject({ categories: ['health'] }), [c])).toBe('tb1');
  });

  it('a container with no direction never claims a task — it carries no coordinate', () => {
    const c = candidate({ directions: [] });
    expect(chooseContainer(subject(), [c])).toBeNull();
  });

  it('a multi-direction container matches on any of its directions', () => {
    const c = candidate({ directions: ['work', 'community'] });
    expect(chooseContainer(subject({ directions: ['community'] }), [c])).toBe('tb1');
  });

  it('matches case-insensitively', () => {
    const c = candidate({ directions: ['Work'], categories: ['Career'] });
    expect(chooseContainer(subject({ directions: ['WORK'], categories: ['career'] }), [c])).toBe('tb1');
  });

  it('a partial overlap is not containment', () => {
    // Starts inside, ends after the container — the task would hang outside its box.
    expect(chooseContainer(subject({ startMs: ms('13:00'), endMs: ms('15:00') }), [candidate()])).toBeNull();
  });

  it('an exactly-coincident span still counts as contained', () => {
    expect(chooseContainer(subject({ startMs: ms('12:00'), endMs: ms('14:00') }), [candidate()])).toBe('tb1');
  });

  it('the tightest container wins when two qualify', () => {
    const wide = candidate({ id: 'wide', startMs: ms('11:00'), endMs: ms('15:00') });
    const tight = candidate({ id: 'tight', startMs: ms('12:15'), endMs: ms('13:45') });
    expect(chooseContainer(subject(), [wide, tight])).toBe('tight');
    expect(chooseContainer(subject(), [tight, wide])).toBe('tight');
  });

  it('an exact tie leaves the block loose rather than guessing', () => {
    const a = candidate({ id: 'a' });
    const b = candidate({ id: 'b' });
    expect(chooseContainer(subject(), [a, b])).toBeNull();
  });

  it('a non-matching tight container does not shadow a matching wide one', () => {
    const wideMatch = candidate({ id: 'wide', startMs: ms('11:00'), endMs: ms('15:00') });
    const tightMismatch = candidate({ id: 'tight', startMs: ms('12:15'), endMs: ms('13:45'), directions: ['home'] });
    expect(chooseContainer(subject(), [wideMatch, tightMismatch])).toBe('wide');
  });

  it('no candidates → loose', () => {
    expect(chooseContainer(subject(), [])).toBeNull();
  });
});

// ── Wired into createBlock ────────────────────────────────────────────────────

beforeEach(() => { resetDb(); });

/** A tag row of a given kind, returning its id. */
function makeTag(name: string, kind: 'direction' | 'category' | 'intention'): string {
  return (sqlite
    .prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
    .get(OWNER, name, kind) as { id: string }).id;
}

/** A Time Block container with a direction tag and (optionally) categories. */
function makeContainer(over: { tag?: string | null; categories?: string[]; start?: string; end?: string } = {}): string {
  const id = (sqlite
    .prepare(
      `INSERT INTO time_blocks (id, owner_id, title, block_kind, block_type, tag, start_at, end_at,
                                is_auto, is_locked, source_kind, status)
       VALUES (uuid7(), ?, 'Deep work', 'timeblock', 'scheduled', ?, ?, ?, 0, 0, 'manual', 'planned')
       RETURNING id`,
    )
    .get(OWNER, over.tag ?? 'work', at(over.start ?? '12:00'), at(over.end ?? '14:00')) as { id: string }).id;
  (over.categories ?? []).forEach((name, position) => {
    const catId = catIdOf(name);
    sqlite
      .prepare(`INSERT INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('time_block', ?, ?, ?)`)
      .run(id, catId, position);
  });
  return id;
}

/** Category tag id by name, created on first use. */
function catIdOf(name: string): string {
  const existing = sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = ? AND kind = 'category'`).get(OWNER, name) as { id: string } | undefined;
  if (existing) return existing.id;
  return makeTag(name, 'category');
}

const parentOf = (id: string) =>
  (sqlite.prepare(`SELECT parent_block_id FROM time_blocks WHERE id = ?`).get(id) as { parent_block_id: string | null }).parent_block_id;

/** Create a task block through the service. `parent_block_id` is deliberately absent. */
async function place(over: Record<string, unknown> = {}) {
  const res = await createBlock(OWNER, {
    title: 'Write spec',
    start_at: at('12:30'),
    end_at: at('13:30'),
    tag: 'work',
    categories: ['career'],
    ...over,
  } as Parameters<typeof createBlock>[1]);
  expect(res.ok).toBe(true);
  return (res as Extract<typeof res, { ok: true }>).block;
}

describe('createBlock — auto-nest wiring', () => {
  it('a #work Career task inside a #work Career Time Block nests into it', async () => {
    const tb = makeContainer({ tag: 'work', categories: ['career'] });
    expect(parentOf((await place()).id)).toBe(tb);
  });

  it('a #work Health task at the same time stays loose', async () => {
    makeContainer({ tag: 'work', categories: ['career'] });
    catIdOf('health');
    expect(parentOf((await place({ categories: ['health'] })).id)).toBeNull();
  });

  it('a #home task at the same time stays loose', async () => {
    makeContainer({ tag: 'work', categories: ['career'] });
    expect(parentOf((await place({ tag: 'home' })).id)).toBeNull();
  });

  it('a container with no categories claims on direction alone', async () => {
    const tb = makeContainer({ tag: 'work', categories: [] });
    catIdOf('health');
    expect(parentOf((await place({ categories: ['health'] })).id)).toBe(tb);
  });

  it('a task outside every container span stays loose', async () => {
    makeContainer({ tag: 'work', categories: ['career'], start: '09:00', end: '10:00' });
    expect(parentOf((await place()).id)).toBeNull();
  });

  it('explicit parent_block_id wins — matching is bypassed entirely', async () => {
    makeContainer({ tag: 'work', categories: ['career'] });
    // A second, non-matching container the caller names anyway.
    const chosen = makeContainer({ tag: 'home', categories: [], start: '08:00', end: '18:00' });
    expect(parentOf((await place({ parent_block_id: chosen })).id)).toBe(chosen);
  });

  it('an EXPLICIT parent_block_id: null keeps it loose', async () => {
    makeContainer({ tag: 'work', categories: ['career'] });
    expect(parentOf((await place({ parent_block_id: null })).id)).toBeNull();
  });

  it('an explicitly-undefined parent_block_id still nests (the GraphQL mapper always sets the key)', async () => {
    // `toSvcCreate` builds a full object with every unsent field as undefined, so a
    // key-presence test would disable auto-nest for every GraphQL caller.
    const tb = makeContainer({ tag: 'work', categories: ['career'] });
    expect(parentOf((await place({ parent_block_id: undefined })).id)).toBe(tb);
  });

  it('an all-day block never nests — containment is a time relation', async () => {
    makeContainer({ tag: 'work', categories: ['career'] });
    expect(parentOf((await place({ all_day: true })).id)).toBeNull();
  });

  it('a Time Block created inside another Time Block does not nest', async () => {
    makeContainer({ tag: 'work', categories: ['career'] });
    expect(parentOf((await place({ block_kind: 'timeblock' })).id)).toBeNull();
  });

  it('a someday block never nests', async () => {
    makeContainer({ tag: 'work', categories: ['career'] });
    expect(parentOf((await place({ block_type: 'someday' })).id)).toBeNull();
  });

  it('the tightest matching container wins', async () => {
    makeContainer({ tag: 'work', categories: ['career'], start: '11:00', end: '15:00' });
    const tight = makeContainer({ tag: 'work', categories: ['career'], start: '12:15', end: '13:45' });
    expect(parentOf((await place()).id)).toBe(tight);
  });

  it('falls back to the linked task’s direction and categories when the block carries none', async () => {
    const tb = makeContainer({ tag: 'work', categories: ['career'] });
    const dirId = (sqlite.prepare(`SELECT id FROM tags WHERE owner_id = ? AND name = 'work' AND kind = 'direction'`).get(OWNER) as { id: string } | undefined)?.id
      ?? makeTag('work', 'direction');
    const taskId = (sqlite
      .prepare(`INSERT INTO tasks (id, owner_id, title, status) VALUES (uuid7(), ?, 'Write spec', 'open') RETURNING id`)
      .get(OWNER) as { id: string }).id;
    sqlite.prepare(`INSERT INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`).run(taskId, dirId);
    sqlite
      .prepare(`INSERT INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('task', ?, ?, 0)`)
      .run(taskId, catIdOf('career'));

    // The block itself carries neither coordinate — the task is what the owner classified.
    const block = await place({ task_id: taskId, tag: undefined, categories: undefined });
    expect(parentOf(block.id)).toBe(tb);
  });
});
