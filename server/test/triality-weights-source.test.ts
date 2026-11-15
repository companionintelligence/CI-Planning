import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  trialityNext, logShown, getWeights, getWeightsWithSource, DEFAULT_WEIGHTS, SLOTS,
  type ScoredPick, type Slot,
} from '../src/services/triality.js';
import { attachConfidence, serializeConfidence } from '../src/services/triality-confidence.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';

/**
 * Migration 0174: `triality_log.weights_source` says which weights ranked a shown pick, so
 * acceptance can be split into "ranked on the shipped defaults" and "ranked on learned weights".
 * 'learned' = a triality_weights row was used; 'defaults' = no row; 'defaults_invalid' = a row
 * existed but was unusable; NULL = shown before the stamp, or weights injected by a test.
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-07-29T14:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function insertTask(title: string, o: { status?: string; completedAt?: string; score?: number } = {}): void {
  sqlite.prepare(
    `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, completed_at, completion_score, reaction_at, priority)
     VALUES (uuid7(), ?, ?, ?, 30, ?, ?, ?, 3)`,
  ).run(title, OWNER, o.status ?? 'open', o.completedAt ?? null, o.score ?? null, o.score != null ? (o.completedAt ?? null) : null);
}
function seedHistoryAndPool(): void {
  for (let i = 0; i < 12; i++) insertTask(`done-${i}`, { status: 'done', completedAt: daysAgo(1 + (i % 30)), score: 3 });
  for (let i = 0; i < 4; i++) insertTask(`open-${i}`);
}

const putWeights = (slot: Slot, weights: unknown, owner: string = OWNER) =>
  sqlite.prepare(
    `INSERT OR REPLACE INTO triality_weights (owner_id, slot, weights, sample_count, computed_date) VALUES (?, ?, ?, 25, '2026-07-26')`,
  ).run(owner, slot, typeof weights === 'string' ? weights : JSON.stringify(weights));

/** The default habitual weights with H doubled: inside the §6b bounds, so it is a usable row. */
const learnedHabitual = () => ({ ...DEFAULT_WEIGHTS.habitual, H: DEFAULT_WEIGHTS.habitual.H * 1.5, F: DEFAULT_WEIGHTS.habitual.F * 0.75 });

const sources = (owner: string = OWNER) =>
  sqlite.prepare(`SELECT slot, weights_source FROM triality_log WHERE owner_id = ? ORDER BY rowid`).all(owner) as { slot: string; weights_source: string | null }[];

beforeEach(() => resetDb());

describe('the column', () => {
  it('exists, is nullable and has no default, so an old row reads NULL', () => {
    const col = (sqlite.prepare(`PRAGMA table_info(triality_log)`).all() as { name: string; notnull: number; dflt_value: unknown }[])
      .find((c) => c.name === 'weights_source');
    expect(col).toBeDefined();
    expect(col).toMatchObject({ notnull: 0, dflt_value: null });
  });
});

describe('getWeightsWithSource', () => {
  it('no row: the defaults, source defaults', async () => {
    for (const slot of SLOTS) {
      expect(await getWeightsWithSource(OWNER, slot)).toEqual({ weights: DEFAULT_WEIGHTS[slot], source: 'defaults' });
    }
  });

  it('a usable row: its weights, source learned', async () => {
    putWeights('habitual', learnedHabitual());
    const r = await getWeightsWithSource(OWNER, 'habitual');
    expect(r.source).toBe('learned');
    expect(r.weights).toEqual(learnedHabitual());
    expect((await getWeightsWithSource(OWNER, 'novel')).source).toBe('defaults'); // per slot
  });

  it.each([
    ['unparseable JSON', 'not json'],
    ['a missing component', { F: 0.4, H: 0.4, Q: 0.2 }],
    ['a component outside its bounds', { ...DEFAULT_WEIGHTS.habitual, H: 5 }],
    ['a component that is not a number', { ...DEFAULT_WEIGHTS.habitual, F: 'x' }],
    ['a nonzero weight where the default is zero', { ...DEFAULT_WEIGHTS.habitual, N: 0.2 }],
  ])('a row that cannot be used (%s): the defaults, source defaults_invalid', async (_name, weights) => {
    putWeights('habitual', weights);
    expect(await getWeightsWithSource(OWNER, 'habitual')).toEqual({ weights: DEFAULT_WEIGHTS.habitual, source: 'defaults_invalid' });
  });

  it('getWeights returns exactly the weights, unchanged', async () => {
    putWeights('habitual', learnedHabitual());
    expect(await getWeights(OWNER, 'habitual')).toEqual(learnedHabitual());
    expect(await getWeights(OWNER, 'contextual')).toEqual(DEFAULT_WEIGHTS.contextual);
  });

  it('reads only the caller’s own row', async () => {
    createOwner(SECOND_OWNER_ID);
    putWeights('habitual', learnedHabitual(), SECOND_OWNER_ID);
    expect((await getWeightsWithSource(OWNER, 'habitual')).source).toBe('defaults');
    expect((await getWeightsWithSource(SECOND_OWNER_ID, 'habitual')).source).toBe('learned');
  });
});

