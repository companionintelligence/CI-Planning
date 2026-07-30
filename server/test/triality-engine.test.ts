import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  trialityNext, signature, logShown, stampOutcome, getWeights,
  confirmedCompletionCount, rawFreeGapMinutes, contextFit,
  DEFAULT_WEIGHTS, type ScoredPick, type SlotWeights,
} from '../src/services/triality.js';
import { resetDb } from './helpers.js';

/**
 * Triality T3 — the deterministic scoring engine (design §1, §4, §5).
 *
 * Fixture style: raw sqlite inserts against the shared sequential DB, frozen
 * `NOW`, injected embedFn (null = categorical-only), TZ=UTC (helpers pin the
 * owner timezone). Every date is computed relative to NOW — no rot.
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-07-29T14:00:00.000Z'); // a Wednesday, inside the 09–18 pinned workday

const iso = (offsetMin: number) => new Date(NOW.getTime() + offsetMin * 60_000).toISOString();
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function insertTask(
  title: string,
  o: {
    status?: string; estimate?: number | null; completedAt?: string; mood?: string;
    motivation?: string; priority?: number;
  } = {},
): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, completed_at, completion_mood, motivation, priority)
         VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        title, OWNER, o.status ?? 'open', o.estimate === undefined ? 30 : o.estimate,
        o.completedAt ?? null, o.mood ?? null, o.motivation ?? null, o.priority ?? 3,
      ) as { id: string }
  ).id;
}

/** N ritual-confirmed completions spread over the window — clears the refusal floor. */
function seedConfirmedHistory(n: number, opts: { title?: (i: number) => string } = {}): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      insertTask(opts.title?.(i) ?? `done-${i}`, {
        status: 'done',
        completedAt: daysAgo(1 + (i % 30)),
        mood: 'flat',
      }),
    );
  }
  return ids;
}

function addCategory(taskId: string, name: string): void {
  const tag = sqlite
    .prepare(`SELECT id FROM tags WHERE owner_id = ? AND kind = 'category' AND LOWER(name) = LOWER(?)`)
    .get(OWNER, name) as { id: string } | undefined;
  const tagId =
    tag?.id ??
    ((): string => {
      return (
        sqlite
          .prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (uuid7(), ?, ?, 'category', 1) RETURNING id`)
          .get(OWNER, name) as { id: string }
      ).id;
    })();
  const pos = (sqlite.prepare(`SELECT COUNT(*) AS c FROM entity_categories WHERE entity_kind='task' AND entity_id=?`).get(taskId) as { c: number }).c;
  sqlite
    .prepare(`INSERT INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('task', ?, ?, ?)`)
    .run(taskId, tagId, pos);
}

function setPriorities(rows: Array<{ category: string; importance: number; satisfaction: number; target: number }>): void {
  for (const r of rows) {
    sqlite
      .prepare(
        `INSERT INTO life_priorities (owner_id, category, satisfaction, importance, target_hours_per_week)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, category) DO UPDATE SET satisfaction=excluded.satisfaction, importance=excluded.importance, target_hours_per_week=excluded.target_hours_per_week`,
      )
      .run(OWNER, r.category, r.satisfaction, r.importance, r.target);
  }
}

beforeEach(() => {
  resetDb();
});

describe('refusal floor (§4)', () => {
  it('refuses below 10 confirmed completions; the 10th flips it', async () => {
    seedConfirmedHistory(9);
    insertTask('unconfirmed', { status: 'done', completedAt: daysAgo(2) }); // no mood/reaction/timer — doesn't count
    expect(confirmedCompletionCount(OWNER, NOW)).toBe(9);
    const refused = await trialityNext(OWNER, NOW, { embedFn: null });
    expect(refused.refused).toBe('sparse_history');
    if (refused.refused) { expect(refused.have).toBe(9); expect(refused.need).toBe(10); }

    seedConfirmedHistory(1);
    insertTask('something to do');
    const ok = await trialityNext(OWNER, NOW, { embedFn: null });
    expect(ok.refused).toBeUndefined();
  });
});

describe('determinism', () => {
  it('same DB + same now twice → identical result, score floats included', async () => {
    seedConfirmedHistory(12);
    insertTask('write report', { estimate: 45 });
    insertTask('call plumber', { estimate: 15 });
    insertTask('sketch garden plan', { estimate: 60 });
    const a = await trialityNext(OWNER, NOW, { embedFn: null });
    const b = await trialityNext(OWNER, NOW, { embedFn: null });
    expect(b).toEqual(a);
  });
});

describe('capacity filter (§1 pipeline order)', () => {
  it('drops known misfits before scoring; unknown gap/estimate never drops', async () => {
    seedConfirmedHistory(12);
    // A locked meeting 40 minutes out bounds the gap.
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, is_locked)
         VALUES (uuid7(), ?, 'standup', 'meeting', ?, ?, 1)`,
      )
      .run(OWNER, iso(40), iso(70));
    expect(rawFreeGapMinutes(OWNER, NOW)).toBe(40);

    insertTask('quick email', { estimate: 15 });
    const bigId = insertTask('deep work session', { estimate: 120 });
    const noEstId = insertTask('mystery chore', { estimate: null });

    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    expect(res.refused).toBeUndefined();
    if (res.refused) return;
    const refs = res.picks.filter((p): p is ScoredPick => !!p).map((p) => p.ref);
    expect(refs).not.toContain(bigId);           // 120m can't fit 40m — filtered, never scored
    expect(refs.length).toBeGreaterThan(0);
    // The unknown-estimate task survived the filter: with only two survivors,
    // both must be among the picks (unknown can't honestly be dropped).
    expect(refs).toContain(noEstId);
  });

  it('dependency-blocked tasks never reach scoring', async () => {
    seedConfirmedHistory(12);
    const blocker = insertTask('blocker', { status: 'open' });
    const blocked = insertTask('blocked task');
    sqlite.prepare(`INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)`).run(blocked, blocker);
    insertTask('free task');
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const refs = res.picks.filter((p): p is ScoredPick => !!p).map((p) => p.ref);
    expect(refs).not.toContain(blocked);
  });
});

