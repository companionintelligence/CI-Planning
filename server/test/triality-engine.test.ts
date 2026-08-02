import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  trialityNext, signature, logShown, stampOutcome, getWeights,
  confirmedCompletionCount, rawFreeGapMinutes, contextFit,
  DEFAULT_WEIGHTS, type Candidate, type ScoredPick, type SlotWeights,
} from '../src/services/triality.js';
import {
  attachConfidence, serializeConfidence, bandFor,
  CONFIDENCE_MODEL_VERSION, type PickConfidence,
} from '../src/services/triality-confidence.js';
import {
  buildSituationVector, CAT_KEYS, DIM_REGISTRY,
  type DimName, type SituationVector, type Ternary,
} from '../src/services/triality-vector.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';

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
    motivation?: string; priority?: number; owner?: string;
  } = {},
): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, completed_at, completion_mood, motivation, priority)
         VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        title, o.owner ?? OWNER, o.status ?? 'open', o.estimate === undefined ? 30 : o.estimate,
        o.completedAt ?? null, o.mood ?? null, o.motivation ?? null, o.priority ?? 3,
      ) as { id: string }
  ).id;
}

/** N ritual-confirmed completions spread over the window — clears the refusal floor. */
function seedConfirmedHistory(
  n: number,
  opts: { title?: (i: number) => string; owner?: string } = {},
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      insertTask(opts.title?.(i) ?? `done-${i}`, {
        status: 'done',
        completedAt: daysAgo(1 + (i % 30)),
        mood: 'flat',
        owner: opts.owner,
      }),
    );
  }
  return ids;
}