describe('what a shown pick is stamped with', () => {
  async function runAndLog(opts: Parameters<typeof trialityNext>[2] = { embedFn: null }): Promise<ScoredPick[]> {
    const res = await trialityNext(OWNER, NOW, opts);
    if (res.refused) throw new Error('unexpected refusal');
    await logShown(OWNER, NOW, res.picks, attachConfidence(res.picks, res.vector).map(serializeConfidence));
    return res.picks.filter((p): p is ScoredPick => !!p);
  }

  it('stamps defaults on every slot when the owner has learned nothing', async () => {
    seedHistoryAndPool();
    const picks = await runAndLog();
    expect(picks.length).toBeGreaterThan(0);
    expect(picks.every((p) => p.weightsSource === 'defaults')).toBe(true);
    const rows = sources();
    expect(rows).toHaveLength(picks.length);
    expect(rows.every((r) => r.weights_source === 'defaults')).toBe(true);
  });

  it('stamps learned only on the slots that have a row, defaults on the rest', async () => {
    seedHistoryAndPool();
    putWeights('habitual', learnedHabitual());
    await runAndLog();
    for (const r of sources()) expect(r.weights_source).toBe(r.slot === 'habitual' ? 'learned' : 'defaults');
  });

  it('stamps defaults_invalid for a slot whose stored row is unusable', async () => {
    seedHistoryAndPool();
    putWeights('habitual', 'garbage');
    await runAndLog();
    for (const r of sources()) expect(r.weights_source).toBe(r.slot === 'habitual' ? 'defaults_invalid' : 'defaults');
  });

  it('stamps NULL, never a guess, when the weights were injected', async () => {
    seedHistoryAndPool();
    await runAndLog({ embedFn: null, getWeightsFn: (_o, s) => DEFAULT_WEIGHTS[s] });
    const rows = sources();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.weights_source === null)).toBe(true);
  });

  it('reflects the weights that ranked the run: learned weights that change the ranking are stamped learned', async () => {
    seedHistoryAndPool();
    putWeights('habitual', learnedHabitual());
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const habitual = res.picks[0];
    expect(habitual?.weightsSource).toBe('learned');
    const w = learnedHabitual();
    const s = habitual!.scores;
    expect(s.total).toBeCloseTo(w.F * s.F + w.H * s.H + w.Q * s.Q + w.N * s.N + w.C * s.C, 9);
  });

  it('an old row, written without the column, reads NULL and a later stamp does not touch it', async () => {
    sqlite.prepare(
      `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores)
       VALUES ('old', ?, ?, '2026-07-01', 'habitual', 'task', 't', '{}')`,
    ).run(OWNER, daysAgo(28));
    seedHistoryAndPool();
    await runAndLog();
    const old = sqlite.prepare(`SELECT weights_source FROM triality_log WHERE id = 'old'`).get() as { weights_source: string | null };
    expect(old.weights_source).toBeNull();
  });

  it('the stamp never changes the ranking: the same picks with and without a stored default-equal row', async () => {
    seedHistoryAndPool();
    const plain = await trialityNext(OWNER, NOW, { embedFn: null });
    putWeights('habitual', { ...DEFAULT_WEIGHTS.habitual });
    const learned = await trialityNext(OWNER, NOW, { embedFn: null });
    if (plain.refused || learned.refused) throw new Error('unexpected refusal');
    expect(learned.picks.map((p) => p && [p.ref, p.slot, p.scores.total]))
      .toEqual(plain.picks.map((p) => p && [p.ref, p.slot, p.scores.total]));
    expect(learned.picks[0]?.weightsSource).toBe('learned');
    expect(plain.picks[0]?.weightsSource).toBe('defaults');
  });
});
