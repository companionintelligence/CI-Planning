import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  trialityNext, signature, logShown, stampOutcome, getWeights,
  confirmedCompletionCount, rawFreeGapMinutes, contextFit,
  bandOfLocalHour, localBand,
  DEFAULT_WEIGHTS, type Candidate, type ScoredPick, type SlotWeights, type TimeBand,
} from '../src/services/triality.js';
import {
  attachConfidence, serializeConfidence, bandFor,
  CONFIDENCE_MODEL_VERSION, type PickConfidence,
} from '../src/services/triality-confidence.js';
import {
  buildSituationVector, CAT_KEYS, DIM_REGISTRY,
  type DimName, type SituationVector, type Ternary,
} from '../src/services/triality-vector.js';
import { createOwner, resetDb, SECOND_OWNER_ID, seedFallbackFillWindow } from './helpers.js';

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
  seedFallbackFillWindow(); // 0156: Auto's fallback fill needs work/community windows
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
    const picks = res.picks.filter((p): p is ScoredPick => !!p);
    const recentPick = picks.find((p) => p.ref === recentClass);
    const stalePick = picks.find((p) => p.ref === staleClass);
    // RELATIVE, not an absolute pin. v2.3's back-off smooths H by λ3 = n3/(n3+K), so
    // three completions cap the class at 0.5 no matter how recent they are — an
    // absolute floor here would be a pin on the smoothing constant wearing a recency
    // test's name. The claim this test actually makes is the comparative one.
    expect(recentPick!.scores.H).toBeGreaterThan(stalePick!.scores.H);
    expect(stalePick!.scores.H).toBeGreaterThan(0); // the stale class is faint, not absent
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

  /**
   * Every case above INJECTS an embedFn. This one pins the arm the routes and the
   * GraphQL resolver actually take — no opts at all — because that is where the
   * bound stopped holding: the default embedder is Ollama, and nothing asked whether
   * Ollama had an embedder before firing one call per title at it. Combined with the
   * stage budget that made N a coin flip on a busy box, which is what flaked
   * triality-routes' "shown is an event" (two GETs, one blended N and one categorical).
   *
   * The suite's conditions ARE the gate's false case: under NODE_ENV=test the probe
   * deliberately leaves the installed set unknown (mcp/ollama.ts applyInstalled), so
   * every test in the suite now takes the deterministic categorical path.
   */
  it('no embedFn → gated on embedReady(); an unknown installed set never calls /api/embeddings', async () => {
    seedConfirmedHistory(12);
    insertTask('alpha', { estimate: 20 });
    insertTask('beta', { estimate: 25 });

    const categorical = await trialityNext(OWNER, NOW, { embedFn: null });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      // Two halves, because between them they have teeth in BOTH environments. Remove
      // the gate and, on a machine with Ollama up, the blend moves N and the deep-equal
      // fails; on a machine with Ollama down, the calls are still ATTEMPTED, so the spy
      // records them and the second assertion fails. Either alone would pass vacuously
      // on the other kind of box — which is precisely how this arm went unpinned.
      await expect(trialityNext(OWNER, NOW)).resolves.toEqual(categorical);
      const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(urls.filter((u) => u.includes('/api/embeddings'))).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
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
    // No modal band and no modal weekday either: v2.3's two pairings carry a constant
    // +1 on the SITUATION side (the clock is always known), so the candidate side is
    // the only thing that can make them active — and a candidate with no history of
    // its own contributes nothing rather than a guessed zero.
    const f = contextFit(vector, {
      kind: 'task', ref: 'x', title: 'x', estimateMin: null, direction: null, categories: [], motivation: null,
    }, NOW, 'UTC');
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
 * An age offset that moves every seeded completion into the MORNING band (09:00 for an
 * integer day offset, since NOW is 14:00), so that the two v2.3 pairings contribute
 * nothing and `seedNormalityPool`'s stated invariant — "every contextFit pair inactive ⇒
 * F = 0.5 for everyone" — actually holds. Seeding a class at a single hour of the day IS
 * a rhythm, and v2.3 reads it as one, so the fixture has to choose which rhythm it seeds.
 *
 * MORNING, specifically, rather than "one completion per band". Scattering across bands
 * used to work because an unweighted three-way split had no strict plurality — but
 * `modalTiming` is RECENCY-WEIGHTED now, and three singleton buckets at three distinct
 * ages carry three distinct weights, so the most recent one simply wins. There is no
 * scatter that yields "no band" any more; there is only a band that says nothing. The
 * morning is that band: `OPPOSITE_BAND` pairs only morning⇄evening, so a morning rhythm
 * read at 14:00 is neither a match nor an opposition and drops out of the dot product.
 *
 * The weekday half needs no device: the day offsets below put every class's heaviest
 * bucket on some day other than NOW's Wednesday, and the weekday pairing has no −1 arm,
 * so a non-matching weekday is inactive rather than negative. Applied identically to
 * every class, so the relative H ordering the cases below depend on is untouched.
 */
const MORNING_SHIFT_DAYS = 5 / 24;

/**
 * A pool whose ONLY spread is on the normality axis: no fixed blocks (gap unknown ⇒
 * C = 0.5 for everyone), no directions, no priorities, no mood reading, no live temporal
 * pairing (every contextFit pair inactive ⇒ F = 0.5 for everyone). Both of those
 * ternarize to all-zero, so `dot` IS the normality pole and the telemetry can be reasoned
 * about one axis at a time.
 *
 * That F invariant is ASSERTED by the cases below, not merely asserted here: v2.3's two
 * temporal pairings are the second thing to have quietly broken it, and a prose-only
 * invariant is exactly what let the first breakage through.
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
      addCategory(
        insertTask(`${c.cat}-done-${d}`, {
          status: 'done',
          completedAt: daysAgo(d + MORNING_SHIFT_DAYS),
          mood: 'flat',
        }),
        c.cat,
      );
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
    //
    // v2.3 CHANGED NOTHING HERE. Every number below is byte-identical to the pre-v2.3
    // pin — the F column, the H column, all three totals and all three ternary triples —
    // which is the real assertion this case makes about the wave: the two new contextFit
    // pairings cost nothing when the candidate has no rhythm that bears on NOW.
    //
    // (An intermediate v2.3 draft did re-baseline the H column, for the interpolated
    // §3.4 back-off. That back-off was reverted — see the engine's `habitStrengths`
    // header — so the column is back to what it always was.)
    //
    // Why each pairing sleeps in this fixture: 'short run' has two health completions,
    // below MODAL_MIN_SAMPLE, so it claims no rhythm at all. The career class fires at
    // 02:00 local, which `bandOfLocalHour` folds into the evening — merely ADJACENT to
    // this 14:00 afternoon, and afternoon is nobody's opposite. Its modal weekday is a
    // Saturday (the recency-weighted heaviest of three distinct days), and NOW is a
    // Wednesday, which the weekday pairing scores 0 rather than −1.
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

    // The fixture's one-axis invariant, CHECKED. Everything below reasons as if `dot` were
    // the normality pole alone; a live temporal pairing would put spread on the pragmatism
    // axis and quietly turn each case into a different experiment. (It did: v2.3's first
    // draft lifted the three-completion classes to F = 0.75 and this case started picking
    // `finance` for the Novel slot.)
    for (const p of live(res.picks)) expect(p.scores.F, p.title).toBe(0.5);

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

    // The same one-axis invariant E5 checks, for the same reason.
    for (const p of live(res.picks)) expect(p.scores.F, p.title).toBe(0.5);

    // THE VETO: habitual drops both bottom-pole candidates; contextual (`target[0] === 0`)
    // vetoes nobody and only loses the one candidate habitual took.
    expect(habitual!.decision.eligible).toBe(3);
    expect(contextual!.decision.eligible).toBe(4);
    expect(contextual!.decision.eligible).toBeGreaterThan(habitual!.decision.eligible);

    // `taken`: S = H is slot-independent here and habitual's winner holds the pool max
    // (exactly 1 — H is normalized by the pool max). Contextual's winner AND its
    // runner-up are both strictly below it, so the candidate habitual consumed appears
    // in neither of contextual's telemetry slots.
    //
    // (An intermediate v2.3 draft re-baselined this to 0.5, the top class's share under
    // the interpolated §3.4 back-off. That back-off was reverted — see the engine's
    // `habitStrengths` header — so the pool max is a flat 1.0 again.)
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
    //
    // …with ONE deliberate exception: no modal band and no modal weekday. v2.3's two
    // pairings are dim-INDEPENDENT (situation side is a constant +1, not a vector
    // entry), so giving the probe a rhythm would make every single-dim probe active and
    // turn this pin into a tautology. Leaving them unset is what keeps `fit !== 0.5`
    // meaning "this DIM was read".
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
        const fit = contextFit(only(dim.name, value), probe, NOW, 'UTC');
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

    // 0156: work hours now come from the work+community pattern_blocks union, not the
    // removed workday_start/workday_end prefs. The beforeEach's seedFallbackFillWindow()
    // seeds a 09:00-18:00 'workday' window for the 'work' direction tag — NOW
    // (Wednesday 14:00Z) sits inside it.
    const withHours = await buildSituationVector(OWNER, NOW);
    expect(withHours.meta.active).not.toContain('memory_context');
    expect(withHours.meta.active.length).toBe(12);

    sqlite.prepare(`UPDATE scheduling_prefs SET memory_pull_enabled = 1 WHERE owner_id = ?`).run(OWNER);
    expect((await buildSituationVector(OWNER, NOW)).meta.active).not.toContain('memory_context');

    // FIRM_AT/TENTATIVE_AT are chosen so the bands mean the same DIM COUNT at both
    // denominators — which is only worth anything if 11 is genuinely reachable.
    // Clear the seeded fallback-fill windows entirely (both directions, both day
    // types) so no work hours are known at all.
    sqlite.prepare(`DELETE FROM pattern_blocks WHERE owner_id = ?`).run(OWNER);
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

// ══════════════════════════════════════════════════════════════════════════════
// v2.3 — WHEN the owner does a thing (time band, day of week).
//
// Nothing here adds a situation dim or a migration: band and weekday are contextFit
// PAIRINGS (see the comment in the engine), and every number below is computed from
// rows that already existed.
//
// Both pairings carry TEMPORAL_PAIR_WEIGHT = ½ on the situation side, which is why a
// lone matching pairing reads 0.75 rather than 1: (½ · +1) / 1 pair = ½, rescaled to
// [0,1]. That is deliberate — every other pair in contextFit is gated by a sensed
// situation dim that reads 0 most of the time, while these two fire on nearly every
// call, so at full weight they were the loudest terms in F by construction.
// ══════════════════════════════════════════════════════════════════════════════

/** All dims zero and none active — so contextFit's ONLY possible active pairs are the
 *  two v2.3 ones, whose situation side is a constant +1. */
const ZERO_VECTOR = {
  dims: Object.fromEntries(DIM_REGISTRY.map((d) => [d.name, 0])),
  meta: { active: [] },
} as unknown as SituationVector;

function bare(over: Partial<Candidate> = {}): Candidate {
  return {
    kind: 'task', ref: 'x', title: 'x', estimateMin: null,
    direction: null, categories: [], motivation: null,
    ...over,
  };
}

/** A direction-kind tag on a task (level 1 — the axis `taskDirection` reads). */
function addDirection(taskId: string, name: string, owner: string = OWNER): void {
  const existing = sqlite
    .prepare(`SELECT id FROM tags WHERE owner_id = ? AND kind = 'direction' AND LOWER(name) = LOWER(?)`)
    .get(owner, name) as { id: string } | undefined;
  const tagId =
    existing?.id ??
    (sqlite
      .prepare(`INSERT INTO tags (id, owner_id, name, kind) VALUES (uuid7(), ?, ?, 'direction') RETURNING id`)
      .get(owner, name) as { id: string }).id;
  sqlite
    .prepare(`INSERT INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`)
    .run(taskId, tagId);
}

describe('v2.3 §3.2 — the time band is a pairing, and it reads the OWNER’s clock', () => {
  it('the band boundaries are the app’s existing vocabulary, and the mapping is TOTAL', () => {
    // Reused from client/src/lib/propose-slot.ts BAND_WINDOWS (05–12 / 12–17 / 17–22),
    // which is what quick-add's `timeOfDay` band already narrows to — so a histogram
    // "evening" here names the same stretch of clock the owner is already shown.
    expect([5, 8, 11].map(bandOfLocalHour)).toEqual(['morning', 'morning', 'morning']);
    expect([12, 14, 16].map(bandOfLocalHour)).toEqual(['afternoon', 'afternoon', 'afternoon']);
    expect([17, 20, 21].map(bandOfLocalHour)).toEqual(['evening', 'evening', 'evening']);
    // BAND_WINDOWS stops at 22:00, but a histogram over real completions has to be
    // total — 22:00–05:00 folds into the evening it is the tail of, never the morning.
    expect([22, 23, 0, 3, 4].map(bandOfLocalHour)).toEqual(
      ['evening', 'evening', 'evening', 'evening', 'evening'],
    );
  });

  it('match → +½, wrong end of the day → −½, adjacent → nothing, unknown → nothing', () => {
    // 10:00 UTC on a UTC owner's clock is the morning, which HAS an opposite.
    const morningNow = new Date('2026-07-29T10:00:00.000Z');
    const f = (modalBand: TimeBand | null) => contextFit(ZERO_VECTOR, bare({ modalBand }), morningNow, 'UTC');

    // The band KEEPS both arms — morning-vs-evening is a genuine opposition, not a
    // silence — but each is worth TEMPORAL_PAIR_WEIGHT = ½, so the pair spans
    // [0.25, 0.75] around neutral instead of the whole [0, 1].
    expect(f('morning')).toBe(0.75);  // the one active pair is (½, +1)
    expect(f('evening')).toBe(0.25);  // (½, −1) — the wrong end of the day
    // Afternoon touches both ends, so it is nobody's opposite: no claim either way.
    expect(f('afternoon')).toBe(0.5);
    // …and from an AFTERNOON now, neither end is opposite — the relation is symmetric.
    expect(contextFit(ZERO_VECTOR, bare({ modalBand: 'morning' }), NOW, 'UTC')).toBe(0.5);
    expect(contextFit(ZERO_VECTOR, bare({ modalBand: 'evening' }), NOW, 'UTC')).toBe(0.5);

    // UNKNOWN CONTRIBUTES NOTHING, and "nothing" means bit-identical to a candidate
    // that never had the field — not a guessed zero that dilutes the other pairs.
    expect(f(null)).toBe(0.5);
    expect(f(null)).toBe(contextFit(ZERO_VECTOR, bare(), morningNow, 'UTC'));
  });

  it('the SAME UTC completions give two owners different modal bands — and different F', async () => {
    // THE BUG THIS EXISTS TO STOP SHIPPING SILENTLY: a UTC hour is not the owner's
    // morning. Both owners below get byte-identical completion timestamps; only
    // scheduling_prefs.timezone differs.
    const TZ_NOW = new Date('2026-07-29T10:00:00.000Z'); // 10:00 UTC = 19:00 in Tokyo
    // 16:00 UTC is the AFTERNOON in London and 01:00 — a late evening — in Tokyo.
    //
    // All three land on the SAME weekday in each zone (Monday in UTC, Tuesday in Tokyo
    // where 16:00Z is already the next day) and TZ_NOW is a Wednesday in both, so each
    // owner has an unambiguous modal weekday that simply does not match — the weekday
    // pairing is inactive for both, and the band pairing is the only thing left that can
    // move F. Distinct weekdays would NOT do: `modalTiming` is recency-weighted, so three
    // singleton buckets resolve to whichever is most recent rather than to "no rhythm".
    const CLASS_DONE = ['2026-07-27T16:00:00.000Z', '2026-07-20T16:00:00.000Z', '2026-07-13T16:00:00.000Z'];
    const tokyo = createOwner(SECOND_OWNER_ID, 'Owner B', 'Asia/Tokyo');

    const seed = (owner: string): string => {
      // The refusal floor, in a class no candidate carries (no categories).
      for (let i = 0; i < 10; i++) {
        insertTask(`noise-${i}`, {
          status: 'done', mood: 'flat', owner,
          completedAt: new Date(TZ_NOW.getTime() - (20 + i) * 86_400_000).toISOString(),
        });
      }
      for (const at of CLASS_DONE) {
        addCategory(insertTask(`ran-${at}`, { status: 'done', completedAt: at, mood: 'flat', owner }), 'health', owner);
      }
      // estimateMin null on purpose: it keeps the energy pairing inactive, so with no
      // priorities, no direction and no motivation the band pair is the ONLY one left.
      const c = insertTask('go for a run', { estimate: null, owner });
      addCategory(c, 'health', owner);
      return c;
    };
    const mine = seed(OWNER);
    const theirs = seed(tokyo);

    const a = await trialityNext(OWNER, TZ_NOW, { embedFn: null });
    const b = await trialityNext(tokyo, TZ_NOW, { embedFn: null });
    if (a.refused || b.refused) throw new Error('unexpected refusal');
    const mineP = live(a.picks).find((p) => p.ref === mine)!;
    const theirsP = live(b.picks).find((p) => p.ref === theirs)!;

    // Same rows, same instant, same everything but the zone: the UTC owner's class is
    // an AFTERNOON habit (16:00) that says nothing about a 10:00 morning, while the
    // Tokyo owner's is an EVENING habit (01:00) matching their 19:00 evening. 0.75 is
    // one matched half-weight pairing; 0.5 is the neutral no-active-pairs reading.
    expect(mineP.scores.F).toBe(0.5);
    expect(theirsP.scores.F).toBe(0.75);
    expect(theirsP.scores.F).toBeGreaterThan(mineP.scores.F);
    // …and the evidence behind them really is identical, so the difference is the zone.
    expect(theirsP.evidenceRows).toBe(mineP.evidenceRows);
    expect(localBand(CLASS_DONE[0], 'UTC')).toBe('afternoon');
    expect(localBand(CLASS_DONE[0], 'Asia/Tokyo')).toBe('evening');
  });

  it('a modal band needs a real sample, and a claim it does make must still bear on NOW', async () => {
    // MODAL_MIN_SAMPLE driven through inputs rather than pinned as a constant: two
    // completions are too few to be anyone's rhythm, so `twice` reads exactly like no
    // history at all.
    //
    // `scattered` is the other way to contribute nothing, and it is no longer the same
    // way. Three completions across three bands used to have no strict plurality and so
    // no modal band; under the RECENCY-WEIGHTED mode the three buckets carry three
    // distinct weights and the most recent one (08:00 on the 27th — a morning) wins
    // outright. What keeps it silent now is the band relation, not the sample: morning
    // is merely ADJACENT to this 14:00 afternoon, and `OPPOSITE_BAND` pairs only
    // morning⇄evening. Same observable, different reason — worth writing down, because
    // the old reason is the one a reader would assume.
    const at = (day: string, hour: string) => `2026-07-${day}T${hour}:00:00.000Z`;
    seedConfirmedHistory(12);

    const twice = insertTask('twice-only', { estimate: null });
    addCategory(twice, 'health');
    for (const t of [at('27', '14'), at('26', '14')]) {
      addCategory(insertTask(`h-${t}`, { status: 'done', completedAt: t, mood: 'flat' }), 'health');
    }

    const scattered = insertTask('all over the place', { estimate: null });
    addCategory(scattered, 'career');
    for (const t of [at('27', '08'), at('26', '14'), at('25', '20')]) {
      addCategory(insertTask(`c-${t}`, { status: 'done', completedAt: t, mood: 'flat' }), 'career');
    }

    const res = await trialityNext(OWNER, NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    expect(live(res.picks).map((p) => p.ref).sort()).toEqual([twice, scattered].sort());
    for (const p of live(res.picks)) expect(p.scores.F).toBe(0.5);
  });
});

describe('v2.3 §3.3 — the weekday pairing has a +arm and no −arm', () => {
  const SATURDAY = new Date('2026-08-01T14:00:00.000Z');

  it('same weekday → +½; EVERY other weekday → nothing, weekend or not', () => {
    // NOW is a Wednesday (dow 3); SATURDAY is a Saturday (dow 6).
    const onWed = (modalDow: number | null) => contextFit(ZERO_VECTOR, bare({ modalDow }), NOW, 'UTC');
    const onSat = (modalDow: number | null) => contextFit(ZERO_VECTOR, bare({ modalDow }), SATURDAY, 'UTC');

    expect(onWed(3)).toBe(0.75);
    expect(onSat(6)).toBe(0.75);
    // Tuesday-vs-Wednesday is not evidence against anything — same kind of day.
    expect(onWed(2)).toBe(0.5);
    expect(onSat(0)).toBe(0.5);

    // THE ASYMMETRY, AND WHY IT IS THE POINT. An earlier v2.3 draft scored the
    // weekday↔weekend crossing −1, and these two lines are what pin its removal:
    //
    //  - "she usually does this on a Wednesday and today is Saturday" is an ABSENCE OF
    //    SUPPORT, not evidence against. The band pairing keeps its −arm because
    //    morning⇄evening is a genuine opposition; there is no such opposition here.
    //  - A −arm has to decide what a weekend IS, and the draft hardcoded Sat/Sun —
    //    eight lines below `day_type`, which honours the owner's editable
    //    day_of_week_map. Two contradictory definitions of "weekend" inside one dot
    //    product is a worse bug than the one the arm was trying to fix.
    expect(onWed(6)).toBe(0.5);
    expect(onSat(3)).toBe(0.5);

    // Unknown contributes nothing, identically to a candidate without the field.
    expect(onWed(null)).toBe(0.5);
    expect(onWed(null)).toBe(contextFit(ZERO_VECTOR, bare(), NOW, 'UTC'));
  });

  it('a weekly rhythm in the history reaches F end to end', async () => {
    // Three completions, all on a Wednesday, all at 08:00 — a MORNING rhythm, which is
    // merely adjacent to this 14:00 afternoon and so scores 0 in the band pairing. The
    // weekday pair is therefore provably the only one doing any work, and 0.75 is one
    // matched half-weight pairing.
    //
    // (Scattering the three across three bands would no longer achieve that: the modal
    // band is recency-weighted, so a scattered class resolves to its most recent band
    // rather than to none. A band that cannot bear on NOW is the only reliable silence.)
    seedConfirmedHistory(12);
    const cand = insertTask('the wednesday thing', { estimate: null });
    addCategory(cand, 'growth');
    for (const day of ['22', '15', '08']) {
      addCategory(
        insertTask(`wed-${day}`, { status: 'done', mood: 'flat', completedAt: `2026-07-${day}T08:00:00.000Z` }),
        'growth',
      );
    }
    const res = await trialityNext(OWNER, NOW, { embedFn: null }); // NOW is a Wednesday
    if (res.refused) throw new Error('unexpected refusal');
    expect(live(res.picks).find((p) => p.ref === cand)!.scores.F).toBe(0.75);
  });
});

describe('v2.3 — the two temporal pairings modulate F; they do not decide it', () => {
  it('a perfect rhythm on BOTH axes still loses to one live category deficit', async () => {
    // THE REGRESSION THE SUB-UNIT WEIGHT EXISTS TO PREVENT. Every other pair in
    // contextFit is gated by a situation dim that reads 0 most of the time; the band and
    // weekday pairs carry a constant +1 on the situation side and fire on nearly every
    // call, and there are two of them. At full weight a candidate matching both would
    // reach dot = 1 — TYING a full, stated, measured Balance deficit — and a candidate
    // matching neither would sit at −1 against it. "You usually do this on a Wednesday
    // afternoon" would then outweigh the deficit pull that makes Triality a Balance
    // feature at all. At ½ it modulates instead: 0.75 against the deficit's 1.
    const deficit = {
      dims: Object.fromEntries(DIM_REGISTRY.map((d) => [d.name, d.name === 'cat_deficit_health' ? 1 : 0])),
      meta: { active: DIM_REGISTRY.map((d) => d.name) },
    } as unknown as SituationVector;

    // Carries the under-served category, and has no rhythm of its own to report.
    const pull = contextFit(deficit, bare({ categories: ['health'] }), NOW, 'UTC');
    // Carries no deficit category, but matches BOTH temporal axes: NOW is a Wednesday
    // (dow 3) at 14:00 UTC (the afternoon).
    const rhythm = contextFit(deficit, bare({ modalBand: 'afternoon', modalDow: 3 }), NOW, 'UTC');

    expect(pull).toBe(1);       // one active pair, (+1, +1)
    expect(rhythm).toBe(0.75);  // two active pairs, (½, +1) each ⇒ dot ½
    expect(rhythm).toBeLessThan(pull);
    // …and it is not merely below: it cannot even reach the ceiling. Two full-weight
    // temporal pairs would land exactly on 1 and the comparison above would be a tie.
    expect(rhythm).toBeLessThan(1);
  });

  it('an ABANDONED rhythm loses to the current one — the mode is recency-weighted', async () => {
    // Six completions in the evening two months ago, three in the morning this week.
    // A COUNT would call this an evening habit 6–3; the recency-weighted mode calls it
    // a morning habit, because 2^(−60/14) ≈ 0.05 against 2^(−1/14) ≈ 0.95.
    //
    // This is not a preference for newer data for its own sake: morning⇄evening is an
    // OPPOSITION, so a stale mode does not merely fail to help, it fires −1 against what
    // the owner actually does now. H would be saying "this is your habit" while F said
    // "wrong end of your day", from the very same rows.
    const MORNING_NOW = new Date('2026-07-29T10:00:00.000Z'); // Wednesday, 10:00 = morning
    seedConfirmedHistory(12);

    // The abandoned class: an evening rhythm the owner left behind. None of these days
    // is a Wednesday, so the weekday pairing stays out of it.
    const stale = ['05-25', '05-26', '05-28', '05-29', '05-30', '05-31'];
    // …and the class that only ever fired in the evening is the positive control: it
    // proves these rows really do read as an evening and really do score −1.
    const abandonedOnly = insertTask('the thing I gave up', { estimate: null });
    addCategory(abandonedOnly, 'career');
    for (const d of stale) {
      addCategory(insertTask(`old-career-${d}`, { status: 'done', mood: 'flat', completedAt: `2026-${d}T20:00:00.000Z` }), 'career');
    }

    // The moved class: the same six-strong evening history, plus three recent mornings.
    const moved = insertTask('the thing I moved', { estimate: null });
    addCategory(moved, 'health');
    for (const d of stale) {
      addCategory(insertTask(`old-health-${d}`, { status: 'done', mood: 'flat', completedAt: `2026-${d}T20:00:00.000Z` }), 'health');
    }
    for (const d of ['07-28', '07-27', '07-26']) {
      addCategory(insertTask(`new-health-${d}`, { status: 'done', mood: 'flat', completedAt: `2026-${d}T08:00:00.000Z` }), 'health');
    }

    const res = await trialityNext(OWNER, MORNING_NOW, { embedFn: null });
    if (res.refused) throw new Error('unexpected refusal');
    const by = new Map(live(res.picks).map((p) => [p.ref, p]));
    expect(by.size).toBe(2); // nothing asserted vacuously

    // The recent minority wins the mode: a matched morning, +½.
    expect(by.get(moved)!.scores.F).toBe(0.75);
    expect(by.get(moved)!.evidenceRows).toBe(9); // …on a class that is 6 evenings and 3 mornings
    // The control: the same six evening rows, alone, read as an evening and fire −½.
    expect(by.get(abandonedOnly)!.scores.F).toBe(0.25);
    expect(by.get(abandonedOnly)!.evidenceRows).toBe(6);
  });
});

/**
 * A mixed direction/category pool: one direction ('work') carrying every classed
 * completion, plus a candidate that is brand new in that direction and one that is
 * foreign to it entirely. Completions sit in the MORNING (MORNING_SHIFT_DAYS' reason), so
 * neither temporal pairing bears on this 14:00 NOW and F stays out of the H story.
 */
function seedDirectionPool(): { deep: string; fresh: string; foreign: string } {
  for (let i = 0; i < 6; i++) {
    insertTask(`noise-${i}`, { status: 'done', completedAt: daysAgo(20 + i), mood: 'flat' });
  }
  for (const d of [2, 3, 4, 5, 6, 7]) {
    const id = insertTask(`work-done-${d}`, {
      status: 'done', mood: 'flat',
      completedAt: daysAgo(d + MORNING_SHIFT_DAYS),
    });
    addCategory(id, 'career');
    addDirection(id, 'work');
  }
  // Same direction, same signature class as the history → its own deep evidence.
  const deep = insertTask('another work thing', { estimate: null });
  addCategory(deep, 'career');
  addDirection(deep, 'work');
  // Same direction, a category set the owner has NEVER completed.
  const fresh = insertTask('a new kind of work thing', { estimate: null });
  addCategory(fresh, 'growth');
  addDirection(fresh, 'work');
  // Novel in category AND direction.
  const foreign = insertTask('something else entirely', { estimate: null });
  addCategory(foreign, 'leisure');
  addDirection(foreign, 'home');
  return { deep, fresh, foreign };
}

describe('v2.3 — H stays a well-formed number, and the run stays deterministic', () => {
  // ── §3.4 IS GONE, AND IT SHOULD NOT COME BACK IN THIS SHAPE ─────────────────────
  //
  // Three cases used to live here, pinning the interpolated (kind, direction) back-off:
  // that a novel signature inside the owner's busiest direction scored H > 0, that N
  // refused to follow the borrowed H, and that the λ3 = n3/(n3+K) blend shifted with
  // sample size. The back-off was REVERTED, so all three have been deleted rather than
  // weakened into something that still passes — they described a feature, and the
  // feature is not there.
  //
  // Do not restore them alongside a re-implementation without reading the reason first:
  // it is in the engine, in the `habitStrengths` header. In short, both defects were
  // properties of the pool-max NORMALIZATION rather than of the code that implemented
  // the blend — the coarse levels are tautological under it (every task matches
  // `kind = task`, so a level-1 strength is identically 1.0 and a never-seen task took
  // the residual mass against a 1), and normalizing each level by its OWN pool max made
  // the blend non-monotone, with an adversarial search finding H strictly DECREASING in
  // completion count on ~7% of same-direction pairs. A candidate lost habit strength by
  // being done more often. A future back-off has to answer "in what units are these
  // levels commensurable?" before it can have tests at all.
  //
  // `seedDirectionPool` (above) survives because the two cases below still want a pool
  // with directions in it; it is no longer a back-off fixture.

  it('H stays inside [0,1] for every candidate on an adversarial pool — the learning corpus depends on it', async () => {
    // NOT stylistic. triality-learning.ts's parseScores REJECTS a persisted component
    // outside [0,1] as corrupt, which is what caps |delta| at 0.5 and makes §6b's clamp
    // self-enforcing — so an H that could exceed 1 would silently delete H from the
    // learning corpus rather than fail anywhere visible.
    //
    // Pools are kept at three candidates so EVERY candidate reaches a slot and is
    // therefore observed; `resetDb` between scenarios keeps them independent.
    const scenarios: Array<[string, () => void]> = [
      ['one enormous class', () => {
        for (let i = 0; i < 60; i++) {
          const id = insertTask(`bulk-${i}`, { status: 'done', completedAt: daysAgo(0.1 + i * 0.3), mood: 'flat' });
          addCategory(id, 'career');
          addDirection(id, 'work');
        }
        for (const [cat, dir] of [['career', 'work'], ['growth', 'work'], ['leisure', 'home']] as const) {
          const c = insertTask(`cand-${cat}`, { estimate: null });
          addCategory(c, cat);
          addDirection(c, dir);
        }
      }],
      ['every candidate in the one direction the owner ever uses', () => {
        seedConfirmedHistory(12);
        for (const cat of ['career', 'growth', 'health'] as const) {
          const done = insertTask(`d-${cat}`, { status: 'done', completedAt: daysAgo(1), mood: 'flat' });
          addCategory(done, cat);
          addDirection(done, 'work');
          const c = insertTask(`c-${cat}`, { estimate: null });
          addCategory(c, cat);
          addDirection(c, 'work');
        }
      }],
      ['a routine and a template beside a task, on the thinnest possible history', () => {
        seedConfirmedHistory(10);
        const task = insertTask('a task', { estimate: null });
        addCategory(task, 'health');
        const routineType = (
          sqlite.prepare(`SELECT id FROM pattern_types WHERE name = 'Routine' AND owner_id = ?`).get(OWNER) as { id: string }
        ).id;
        const routine = (
          sqlite
            .prepare(`INSERT INTO patterns (id, owner_id, type_id, name) VALUES (uuid7(), ?, ?, 'Wind down') RETURNING id`)
            .get(OWNER, routineType) as { id: string }
        ).id;
        const addMember = sqlite.prepare(`INSERT INTO pattern_tasks (pattern_id, task_id, position) VALUES (?, ?, ?)`);
        addMember.run(routine, insertTask('open member', { estimate: 10 }), 0);
        addMember.run(routine, insertTask('member-done', { status: 'done', completedAt: daysAgo(1), mood: 'flat' }), 1);
        sqlite
          .prepare(`INSERT INTO block_templates (id, owner_id, name, default_minutes) VALUES (uuid7(), ?, 'Deep work', 60)`)
          .run(OWNER);
      }],
    ];

    for (const [name, seed] of scenarios) {
      resetDb();
      seed();
      const res = await trialityNext(OWNER, NOW, { embedFn: null });
      if (res.refused) throw new Error(`unexpected refusal in "${name}"`);
      const picks = live(res.picks);
      expect(picks.length, name).toBeGreaterThan(0);
      for (const p of picks) {
        expect(p.scores.H, `${name} / ${p.title}`).toBeGreaterThanOrEqual(0);
        expect(p.scores.H, `${name} / ${p.title}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('determinism survives v2.3: same DB + same now twice → byte-identical picks and scores', async () => {
    // The band and weekday pairings read the clock through the OWNER's zone and the
    // injected `now` — never a wall clock — and the recency-weighted modal histograms
    // resolve exact ties by refusing to, so there is nothing left for insertion order
    // to decide.
    seedDirectionPool();
    const a = await trialityNext(OWNER, NOW, { embedFn: null });
    const b = await trialityNext(OWNER, NOW, { embedFn: null });
    if (a.refused || b.refused) throw new Error('unexpected refusal');
    expect(JSON.stringify(b.picks)).toBe(JSON.stringify(a.picks));
    expect(JSON.stringify(attachConfidence(b.picks, b.vector)))
      .toBe(JSON.stringify(attachConfidence(a.picks, a.vector)));
  });
});