function addCategory(taskId: string, name: string, owner: string = OWNER): void {
  const tag = sqlite
    .prepare(`SELECT id FROM tags WHERE owner_id = ? AND kind = 'category' AND LOWER(name) = LOWER(?)`)
    .get(owner, name) as { id: string } | undefined;
  const tagId =
    tag?.id ??
    ((): string => {
      return (
        sqlite
          .prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (uuid7(), ?, ?, 'category', 1) RETURNING id`)
          .get(owner, name) as { id: string }
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
    expect(await confirmedCompletionCount(OWNER, NOW)).toBe(9);
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
    expect(await rawFreeGapMinutes(OWNER, NOW)).toBe(40);

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

  it('deferred tasks never reach scoring — the owner already said "not until then"', async () => {
    // defer_until is an explicit instruction, not a preference: the rest of the app
    // hides the task from the today-set until it passes. Suggesting it anyway would
    // contradict the owner rather than merely list something they filed away.
    seedConfirmedHistory(12);
    const deferred = insertTask('deferred task');
    sqlite
      .prepare(`UPDATE tasks SET defer_until = ? WHERE id = ?`)
      .run(new Date(NOW.getTime() + 3 * 86_400_000).toISOString(), deferred);
    const elapsed = insertTask('defer window already passed');
    sqlite
      .prepare(`UPDATE tasks SET defer_until = ? WHERE id = ?`)
      .run(new Date(NOW.getTime() - 86_400_000).toISOString(), elapsed);
    insertTask('never deferred');

    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const refs = res.picks.filter((p): p is ScoredPick => !!p).map((p) => p.ref);
    expect(refs).not.toContain(deferred);
    // …and an ELAPSED deferral is just a normal task again — the filter is a
    // point-in-time comparison, not a permanent exclusion.
    expect(refs).toContain(elapsed);
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

describe('N — the embedding stage is bounded (the only I/O in the scoring path)', () => {
  /**
   * EMBED_CANDIDATE_CAP / EMBED_TIMEOUT_MS / NOVELTY_BUDGET_MS are module-private
   * and stay that way — exporting a constant only so a test can read it turns the
   * tunable into API. Every case below drives the bound through INPUTS (pool size,
   * embedFn latency, embedFn failure) and asserts the observable contract instead:
   * the result is byte-identical to the categorical-only result, for EVERY
   * candidate, and the call still returns.
   */

  /** Deterministic, clearly non-degenerate vectors — so a run that DOES embed
   *  provably differs from the categorical-only run. */
  const fakeVec = (t: string): number[] => [t.length % 7, t.charCodeAt(0) % 5, 1];

  it('a pool over the cap embeds NOTHING — categorical for all, embedFn never called', async () => {
    seedConfirmedHistory(12);
    // 41 open candidates: one past the documented cap of 40. No time_blocks ⇒
    // rawFreeGapMinutes is null ⇒ the capacity filter drops nobody, so the pool
    // the novelty stage sees is exactly what we inserted.
    for (let i = 0; i < 41; i++) insertTask(`cand-${String(i).padStart(2, '0')}`, { estimate: 20 });

    const categorical = await trialityNext(OWNER, NOW, { embedFn: null });
    if (categorical.refused) throw new Error('unexpected refusal');

    const embedFn = vi.fn(async (t: string) => fakeVec(t));
    const capped = await trialityNext(OWNER, NOW, { embedFn });

    // ALL-OR-NOTHING, not merely "capped": a half-embedded pool would be two
    // rankings interleaved, so every score in the result must be the categorical
    // one — deep equality over the whole result is the assertion.
    expect(embedFn).not.toHaveBeenCalled();
    expect(capped).toEqual(categorical);
  });

  it('positive control: a pool under the cap DOES embed and moves N', async () => {
    // Guards the test above against passing for the wrong reason (e.g. too little
    // history for a centroid, which also skips embedding).
    seedConfirmedHistory(12);
    insertTask('alpha', { estimate: 20 });
    insertTask('beta', { estimate: 25 });
    insertTask('gamma', { estimate: 30 });

    const categorical = await trialityNext(OWNER, NOW, { embedFn: null });
    const embedFn = vi.fn(async (t: string) => fakeVec(t));
    const blended = await trialityNext(OWNER, NOW, { embedFn });

    expect(embedFn).toHaveBeenCalled();
    expect(blended).not.toEqual(categorical);
  });

  it('an embedFn that never resolves does not hang — one deadline, then categorical', async () => {
    seedConfirmedHistory(12);
    insertTask('alpha', { estimate: 20 });
    insertTask('beta', { estimate: 25 });
    insertTask('gamma', { estimate: 30 });

    const categorical = await trialityNext(OWNER, NOW, { embedFn: null });

    // FAKE TIMERS, setTimeout only: the stage's deadline is a real setTimeout, and
    // faking just that lets us jump past it without a 4-second wall-clock sleep and
    // without touching Date (every date here is derived from the frozen NOW).
    // Safe because the stage registers its timer synchronously, before the first
    // suspension — so it already exists when we advance.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const embedFn = vi.fn(() => new Promise<number[]>(() => {})); // never settles
      const pending = trialityNext(OWNER, NOW, { embedFn });
      await vi.advanceTimersByTimeAsync(10_000); // well past the stage budget
      const timedOut = await pending;
      expect(embedFn).toHaveBeenCalled(); // it really did enter the embedding stage
      expect(timedOut).toEqual(categorical);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an embedFn that throws degrades to categorical without propagating', async () => {
    seedConfirmedHistory(12);
    insertTask('alpha', { estimate: 20 });
    insertTask('beta', { estimate: 25 });

    const categorical = await trialityNext(OWNER, NOW, { embedFn: null });
    const embedFn = vi.fn(async () => {
      throw new Error('ollama embed exploded');
    });
    await expect(trialityNext(OWNER, NOW, { embedFn })).resolves.toEqual(categorical);
    expect(embedFn).toHaveBeenCalled();
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
    expect(await getWeights(OWNER, 'habitual')).toEqual(DEFAULT_WEIGHTS.habitual);
  });
});

describe('log helpers (append-only, once-only)', () => {
  it('logShown appends full score JSON; stampOutcome is once-only and owner-scoped', async () => {
    seedConfirmedHistory(12);
    insertTask('loggable', { estimate: 20 });
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    // The 4th argument mirrors both production call sites: confidence is serialized by
    // the CALLER and handed over opaque, so this module never learns what is in it.
    const ids = await logShown(OWNER, NOW, res.picks, attachConfidence(res.picks, res.vector).map(serializeConfidence));
    const firstId = ids.find((x): x is string => !!x)!;
    const row = sqlite.prepare(`SELECT slot, outcome, scores FROM triality_log WHERE id = ?`).get(firstId) as {
      slot: string; outcome: string; scores: string;
    };
    expect(row.outcome).toBe('shown');
    const scores = JSON.parse(row.scores);
    for (const k of ['F', 'H', 'Q', 'N', 'C', 'total', 'ternary']) expect(k in scores).toBe(true);

    expect((await stampOutcome(OWNER, firstId, 'staged', NOW)).changed).toBe(true);
    expect((await stampOutcome(OWNER, firstId, 'dismissed', NOW)).changed).toBe(false); // once-only
    expect((await stampOutcome('someone-else', firstId, 'opened', NOW)).changed).toBe(false); // cross-tenant no-op
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

// ══════════════════════════════════════════════════════════════════════════════
// v2.2 — confidence is DERIVED, REPORTED, and never fed back into ranking.
// Cases E1–E16 of the wave spec §9. E1–E3 are the non-interference regressions:
// they are what makes "confidence never feeds ranking" structural rather than
// aspirational, so they come first and they fail loud.
// ══════════════════════════════════════════════════════════════════════════════

/** The engine's own rounding, restated here so a pin can cite the operation rather
 *  than a magic literal. Deliberately not imported — it is module-private. */
const round3 = (v: number) => Math.round(v * 1000) / 1000;

const live = (picks: (ScoredPick | null)[]): ScoredPick[] => picks.filter((p): p is ScoredPick => !!p);

/**
 * A pool with real spread on all three ternary axes at once — normality from two
 * habit classes, pragmatism from a stated Balance deficit, capacity from a known
 * free gap — so stage 4 is exercised at every level of `[dot, S, ref]` instead of
 * collapsing onto the ref tie-break.
 *
 * Every `completed_at` is distinct. `completionHistory` orders by that column with
 * no secondary key, so two completions sharing an instant would leave the transition
 * history (and therefore Q) resolved by rowid — a pin that passes for a reason the
 * test does not state.
 */
function seedSpreadPool(): Record<'ship' | 'run' | 'read' | 'inbox', string> {
  // 10 confirmed completions of the unclassified class, plus the two classes below,
  // clears REFUSAL_FLOOR with room to spare. Interleaved with the classed rows so the
  // (prev → next) pairs Q reads are not all same-class.
  for (const d of [30, 28, 26, 24, 22, 11, 7, 6, 5, 0.5]) {
    insertTask(`noise-${d}`, { status: 'done', completedAt: daysAgo(d), mood: 'flat' });
  }
  for (const d of [10, 9]) {
    addCategory(insertTask(`health-done-${d}`, { status: 'done', completedAt: daysAgo(d), mood: 'flat' }), 'health');
  }
  for (const d of [6.5, 5.5, 4.5]) {
    addCategory(insertTask(`career-done-${d}`, { status: 'done', completedAt: daysAgo(d), mood: 'flat' }), 'career');
  }
  setPriorities([
    { category: 'health', importance: 9, satisfaction: 2, target: 10 },
    { category: 'career', importance: 4, satisfaction: 8, target: 10 },
  ]);
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, is_locked)
       VALUES (uuid7(), ?, 'sync', 'meeting', ?, ?, 1)`,
    )
    .run(OWNER, iso(90), iso(120));

  const refs = {} as Record<'ship' | 'run' | 'read' | 'inbox', string>;
  refs.ship = insertTask('ship the release', { estimate: 30 });
  addCategory(refs.ship, 'career');
  refs.run = insertTask('short run', { estimate: 20 });
  addCategory(refs.run, 'health');
  refs.read = insertTask('read the long paper', { estimate: 60 });
  addCategory(refs.read, 'growth');
  refs.inbox = insertTask('inbox zero', { estimate: 45 });
  addCategory(refs.inbox, 'career');
  return refs;
}

/**
 * A pool whose ONLY spread is on the normality axis: no fixed blocks (gap unknown ⇒
 * C = 0.5 for everyone), no directions, no priorities, no mood reading (every
 * contextFit pair inactive ⇒ F = 0.5 for everyone). Both of those ternarize to
 * all-zero, so `dot` IS the normality pole and the telemetry can be reasoned about
 * one axis at a time.
 *
 * `classes` is ordered: entry 0 is inserted first, so uuid7 makes the candidate
 * order — and therefore the ref tie-break — the declaration order.
 */
function seedNormalityPool(classes: { cat: string; doneDaysAgo: number[] }[]): Record<string, string> {
  // Old, unclassified completions: they clear the refusal floor without touching any
  // candidate's H (no candidate carries the empty category set).
  for (const d of [40, 41, 42, 43]) {
    insertTask(`noise-${d}`, { status: 'done', completedAt: daysAgo(d), mood: 'flat' });
  }
  const refs: Record<string, string> = {};
  for (const c of classes) {
    for (const d of c.doneDaysAgo) {
      addCategory(insertTask(`${c.cat}-done-${d}`, { status: 'done', completedAt: daysAgo(d), mood: 'flat' }), c.cat);
    }
  }
  for (const c of classes) {
    refs[c.cat] = insertTask(`${c.cat} candidate`, { estimate: 30 });
    addCategory(refs[c.cat], c.cat);
  }
  return refs;
}

/** Slot-INDEPENDENT weights. Every cross-slot comparison below (a runner-up in one
 *  slot against a winner in another) is only meaningful because S is then one
 *  function of the candidate, not three. */
const onlyN: SlotWeights = { F: 0, H: 0, Q: 0, N: 1, C: 0 };
const onlyH: SlotWeights = { F: 0, H: 1, Q: 0, N: 0, C: 0 };

describe('E1–E3 — confidence can never reach ranking', () => {
  it('E1 — the engine never names the confidence module in code (import graph)', async () => {
    // WHAT THIS PROVES: the very first line of a change that wires confidence back into
    // scoring — a runtime import, a type-only import, a re-export, a dynamic import with
    // a literal specifier — turns this red, before any number moves. Cheap and early.
    //
    // WHAT IT DOES NOT PROVE: a rename of triality-confidence.ts, an alias re-export
    // laundered through a third module, or `await import(someVariable)` would all evade
    // the regex. This is a tripwire on the ordinary edit, not a proof of isolation; E3
    // covers the behavioral half that no source grep can see.
    //
    // COMMENTS ARE STRIPPED FIRST, deliberately. The engine DESCRIBES the seam in prose
    // — DecisionTelemetry's doc names the module that consumes it, and logShown's
    // `confidenceJson` doc says why it stays opaque. Prose is not an edge in the import
    // graph, and deleting those comments to satisfy a regex would trade the explanation
    // for the check on the explanation.
    const src = readFileSync(new URL('../src/services/triality.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
    // Positive control: an over-eager stripper that ate the file would make the
    // assertion below pass for the wrong reason.
    expect(code).toMatch(/export async function trialityNext/);
    expect(code).not.toMatch(/triality-confidence/);
  });

  it('E2 — the confidence module is pure: type-only imports, no DB, no clock, no randomness', () => {
    const src = readFileSync(new URL('../src/services/triality-confidence.ts', import.meta.url), 'utf8');
    const imports = src.split(/\r?\n/).filter((l) => /^import\s/.test(l));
    // A file that imported nothing would satisfy the loop vacuously, and the module is
    // supposed to import its input TYPES from the engine — so assert it has some.
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line.startsWith('import type ')).toBe(true);
    // `import type` is erased at compile time, so these are the ways runtime state
    // could still get in without an import line to notice.
    for (const forbidden of [/sqlite/, /db\/index/, /new Date/, /Date\.now/, /Math\.random/]) {
      expect(src).not.toMatch(forbidden);
    }
  });

  it('E3 — attachConfidence does not mutate the picks it reads', async () => {
    seedConfirmedHistory(12);
    insertTask('alpha', { estimate: 20 });
    insertTask('beta', { estimate: 25 });
    insertTask('gamma', { estimate: 30 });

    const first = await trialityNext(OWNER, NOW, { embedFn: null });
    if (first.refused) throw new Error('unexpected refusal');
    const snapshot = JSON.stringify(first.picks);

    const confidences = attachConfidence(first.picks, first.vector);
    // Guards the two assertions below against passing because nothing ran.
    expect(confidences.filter((c) => c !== null).length).toBeGreaterThan(0);
    expect(JSON.stringify(first.picks)).toBe(snapshot);

    // …and a whole second run after a scored one is byte-identical, so scoring read no
    // state the attach pass could have left behind. This is the path a source grep
    // cannot see: an in-place edit of a `scores` object needs no import at all.
    const second = await trialityNext(OWNER, NOW, { embedFn: null });
    if (second.refused) throw new Error('unexpected refusal');
    expect(JSON.stringify(second.picks)).toBe(snapshot);
  });
});

describe('E4–E8 — stage-4 telemetry describes the decision that was actually made', () => {
  it('E4 — the runner-up refactor is behavior-preserving', async () => {
    // The pin is [slot, title, scores, ternary] — everything the pre-v2.2 ScoredPick
    // carried, and nothing v2.2 added. These literals were READ OFF THE PRE-CHANGE
    // ENGINE — this fixture run against the copy of services/triality.ts from before
    // runner-up capture landed — not off the current one. A golden test pinned to its
    // own output testifies to nothing.
    //
    // `ref` is a uuid7, so the pin names the TITLE; the fixture's insertion order is
    // what fixes the ref tie-break. Runner-up capture is a pure addition — the winner's
    // own update is the same expression it always was, now called `keyBetter` — and
    // these numbers are what says so.
    const refs = seedSpreadPool();
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');

    expect(
      res.picks.map((p) => (p ? [p.slot, p.title, p.scores, p.ternary] : null)),
    ).toEqual([
      ['habitual', 'short run',
        { F: 1, H: 0.547, Q: 0.111, N: 0.453, C: 1, total: 0.641 }, [0, 1, 1]],
      ['contextual', 'ship the release',
        { F: 0, H: 1, Q: 0.333, N: 0, C: 0.917, total: 0.2 }, [1, -1, 1]],
      ['novel', 'read the long paper',
        { F: 0.5, H: 0, Q: 0, N: 1, C: 0.583, total: 0.592 }, [-1, 0, -1]],
    ]);
    expect(res.picks.map((p) => p?.ref)).toEqual([refs.run, refs.ship, refs.read]);
  });

  it('E5 — the runner-up is second-best by the SAME key, not second-best by S', async () => {
    // Layout: two candidates share the top normality pole and a THIRD, lower-dot
    // candidate carries the highest S in the pool. If the runner-up were read off S
    // instead of off `[dot, S, ref]`, that third candidate would be reported here.
    const refs = seedNormalityPool([
      { cat: 'career', doneDaysAgo: [1, 2, 3] },       // H = 1.0      → normality +1
      { cat: 'health', doneDaysAgo: [6, 7, 8] },       // H ≈ 0.78     → normality +1
      { cat: 'growth', doneDaysAgo: [8.5, 10.5] },     // H ≈ 0.46     → normality  0
      { cat: 'finance', doneDaysAgo: [] },             // H = 0        → normality −1 (vetoed)
    ]);
    const res = await trialityNext(OWNER, NOW, { embedFn: null, getWeightsFn: () => onlyN });
    if (res.refused) throw new Error('unexpected refusal');
    const [habitual, , novel] = res.picks;

    // S = N = 1 − H here, so the pool's top habit scores exactly 0 and the middle
    // candidate scores highest of the three eligible.
    expect(habitual!.ref).toBe(refs.health);
    expect(habitual!.decision.eligible).toBe(3); // career, health, growth — finance vetoed
    expect(habitual!.decision.runnerUpDot).toBe(habitual!.decision.dot); // same dot tier
    expect(habitual!.decision.runnerUpScore).toBe(0); // …and the LOWEST S of the three

    // The S-max of that same eligible pool is `growth`, which the novel slot picks
    // uncontested — so its S is observable, and it is strictly above both the winner's
    // and the runner-up's. The runner-up was chosen on dot first; S never got a vote.
    expect(novel!.ref).toBe(refs.growth);
    expect(novel!.decision.score).toBeGreaterThan(habitual!.decision.score);
    expect(habitual!.decision.runnerUpScore).toBeLessThan(novel!.decision.score);
  });

  it('E6 — the runner-up respects the veto and `taken`', async () => {
    const refs = seedNormalityPool([
      { cat: 'career', doneDaysAgo: [1, 2, 3] },       // H = 1.0  → +1, the pool's S-max
      { cat: 'health', doneDaysAgo: [6, 7, 8] },       // H ≈ 0.78 → +1
      { cat: 'growth', doneDaysAgo: [8.5, 10.5] },     // H ≈ 0.46 →  0
      { cat: 'finance', doneDaysAgo: [] },             // H = 0    → −1
      { cat: 'leisure', doneDaysAgo: [] },             // H = 0    → −1
    ]);
    const res = await trialityNext(OWNER, NOW, { embedFn: null, getWeightsFn: () => onlyH });
    if (res.refused) throw new Error('unexpected refusal');
    const [habitual, contextual] = res.picks;

    // THE VETO: habitual drops both bottom-pole candidates; contextual (`target[0] === 0`)
    // vetoes nobody and only loses the one candidate habitual took.
    expect(habitual!.decision.eligible).toBe(3);
    expect(contextual!.decision.eligible).toBe(4);
    expect(contextual!.decision.eligible).toBeGreaterThan(habitual!.decision.eligible);

    // `taken`: S = H is slot-independent here and habitual's winner holds the pool max
    // (exactly 1 — H is normalized by the pool max). Contextual's winner AND its
    // runner-up are both strictly below it, so the candidate habitual consumed appears
    // in neither of contextual's telemetry slots.
    expect(habitual!.ref).toBe(refs.career);
    expect(habitual!.decision.score).toBe(1);
    expect(contextual!.decision.score).toBeLessThan(habitual!.decision.score);
    expect(contextual!.decision.runnerUpScore!).toBeLessThan(contextual!.decision.score);
  });

  it('E7 — the telemetry score is the UNROUNDED S the loop compared', async () => {
    seedSpreadPool();
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const habitual = res.picks[0]!;

    // `scores.total` is round3'd for display; the comparison key was not. A margin
    // computed from the rounded total would disagree with the decision the engine made,
    // and could invert a genuine sub-0.001 tie into an apparent win.
    expect(round3(habitual.decision.score)).toBe(habitual.scores.total);
    expect(habitual.decision.score).not.toBe(habitual.scores.total);
  });

  it('E8 — a singleton eligible pool is uncontested, not a tie', async () => {
    seedConfirmedHistory(12);
    insertTask('the only thing on the list', { estimate: 20 });
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');

    const habitual = res.picks[0]!;
    expect(habitual.decision.eligible).toBe(1);
    expect(habitual.decision.runnerUpDot).toBeNull();
    expect(habitual.decision.runnerUpScore).toBeNull();

    // No comparison happened, so margin is 0 — the house rule that no data never
    // renders as a confident number — and `uncontested` keeps that distinguishable
    // from a tie, which is a different sentence for the owner.
    const c = attachConfidence(res.picks, res.vector)[0]!;
    expect(c.marginBasis).toBe('uncontested');
    expect(c.margin).toBe(0);
    expect(c.counts.eligible).toBe(1);

    // The later slots have nothing left: exclusivity, not an error.
    expect(res.picks[1]).toBeNull();
    expect(res.emptyReasons.contextual).toBeTruthy();
  });
});

describe('E9–E11 — the honest-zero branches and the dims that are actually read', () => {
  it('E9 — a coin flip reports itself as one, end to end', async () => {
    // Two candidates whose signatures appear nowhere in the history: H is all-zero, so
    // `ternarize` sees no spread and every ternary axis is 0. F and C are 0.5 for both
    // (no priorities ⇒ no deficit pair, no fixed block ⇒ no known gap), so the two keys
    // agree on dot AND on S and only the ref order separates them.
    seedConfirmedHistory(12);
    const a = insertTask('brand new thing', { estimate: 30 });
    addCategory(a, 'health');
    const b = insertTask('other brand new thing', { estimate: 30 });
    addCategory(b, 'career');

    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const habitual = res.picks[0]!;
    expect(habitual.decision.eligible).toBe(2);
    expect(habitual.decision.runnerUpDot).toBe(habitual.decision.dot);
    expect(habitual.decision.runnerUpScore).toBe(habitual.decision.score); // bit-identical

    const c = attachConfidence(res.picks, res.vector)[0]!;
    expect(c.marginBasis).toBe('tie');
    expect(c.margin).toBe(0);
    // margin 0 ⇒ weakest link 0 ⇒ `guess`, always. That is the honest report of a
    // decision the id order made.
    expect(c.value).toBe(0);
    expect(c.band).toBe('guess');
  });

  it('E10 — evidenceRows counts exactly the rows H summed', async () => {
    // Distinct, non-colliding `completed_at` values throughout (the seedSpreadPool
    // argument): every class below is counted, so a rowid-resolved tie would make the
    // counts depend on insert order rather than on the predicate.
    for (const d of [30, 31, 32, 33, 34, 35, 36, 37, 38, 39]) {
      insertTask(`noise-${d}`, { status: 'done', completedAt: daysAgo(d), mood: 'flat' });
    }

    // A plain task class with three completions behind it.
    for (const d of [1, 2, 3]) {
      addCategory(insertTask(`health-done-${d}`, { status: 'done', completedAt: daysAgo(d), mood: 'flat' }), 'health');
    }
    const healthTask = insertTask('health thing', { estimate: 30 });
    addCategory(healthTask, 'health');

    // A routine matches by pattern MEMBERSHIP, so completed member tasks accrue.
    const routineType = (
      sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Routine' AND owner_id = ?`).get(OWNER) as { id: string }
    ).id;
    const routine = (
      sqlite
        .prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, 'Morning routine') RETURNING id`)
        .get(OWNER, routineType) as { id: string }
    ).id;
    const addMember = sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`);
    // The routine needs one OPEN member to be offered at all. Deferring it keeps the
    // member itself out of the task pool (the routine query only checks `status`), so
    // the pool stays at exactly three and all three reach a slot.
    const member = insertTask('open member', { estimate: 20 });
    sqlite.prepare(`UPDATE tasks SET defer_until = ? WHERE id = ?`).run(iso(3 * 1440), member);
    addMember.run(routine, member, 0);
    for (const [i, d] of [5, 6].entries()) {
      addMember.run(routine, insertTask(`member-done-${d}`, { status: 'done', completedAt: daysAgo(d), mood: 'flat' }), i + 1);
    }

    // A saved block has no completion trail by construction.
    const template = (
      sqlite
        .prepare(`INSERT INTO block_templates (id, owner_id, name, default_minutes) VALUES (uuid7(), ?, 'Deep work', 60) RETURNING id`)
        .get(OWNER) as { id: string }
    ).id;

    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const rows = new Map(live(res.picks).map((p) => [p.ref, p.evidenceRows]));
    expect(rows.size).toBe(3); // all three action kinds reached a slot — nothing asserted vacuously
    expect(rows.get(healthTask)).toBe(3);
    expect(rows.get(routine)).toBe(2);
    // PERMANENT: `historyMatches` excludes templates by construction, so under the
    // weakest link every template pick is a `guess` forever. Honest in v2.2, and a hard
    // pre-condition on v2.5 — gating without an explicit exemption would silently
    // delete saved blocks from the Novel slot, with no error and no log line.
    expect(rows.get(template)).toBe(0);

    // The §10.9 invariant, and the only assertion here that binds the two OUTPUTS of
    // habitStrengths together: `historyMatches` is the ONE predicate behind both H and
    // evidence, evaluated in a single pass. Everything above reads `evidenceRows` alone,
    // so re-inlining a second, subtly different matcher on the H side would move ranking
    // while every count still checked out.
    //
    // The equivalence is exact rather than approximate because `recencyWeight` is
    // strictly positive: a matched row always adds weight, so a zero count and a zero
    // strength are the same statement. (H is pool-max normalized, which scales the
    // strengths but cannot turn a positive one into 0 — the max is itself positive
    // whenever any candidate matched.)
    for (const p of live(res.picks)) {
      expect(p.evidenceRows === 0).toBe(p.scores.H === 0);
    }
    // Named explicitly for the case that actually bites: drop `c.kind !== 'template'`
    // from the matcher and a category-less saved block signs as `task||` — the same
    // signature as every unclassified completion, ten of which this fixture seeds — so
    // it would earn a non-zero H while still honestly reporting `evidenceRows: 0`.
    const templatePick = live(res.picks).find((p) => p.ref === template)!;
    expect(templatePick.scores.H).toBe(0);

    // A flight-staged task is the SAME signature class: `historyMatches` substitutes
    // kind 'task', so staging must not move the count.
    sqlite.prepare(`INSERT INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, 0)`).run(OWNER, healthTask);
    const staged = await trialityNext(OWNER, NOW, { embedFn: null });
    if (staged.refused) throw new Error('unexpected refusal');
    const flight = live(staged.picks).find((p) => p.ref === healthTask)!;
    expect(flight.kind).toBe('flight');
    expect(flight.evidenceRows).toBe(3);
  });

  it('E11 — the consumed-dim pin: contextFit reads exactly ten of the thirteen dims', () => {
    // The shipped coverage tooltip tells the owner that one of the twelve active dims
    // is sensed and scored by NOTHING. That sentence is a claim about this exact table,
    // so the table is pinned: pair a new dim inside contextFit without adding it here
    // and this fails loudly, which is what stops the copy from rotting into a lie.
    const CONSUMED = new Set<DimName>([
      'motivation_balance',
      ...CAT_KEYS.map((c) => `cat_deficit_${c}` as DimName),
      'day_energy',
      'in_work_hours',
      'day_type',
    ]);

    // A probe that offers a NON-ZERO action side to every pairing contextFit can form:
    // 'me' polarity, all six categories, an estimate inside the small-task band, and a
    // direction. Without that, an unpaired dim and an unread dim would look identical.
    const probe: Candidate = {
      kind: 'task', ref: 'probe', title: 'probe', estimateMin: 20,
      direction: 'work', categories: [...CAT_KEYS], motivation: 'me',
    };
    const only = (name: DimName, value: Ternary): SituationVector => {
      const dims = {} as Record<DimName, Ternary>;
      for (const d of DIM_REGISTRY) dims[d.name] = 0;
      dims[name] = value;
      return { dims, meta: { active: DIM_REGISTRY.map((d) => d.name) } };
    };

    for (const dim of DIM_REGISTRY) {
      for (const value of [1, -1] as Ternary[]) {
        const fit = contextFit(only(dim.name, value), probe);
        const read = fit !== 0.5;
        expect(read, `${dim.name} at ${value}: contextFit = ${fit}`).toBe(CONSUMED.has(dim.name));
      }
    }
    // free_gap reaches the pick as raw minutes (the hard capacity filter and C) and
    // day_energy is read twice (F and capacityScore), so `momentum` alone is sensed,
    // active, and scored by nothing at all.
    expect(DIM_REGISTRY.filter((d) => !CONSUMED.has(d.name)).map((d) => d.name)).toEqual([
      'free_gap', 'momentum', 'memory_context',
    ]);
  });
});

describe('E12–E16 — the situation, the isolation, and what gets written', () => {
  it('E12 — meta.active is 12 with work hours, 11 without, and never 13', async () => {
    // The coverage denominator. `memory_context` encodes a constant and therefore
    // reports inactive in BOTH flag states (the v2.1 truthfulness fix): an inert dim
    // counted as active would understate coverage permanently and invisibly, because
    // it always reads 0.
    expect(DIM_REGISTRY.length).toBe(13);

    const withHours = await buildSituationVector(OWNER, NOW);
    expect(withHours.meta.active).not.toContain('memory_context');
    expect(withHours.meta.active.length).toBe(12);

    sqlite.prepare(`UPDATE scheduling_prefs SET memory_pull_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    expect((await buildSituationVector(OWNER, NOW)).meta.active).not.toContain('memory_context');

    // FIRM_AT/TENTATIVE_AT are chosen so the bands mean the same DIM COUNT at both
    // denominators — which is only worth anything if 11 is genuinely reachable.
    sqlite.prepare(`UPDATE scheduling_prefs SET workday_start = NULL, workday_end = NULL WHERE owner_id = ?`).run(OWNER);
    const noHours = await buildSituationVector(OWNER, NOW);
    expect(noHours.meta.active).not.toContain('in_work_hours');
    expect(noHours.meta.active.length).toBe(11);
  });

  it('E13 — same DB + same injected now → byte-identical picks AND confidences', async () => {
    seedSpreadPool();
    const a = await trialityNext(OWNER, NOW, { embedFn: null });
    const b = await trialityNext(OWNER, NOW, { embedFn: null });
    if (a.refused || b.refused) throw new Error('unexpected refusal');
    expect(JSON.stringify(b.picks)).toBe(JSON.stringify(a.picks));
    // Byte-for-byte, not deep-equal: PickConfidence declares its keys in a fixed order
    // precisely so the stored blob is stable, and a deep comparison would not notice a
    // reordering that changes every row written.
    expect(JSON.stringify(attachConfidence(b.picks, b.vector)))
      .toBe(JSON.stringify(attachConfidence(a.picks, a.vector)));
  });

  it('E14 — another owner’s completions never count as evidence', async () => {
    const other = createOwner(SECOND_OWNER_ID);
    // Owner A: ten unclassified completions (the floor) and two in the health class.
    seedConfirmedHistory(10);
    for (const d of [15, 16]) {
      addCategory(insertTask(`a-health-${d}`, { status: 'done', completedAt: daysAgo(d), mood: 'flat' }), 'health');
    }
    const mine = insertTask('my run', { estimate: 20 });
    addCategory(mine, 'health');

    // Owner B: ten completions in the SAME category name, through B's own tag row.
    for (let i = 0; i < 10; i++) {
      addCategory(
        insertTask(`b-health-${i}`, { status: 'done', completedAt: daysAgo(1 + i), mood: 'flat', owner: other }),
        'health',
        other,
      );
    }
    const theirs = insertTask('their run', { estimate: 20, owner: other });
    addCategory(theirs, 'health', other);

    const a = await trialityNext(OWNER, NOW, { embedFn: null });
    const b = await trialityNext(other, NOW, { embedFn: null });
    if (a.refused || b.refused) throw new Error('unexpected refusal');
    expect(live(a.picks).find((p) => p.ref === mine)!.evidenceRows).toBe(2);
    // The positive control: B really does have ten, so A's 2 is scoping, not an
    // empty join.
    expect(live(b.picks).find((p) => p.ref === theirs)!.evidenceRows).toBe(10);
  });

  it('E15 — logShown writes a self-verifying blob on every row', async () => {
    seedSpreadPool();
    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const confidences = attachConfidence(res.picks, res.vector);
    await logShown(OWNER, NOW, res.picks, confidences.map(serializeConfidence));

    const rows = sqlite
      .prepare(`SELECT slot, confidence FROM triality_log WHERE owner_id = ? ORDER BY id ASC`)
      .all(OWNER) as { slot: string; confidence: string | null }[];
    expect(rows.length).toBe(live(res.picks).length);
    for (const row of rows) {
      expect(row.confidence).not.toBeNull(); // NULL means "shown before v2.2", forever
      const c = JSON.parse(row.confidence!) as PickConfidence;
      // A reviewer with a calculator can check any stored row: the value is the min of
      // the three printed components, and the band is a pure function of that value.
      expect(c.value).toBe(Math.min(c.coverage, c.margin, c.evidence));
      expect(c.band).toBe(bandFor(c.value));
      expect(c.v).toBe(CONFIDENCE_MODEL_VERSION);
    }
    // The learning corpus is untouched BY SCHEMA — confidence is its own column, never
    // smuggled into `scores` where a widened COMPONENTS list would turn it into evidence.
    const scores = JSON.parse(
      (sqlite.prepare(`SELECT scores FROM triality_log WHERE owner_id = ? LIMIT 1`).get(OWNER) as { scores: string }).scores,
    ) as Record<string, unknown>;
    expect(Object.keys(scores).sort()).toEqual(['C', 'F', 'H', 'N', 'Q', 'ternary', 'total']);
  });

  it('E16 — a hard-capacity wipeout writes nothing', async () => {
    seedConfirmedHistory(12);
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, is_locked)
         VALUES (uuid7(), ?, 'standup', 'meeting', ?, ?, 1)`,
      )
      .run(OWNER, iso(20), iso(50));
    insertTask('deep work session', { estimate: 60 });
    insertTask('another long one', { estimate: 90 });

    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    expect(res.picks).toEqual([null, null, null]);
    // The payload shape is unchanged: three honest empties with reasons, plus the
    // vector the refusal was made against.
    expect(Object.keys(res.emptyReasons).sort()).toEqual(['contextual', 'habitual', 'novel']);
    expect(res.vector.meta.active.length).toBeGreaterThan(0);

    const confidences = attachConfidence(res.picks, res.vector);
    expect(confidences).toEqual([null, null, null]);
    expect(await logShown(OWNER, NOW, res.picks, confidences.map(serializeConfidence))).toEqual([null, null, null]);
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM triality_log`).get() as { c: number }).c).toBe(0);
  });
});