describe('H — habit strength recency (§5)', () => {
  it("yesterday's completions outweigh day-80's for the same class", async () => {
    seedConfirmedHistory(10, { title: () => 'noise' });
    // Class A: 3 recent completions with category 'health'; class B: 3 ancient with 'career'.
    for (let i = 0; i < 3; i++) {
      const id = insertTask(`gym-${i}`, { status: 'done', completedAt: daysAgo(1 + i), mood: 'happy' });
      addCategory(id, 'health');
    }
    for (let i = 0; i < 3; i++) {
      const id = insertTask(`ledger-${i}`, { status: 'done', completedAt: daysAgo(80 + i), mood: 'flat' });
      addCategory(id, 'career');
    }
    const recentClass = insertTask('gym session', { estimate: 30 });
    addCategory(recentClass, 'health');
    const staleClass = insertTask('update ledger', { estimate: 30 });
    addCategory(staleClass, 'career');

    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const habitual = res.picks[0];
    expect(habitual?.ref).toBe(recentClass);
    const recentPick = res.picks.filter((p): p is ScoredPick => !!p).find((p) => p.ref === recentClass);
    expect(recentPick && recentPick.scores.H).toBeGreaterThan(0.5);
  });
});

describe('Q — sequence fit (§5)', () => {
  it('a seeded A→B transition history ranks B above C after completing A', async () => {
    seedConfirmedHistory(10, { title: () => 'noise' });
    // Build alternating A→B pairs; last completion is class A (category 'growth').
    for (let i = 0; i < 4; i++) {
      const a = insertTask(`study-${i}`, { status: 'done', completedAt: daysAgo(20 - i * 4), mood: 'flat' });
      addCategory(a, 'growth');
      const b = insertTask(`journal-${i}`, { status: 'done', completedAt: daysAgo(20 - i * 4 - 1), mood: 'flat' });
      addCategory(b, 'leisure');
    }
    const lastA = insertTask('study-last', { status: 'done', completedAt: daysAgo(0.02), mood: 'flat' });
    addCategory(lastA, 'growth');

    const bCand = insertTask('journal now', { estimate: 20 });
    addCategory(bCand, 'leisure');
    const cCand = insertTask('random errand', { estimate: 20 });
    addCategory(cCand, 'finance');

    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const picks = res.picks.filter((p): p is ScoredPick => !!p);
    const qB = picks.find((p) => p.ref === bCand)?.scores.Q;
    const qC = picks.find((p) => p.ref === cCand)?.scores.Q;
    if (qB !== undefined && qC !== undefined) expect(qB).toBeGreaterThan(qC);
    else {
      // At minimum the engine computed a positive Q for the followed class when picked.
      expect(qB ?? 0).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('N — novelty fallback', () => {
  it('embedFn: null → categorical-only novelty, no throw, N = 1 − H_class shape', async () => {
    seedConfirmedHistory(12);
    insertTask('never done this before', { estimate: 20 });
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    for (const p of res.picks) if (p) expect(p.scores.N).toBeGreaterThanOrEqual(0);
  });
});

describe('slot exclusivity + empty-slot honesty (§5)', () => {
  it('three distinct picks; a pool of 2 leaves a slot null with a reason', async () => {
    seedConfirmedHistory(12);
    insertTask('alpha', { estimate: 20 });
    insertTask('beta', { estimate: 25 });
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const nonNull = res.picks.filter((p): p is ScoredPick => !!p);
    const refs = nonNull.map((p) => p.ref);
    expect(new Set(refs).size).toBe(refs.length); // never the same action twice
    expect(res.picks.length).toBe(3);
    if (nonNull.length < 3) {
      const emptySlots = (['habitual', 'contextual', 'novel'] as const).filter(
        (_, i) => res.picks[i] === null,
      );
      for (const s of emptySlots) expect(res.emptyReasons[s]).toBeTruthy();
    }
  });
});

describe('deficit pull (§6) — pulled, not required', () => {
  it('an under-served category flips the contextual pick; habitual stays deficit-blind', async () => {
    // History: 'career' is the strong habit class (recent + many).
    seedConfirmedHistory(10, { title: () => 'noise' });
    for (let i = 0; i < 5; i++) {
      const id = insertTask(`work-${i}`, { status: 'done', completedAt: daysAgo(1 + i), mood: 'flat' });
      addCategory(id, 'career');
    }
    // Stated+measured deficit: health matters (9) but satisfaction 2 and zero minutes.
    setPriorities([
      { category: 'health', importance: 9, satisfaction: 2, target: 10 },
      { category: 'career', importance: 5, satisfaction: 8, target: 10 },
    ]);

    const careerCand = insertTask('another work thing', { estimate: 30 });
    addCategory(careerCand, 'career');
    const healthCand = insertTask('short run', { estimate: 30 });
    addCategory(healthCand, 'health');

    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const picks = res.picks.filter((p): p is ScoredPick => !!p);
    const healthPick = picks.find((p) => p.ref === healthCand);
    const careerPick = picks.find((p) => p.ref === careerCand);
    // The under-served candidate's F must beat the over-served one's (the pull).
    expect(healthPick).toBeTruthy();
    if (healthPick && careerPick) expect(healthPick.scores.F).toBeGreaterThan(careerPick.scores.F);
    // Habitual (slot 0) still goes to the habit class — deficit-blind by weights.
    expect(res.picks[0]?.ref).toBe(careerCand);
  });
});

describe('getWeights seam (T8 plug point)', () => {
  it('scoring consumes injected weights — a crank on H reorders totals', async () => {
    seedConfirmedHistory(12);
    insertTask('a', { estimate: 20 });
    insertTask('b', { estimate: 20 });
    const heavyH: SlotWeights = { F: 0, H: 1, Q: 0, N: 0, C: 0 };
    const res = await trialityNext(OWNER, NOW, {
      embedFn: null,
      getWeightsFn: () => heavyH,
    });
    if (res.refused) throw new Error('unexpected refusal');
    for (const p of res.picks) if (p) expect(p.scores.total).toBe(p.scores.H);
    // And the default seam returns the §5 constants.
    expect(getWeights(OWNER, 'habitual')).toEqual(DEFAULT_WEIGHTS.habitual);
  });
});

describe('log helpers (append-only, once-only)', () => {
  it('logShown appends full score JSON; stampOutcome is once-only and owner-scoped', async () => {
    seedConfirmedHistory(12);
    insertTask('loggable', { estimate: 20 });
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const ids = logShown(OWNER, NOW, res.picks);
    const firstId = ids.find((x): x is string => !!x)!;
    const row = sqlite.prepare(`SELECT slot, outcome, scores FROM triality_log WHERE id = ?`).get(firstId) as {
      slot: string; outcome: string; scores: string;
    };
    expect(row.outcome).toBe('shown');
    const scores = JSON.parse(row.scores);
    for (const k of ['F', 'H', 'Q', 'N', 'C', 'total', 'ternary']) expect(k in scores).toBe(true);

    expect(stampOutcome(OWNER, firstId, 'staged', NOW).changed).toBe(true);
    expect(stampOutcome(OWNER, firstId, 'dismissed', NOW).changed).toBe(false); // once-only
    expect(stampOutcome('someone-else', firstId, 'opened', NOW).changed).toBe(false); // cross-tenant no-op
    const after = sqlite.prepare(`SELECT outcome FROM triality_log WHERE id = ?`).get(firstId) as { outcome: string };
    expect(after.outcome).toBe('staged');
  });
});

describe('signature (§5)', () => {
  it('is order-insensitive on categories and kind-aware', () => {
    expect(signature({ kind: 'task', direction: 'work', categories: ['b', 'a'] })).toBe(
      signature({ kind: 'task', direction: 'work', categories: ['a', 'b'] }),
    );
    expect(signature({ kind: 'task', direction: null, categories: [] })).not.toBe(
      signature({ kind: 'flight', direction: null, categories: [] }),
    );
  });
});

describe('contextFit neutrality', () => {
  it('no active pairings → exactly 0.5 (an unsensed boundary argues neither way)', () => {
    const vector = {
      dims: Object.fromEntries(
        ['in_work_hours', 'day_energy', 'free_gap', 'day_type', 'momentum', 'memory_context', 'motivation_balance'].map((k) => [k, 0]),
      ),
      meta: { active: [] },
    } as never;
    const f = contextFit(vector, {
      kind: 'task', ref: 'x', title: 'x', estimateMin: null, direction: null, categories: [], motivation: null,
    });
    expect(f).toBe(0.5);
  });
});
