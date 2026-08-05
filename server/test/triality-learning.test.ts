import { describe, it, expect, beforeEach } from 'vitest';
import { flushAudits } from '../src/lib/audit.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  DEFAULT_WEIGHTS, SLOTS, getWeights, trialityNext, type ScoredPick, type Slot, type SlotWeights,
} from '../src/services/triality.js';
import {
  calibrateTriality, applyUpdateRule, collapseImpressions, componentDeltas, rowReward,
  LEARNING_WINDOW_DAYS, OUTCOME_FLOOR, PENDING_MS, LEARNING_FACTOR, CLAMP_LO, CLAMP_HI, REWARDS,
  type Component,
} from '../src/services/triality-learning.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';

/**
 * Triality T8 — the learning loop (design §6b).
 *
 * Fixture style: raw sqlite inserts against the shared sequential DB, a frozen
 * `NOW`, TZ=UTC. Every timestamp is derived from NOW, never a literal date.
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-07-29T14:00:00.000Z'); // a Wednesday inside the pinned 09–18 workday

const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const msAgo = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

type ScoreFixture = Record<string, unknown> | string;

/**
 * `action_ref` defaults to a FRESH value per row, because learning collapses one
 * (slot, action_ref, local_date) group to a single vote (collapseImpressions). A
 * shared literal ref would silently make N fixture rows one piece of evidence —
 * so "distinct suggestions" is the default and re-using a ref is opt-in, which is
 * exactly how the dedup tests below distinguish themselves from every other test.
 */
let refSeq = 0;

/**
 * An explicit, lexicographically ASCENDING id. Needed because the learning read is
 * `ORDER BY id ASC` and `uuid7()` only orders across MILLISECONDS — its low 74 bits
 * are random, so a fixture loop that inserts several rows inside one millisecond
 * gets an arbitrary id order. Any test whose meaning depends on "earliest first"
 * (collapseImpressions) or on float summation order (byte-identical weights) mints
 * its own ids rather than relying on that. The `00000001` prefix sorts below every
 * real uuid7 (they start `019f…` at this era), so mixing is safe.
 */
const seqId = (n: number) => `00000001-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** One triality_log row. `scores` may be a raw string so malformed JSON is testable. */
function logRow(
  o: {
    owner?: string; slot?: Slot; outcome?: string; scores?: ScoreFixture; ageDays?: number;
    shownAt?: string; ref?: string; localDate?: string; id?: string;
  },
): string {
  const shownAt = o.shownAt ?? daysAgo(o.ageDays ?? 3);
  const outcome = o.outcome ?? 'staged';
  const scores = typeof o.scores === 'string' ? o.scores : JSON.stringify(o.scores ?? { F: 0.5, H: 0.5, Q: 0.5, N: 0.5, C: 0.5 });
  return (
    sqlite
      .prepare(
        `INSERT INTO triality_log (id, owner_id, shown_at, local_date, slot, action_kind, action_ref, scores, outcome, outcome_at)
         VALUES (COALESCE(?, uuid7()), ?, ?, ?, ?, 'task', ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        o.id ?? null, o.owner ?? OWNER, shownAt, o.localDate ?? shownAt.slice(0, 10), o.slot ?? 'habitual',
        o.ref ?? `ref-${++refSeq}`, scores, outcome, outcome === 'shown' ? null : shownAt,
      ) as { id: string }
  ).id;
}

function logRows(n: number, o: Parameters<typeof logRow>[0]): string[] {
  return Array.from({ length: n }, () => logRow(o));
}

/** The stored row for one slot (null = no row ⇒ the slot is on §5 defaults). */
function storedRow(slot: Slot, owner = OWNER): { weights: string; sample_count: number; computed_date: string } | null {
  return (
    (sqlite
      .prepare(`SELECT weights, sample_count, computed_date FROM triality_weights WHERE owner_id = ? AND slot = ?`)
      .get(owner, slot) as { weights: string; sample_count: number; computed_date: string } | undefined) ?? null
  );
}

const COMPONENTS: Component[] = ['F', 'H', 'Q', 'N', 'C'];
const sumOf = (w: SlotWeights) => COMPONENTS.reduce((s, k) => s + w[k], 0);

/**
 * The canonical "F earned it" fixture: high-F picks accepted, low-F picks rejected.
 * `n` rows of each half, so 2n decided rows for the slot.
 */
function seedCovaryingLog(
  o: { slot?: Slot; n?: number; highOutcome?: string; lowOutcome?: string; owner?: string; component?: Component } = {},
): void {
  const n = o.n ?? OUTCOME_FLOOR / 2;
  const k = o.component ?? 'F';
  const base = { F: 0.5, H: 0.5, Q: 0.5, N: 0.5, C: 0.5 };
  for (let i = 0; i < n; i++) {
    logRow({ ...o, outcome: o.highOutcome ?? 'staged', scores: { ...base, [k]: 1 }, ageDays: 3 + i });
    logRow({ ...o, outcome: o.lowOutcome ?? 'dismissed', scores: { ...base, [k]: 0 }, ageDays: 3 + i });
  }
}

beforeEach(() => {
  resetDb();
});

describe('constants (§6b — cited, never configurable)', () => {
  it('match the design doc', () => {
    expect(LEARNING_WINDOW_DAYS).toBe(90);
    expect(OUTCOME_FLOOR).toBe(20);
    expect(PENDING_MS).toBe(24 * 3_600_000);
    expect(LEARNING_FACTOR).toBe(0.5);
    expect([CLAMP_LO, CLAMP_HI]).toEqual([0.5, 2]);
    expect(REWARDS).toEqual({ staged: 1, opened: 0.5, dismissed: -1, ignored: -0.25 });
  });
});

describe('determinism', () => {
  it('same log fixture twice → float-exact identical stored weights', async () => {
    seedCovaryingLog();
    seedCovaryingLog({ slot: 'novel', highOutcome: 'opened', lowOutcome: 'shown', component: 'N' });
    const first = await calibrateTriality(OWNER, NOW);
    const rowsFirst = (['habitual', 'contextual', 'novel'] as Slot[]).map((s) => storedRow(s));
    const second = await calibrateTriality(OWNER, NOW);
    const rowsSecond = (['habitual', 'contextual', 'novel'] as Slot[]).map((s) => storedRow(s));
    expect(second).toEqual(first);
    expect(rowsSecond).toEqual(rowsFirst); // raw JSON strings — byte-for-byte, not "close enough"
  });
});

describe('reward map (§6b)', () => {
  it('rowReward maps each outcome and treats a fresh shown row as pending (null)', () => {
    expect(rowReward('staged', daysAgo(2), NOW)).toBe(1);
    expect(rowReward('opened', daysAgo(2), NOW)).toBe(0.5);
    expect(rowReward('dismissed', daysAgo(2), NOW)).toBe(-1);
    // The metrics boundary, exactly: strictly younger than 24h is undecided.
    expect(rowReward('shown', msAgo(PENDING_MS), NOW)).toBe(-0.25);
    expect(rowReward('shown', msAgo(PENDING_MS - 1), NOW)).toBeNull();
    expect(rowReward('nonsense', daysAgo(2), NOW)).toBeNull();
    expect(rowReward('shown', 'not-a-date', NOW)).toBeNull();
  });

  it('each outcome kind moves the learned weight in the documented direction', async () => {
    // A single outcome kind cannot be isolated: delta is a COVARIANCE, so a log with
    // uniform reward yields exactly 0. Each kind is therefore measured against the
    // same contrast group (10 low-F `opened` rows), which orders them by reward.
    const learnedF = async (outcome: string): Promise<number> => {
      resetDb();
      for (let i = 0; i < 10; i++) {
        logRow({ outcome, scores: { F: 1, H: 0.5, Q: 0.5 }, ageDays: 3 + i });
        logRow({ outcome: 'opened', scores: { F: 0, H: 0.5, Q: 0.5 }, ageDays: 3 + i });
      }
      await calibrateTriality(OWNER, NOW);
      return (await getWeights(OWNER, 'habitual')).F;
    };
    const staged = await learnedF('staged');
    const opened = await learnedF('opened');
    const ignored = await learnedF('shown');   // >24h old ⇒ ignored, weak negative
    const dismissed = await learnedF('dismissed');
    const dflt = DEFAULT_WEIGHTS.habitual.F;

    expect(staged).toBeGreaterThan(dflt);
    expect(opened).toBeCloseTo(dflt, 12);            // same reward as the contrast ⇒ no signal
    expect(ignored).toBeLessThan(dflt);
    expect(dismissed).toBeLessThan(ignored);         // −1 bites harder than −0.25
    expect(staged).toBeGreaterThan(opened);
  });

  it('a fresh shown row is excluded from BOTH the sample count and the math', async () => {
    seedCovaryingLog();                                       // 20 decided rows
    const decidedOnly = await calibrateTriality(OWNER, NOW);
    const weightsDecidedOnly = storedRow('habitual')!.weights;

    logRows(6, { outcome: 'shown', scores: { F: 1, H: 0, Q: 0 }, ageDays: 0.25 }); // pending
    const withPending = await calibrateTriality(OWNER, NOW);
    expect(withPending.outcomeRows).toBe(decidedOnly.outcomeRows);
    expect(storedRow('habitual')!.sample_count).toBe(OUTCOME_FLOOR);
    expect(storedRow('habitual')!.weights).toBe(weightsDecidedOnly); // math untouched
  });
});

// ── One vote per suggestion per day (collapseImpressions) ─────────────────────

/** A bare collapseImpressions input row — no DB, so id order is explicit. */
function impression(
  o: { id: string; outcome?: string; shownAt?: string; slot?: string; ref?: string; day?: string; scores?: string },
): { id: string; slot: string; outcome: string; shown_at: string; scores: string; action_ref: string; local_date: string } {
  return {
    id: o.id,
    slot: o.slot ?? 'habitual',
    outcome: o.outcome ?? 'shown',
    shown_at: o.shownAt ?? daysAgo(3),
    scores: o.scores ?? '{"F":0.5}',
    action_ref: o.ref ?? 'task-1',
    local_date: o.day ?? daysAgo(3).slice(0, 10),
  };
}

describe('collapseImpressions (§6b — UI remounts are not evidence)', () => {
  it('a decision beats any number of impressions in its group', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => impression({ id: `s${i}` })),
      impression({ id: 'decided', outcome: 'staged' }),
    ];
    const out = collapseImpressions(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('decided');
    expect(out[0]!.outcome).toBe('staged');
  });

  it('a group of only impressions collapses to the EARLIEST row, proven by its reward', () => {
    // Rows arrive in id order == insertion order == time order (uuid7). Both rows
    // are on the SAME owner-local day, but the first is 37.5h old (⇒ ignored, a real
    // weak-negative vote) and the remount is 14.5h old (⇒ pending, no vote at all).
    // Which row represents the group is therefore visible in the reward, not just
    // in an id.
    const earliest = msAgo(37.5 * 3_600_000);
    const remount = msAgo(14.5 * 3_600_000);
    expect(earliest.slice(0, 10)).toBe(remount.slice(0, 10)); // same day, either side of 24h
    const out = collapseImpressions([
      impression({ id: 'a', shownAt: earliest }),
      impression({ id: 'b', shownAt: remount }),
      impression({ id: 'c', shownAt: remount }),
    ]);
    expect(out.map((r) => r.id)).toEqual(['a']);
    expect(rowReward(out[0]!.outcome, out[0]!.shown_at, NOW)).toBe(REWARDS.ignored);
    expect(rowReward('shown', remount, NOW)).toBeNull(); // had the remount won: no vote
  });

  it('the group key is (slot, action_ref, local_date) — any difference is a separate vote', () => {
    const out = collapseImpressions([
      impression({ id: '1' }),
      impression({ id: '2', slot: 'novel' }),
      impression({ id: '3', ref: 'task-2' }),
      impression({ id: '4', day: daysAgo(4).slice(0, 10) }),
      impression({ id: '5' }), // duplicate of #1 — the only row that collapses away
    ]);
    expect(out.map((r) => r.id)).toEqual(['1', '2', '3', '4']); // first-seen order preserved
  });

  it('earliest-wins survives the DB read: the group votes as one IGNORED row', async () => {
    // 19 real decided rows — one short of the floor. A 4-remount group on a single
    // day supplies the 20th ONLY if the earliest row represents it (37.5h ⇒ ignored);
    // if the latest remount won, the group would read pending and nothing is written.
    for (let i = 0; i < 19; i++) {
      logRow({ outcome: i % 2 === 0 ? 'staged' : 'dismissed', scores: { F: i % 2, H: 0.5, Q: 0.5 }, ageDays: 3 + i });
    }
    [37.5, 20, 16, 14.5].forEach((hours, i) => {
      logRow({
        id: seqId(100 + i), outcome: 'shown', ref: 'remounted',
        shownAt: msAgo(hours * 3_600_000), scores: { F: 0.5, H: 0.5, Q: 0.5 },
      });
    });
    const r = await calibrateTriality(OWNER, NOW);
    expect(r.outcomeRows).toBe(20); // 19 + the group's single ignored vote
    expect(storedRow('habitual')!.sample_count).toBe(20);
  });

  it('25 impressions of ONE suggestion on ONE day cannot clear the floor', async () => {
    // The bug this closes: navigation manufacturing evidence. 25 rows, all >24h old
    // so each WOULD be an `ignored` vote on its own, but they are one suggestion on
    // one day ⇒ one vote ⇒ nowhere near OUTCOME_FLOOR, so no row is written and the
    // metrics tile cannot claim "learned from 25 samples" for an owner who never
    // gave one.
    for (let i = 0; i < 25; i++) {
      logRow({ outcome: 'shown', ref: 'same-task', shownAt: msAgo((72 + i / 60) * 3_600_000) });
    }
    const r = await calibrateTriality(OWNER, NOW);
    expect(r.outcomeRows).toBe(1);
    expect(r.slotsWritten).toBe(0);
    expect(r.slotsFloored).toBe(3);
    expect(storedRow('habitual')).toBeNull();
    expect(await getWeights(OWNER, 'habitual')).toEqual(DEFAULT_WEIGHTS.habitual);
  });

  it('the SAME suggestion on 20 different days is 20 votes', async () => {
    // The other half of the rule: the collapse is per DAY, so genuine repeat
    // engagement with one recurring action is genuine repeat evidence.
    for (let i = 0; i < 20; i++) logRow({ outcome: 'staged', ref: 'daily-thing', ageDays: 3 + i });
    const r = await calibrateTriality(OWNER, NOW);
    expect(r.outcomeRows).toBe(20);
    expect(r.slotsWritten).toBe(1);
    expect(storedRow('habitual')!.sample_count).toBe(20);
  });

  it('extra impressions of an already-decided suggestion change NOTHING (byte-identical)', async () => {
    // The counterexample that motivated the fix. 10 staged @F=0.6 + 10 dismissed
    // @F=0.5, all distinct suggestions ⇒ 20 votes and delta_F = +0.05.
    // Explicit ascending ids: byte-identity is an assertion about float summation
    // order, so the row order the engine reads must be pinned, not left to uuid7's
    // random intra-millisecond tail.
    const stagedRefs: string[] = [];
    for (let i = 0; i < 10; i++) {
      const ref = `up-${i}`;
      stagedRefs.push(ref);
      logRow({ id: seqId(2 * i), outcome: 'staged', ref, scores: { F: 0.6, H: 0.5, Q: 0.5 }, ageDays: 3 + i });
      logRow({ id: seqId(2 * i + 1), outcome: 'dismissed', ref: `down-${i}`, scores: { F: 0.5, H: 0.5, Q: 0.5 }, ageDays: 3 + i });
    }
    const firstRun = await calibrateTriality(OWNER, NOW);
    const W = storedRow('habitual')!;
    expect(W.sample_count).toBe(20);

    // 40 remounts of ONE of those suggestions, on the day it was already decided.
    const victim = stagedRefs[0]!;
    const victimDay = daysAgo(3).slice(0, 10);
    for (let i = 0; i < 40; i++) {
      logRow({
        id: seqId(100 + i), outcome: 'shown', ref: victim, localDate: victimDay,
        shownAt: msAgo((72 + (i + 1) / 60) * 3_600_000), scores: { F: 0.6, H: 0.5, Q: 0.5 },
      });
    }
    const secondRun = await calibrateTriality(OWNER, NOW);
    expect(secondRun).toEqual(firstRun);
    const after = storedRow('habitual')!;
    expect(after.sample_count).toBe(20);        // NOT 60
    expect(after.weights).toBe(W.weights);      // raw JSON — byte-for-byte identical
    expect(after.computed_date).toBe(W.computed_date);

    // What the uncollapsed corpus WOULD have produced, spelled out: 60 rows and a
    // delta_F diluted 3.6× (the 40 ignored votes at the above-mean F exactly cancel
    // the 10 staged ones, leaving only the dismissed half's signal).
    const real = [
      ...Array.from({ length: 10 }, () => ({ reward: REWARDS.staged, scores: { F: 0.6 } })),
      ...Array.from({ length: 10 }, () => ({ reward: REWARDS.dismissed, scores: { F: 0.5 } })),
    ];
    const padded = [...real, ...Array.from({ length: 40 }, () => ({ reward: REWARDS.ignored, scores: { F: 0.6 } }))];
    expect(componentDeltas(real).F).toBeCloseTo(0.05, 12);
    expect(componentDeltas(padded).F).toBeCloseTo(0.05 / 3.6, 12);
  });

  it('impression padding can invert a component outright — sign, not just magnitude', () => {
    // Same shape with the negative half replaced by a WEAKER positive (`opened`):
    // 40 remounts of the high-F pick flip delta_F from + to −, i.e. the learned
    // weight would move the wrong way. Pure arithmetic on the update rule, so it
    // states the stake without depending on a fixture the collapse now prevents.
    const real = [
      ...Array.from({ length: 10 }, () => ({ reward: REWARDS.staged, scores: { F: 0.6 } })),
      ...Array.from({ length: 10 }, () => ({ reward: REWARDS.opened, scores: { F: 0.5 } })),
    ];
    const padded = [...real, ...Array.from({ length: 40 }, () => ({ reward: REWARDS.ignored, scores: { F: 0.6 } }))];
    expect(componentDeltas(real).F).toBeGreaterThan(0);
    expect(componentDeltas(padded).F).toBeLessThan(0);
  });
});

describe('clamps + renormalization (the §6b contract)', () => {
  it('an adversarial delta pins each weight at its multiplicative bound', () => {
    const huge = Object.fromEntries(COMPONENTS.map((k) => [k, 1000])) as Record<Component, number>;
    const tiny = Object.fromEntries(COMPONENTS.map((k) => [k, -1000])) as Record<Component, number>;
    for (const slot of ['habitual', 'contextual', 'novel'] as Slot[]) {
      const up = applyUpdateRule(slot, huge)!;
      const down = applyUpdateRule(slot, tiny)!;
      for (const k of COMPONENTS) {
        const d = DEFAULT_WEIGHTS[slot][k];
        expect(up.clamped[k]).toBe(CLAMP_HI * d);
        expect(down.clamped[k]).toBe(CLAMP_LO * d);
        expect(up.clamped[k]).toBeLessThanOrEqual(CLAMP_HI * d);
        expect(down.clamped[k]).toBeGreaterThanOrEqual(CLAMP_LO * d);
      }
      // …and the renormalization hands every-weight-at-a-bound straight back to the
      // defaults: emphasis is learnable, total magnitude is not.
      for (const k of COMPONENTS) {
        expect(up.weights[k]).toBeCloseTo(DEFAULT_WEIGHTS[slot][k], 12);
        expect(down.weights[k]).toBeCloseTo(DEFAULT_WEIGHTS[slot][k], 12);
      }
    }
  });

  it('a uniform-reward log (all dismissed) leaves the defaults standing', async () => {
    // The honest consequence of a covariance rule: blame spread evenly over every
    // pick says nothing about WHICH component earned it, so nothing moves.
    for (let i = 0; i < OUTCOME_FLOOR; i++) {
      logRow({ outcome: 'dismissed', scores: { F: i / OUTCOME_FLOOR, H: 1 - i / OUTCOME_FLOOR, Q: 0.5 }, ageDays: 3 + i });
    }
    const r = await calibrateTriality(OWNER, NOW);
    expect(r.slotsWritten).toBe(1);
    const w = await getWeights(OWNER, 'habitual');
    for (const k of COMPONENTS) expect(w[k]).toBeCloseTo(DEFAULT_WEIGHTS.habitual[k], 12);
  });

  it('out-of-range scores are ABSENT, so their components keep their defaults', async () => {
    // Every engine component is provably in [0,1], so a stored 1e6 is a corrupt or
    // hand-edited row, not a score. parseScores rejects it, which is what caps
    // |delta_k| at 0.5 by construction — the clamp never has to save us from a
    // pathological magnitude, because one can no longer reach the update rule.
    for (let i = 0; i < 10; i++) {
      logRow({ outcome: 'staged', scores: { F: 1e6, H: -1e6, Q: 0.5 }, ageDays: 3 + i });
      logRow({ outcome: 'dismissed', scores: { F: -1e6, H: 1e6, Q: 0.5 }, ageDays: 3 + i });
    }
    await calibrateTriality(OWNER, NOW);
    // The rows are still DECIDED outcomes — they count toward the floor, they just
    // vote on nothing. (Q is in range but constant ⇒ zero covariance either way.)
    expect(storedRow('habitual')!.sample_count).toBe(OUTCOME_FLOOR);
    const w = await getWeights(OWNER, 'habitual');
    for (const k of COMPONENTS) expect(w[k]).toBeCloseTo(DEFAULT_WEIGHTS.habitual[k], 12);
    expect(sumOf(w)).toBeCloseTo(sumOf(DEFAULT_WEIGHTS.habitual), 12);
    for (const k of COMPONENTS) {
      expect(w[k]).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(w[k])).toBe(true);
    }
  });

  it('IN-RANGE extremes (0 vs 1, opposing rewards) DO move the weights', async () => {
    // The strongest signal the engine can legitimately emit: perfect anti-correlated
    // pair of components at the ends of their real range. delta reaches ±0.5 here,
    // its maximum possible magnitude given |reward| ≤ 1 and s ∈ [0,1].
    for (let i = 0; i < 10; i++) {
      logRow({ outcome: 'staged', scores: { F: 1, H: 0, Q: 0.5 }, ageDays: 3 + i });
      logRow({ outcome: 'dismissed', scores: { F: 0, H: 1, Q: 0.5 }, ageDays: 3 + i });
    }
    await calibrateTriality(OWNER, NOW);
    const w = await getWeights(OWNER, 'habitual');
    expect(w.F).toBeCloseTo(0.5, 12);  // 0.40 · (1 + 0.5·+0.5), sum already 1.0
    expect(w.H).toBeCloseTo(0.3, 12);  // 0.40 · (1 + 0.5·−0.5)
    expect(w.F).toBeGreaterThan(DEFAULT_WEIGHTS.habitual.F);
    expect(w.H).toBeLessThan(DEFAULT_WEIGHTS.habitual.H);
    expect(sumOf(w)).toBeCloseTo(sumOf(DEFAULT_WEIGHTS.habitual), 12);
    for (const k of COMPONENTS) {
      expect(w[k]).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(w[k])).toBe(true);
    }
  });

  it('every STORED weight stays inside its multiplicative bounds, for every slot', async () => {
    // Asserted on what is WRITTEN, not on the intermediate `clamped` object: the
    // §6b contract is about the row scoring reads back, and renormalization happens
    // AFTER the clamp, so only the stored value can prove the contract holds.
    //
    // This fixture is the provable worst case: every component sits at an end of
    // [0,1] and flips with the reward, so |delta_k| = 0.5 for all five at once —
    // per-weight multiplier 1 ± 0.25, and post-renormalization the ratio to default
    // can reach at most 1.25/0.75 = 1.667. Comfortably inside [0.5, 2].
    for (const slot of SLOTS) {
      for (let i = 0; i < 10; i++) {
        logRow({ slot, outcome: 'staged', scores: { F: 1, H: 0, Q: 1, N: 0, C: 1 }, ageDays: 3 + i });
        logRow({ slot, outcome: 'dismissed', scores: { F: 0, H: 1, Q: 0, N: 1, C: 0 }, ageDays: 3 + i });
      }
    }
    expect((await calibrateTriality(OWNER, NOW)).slotsWritten).toBe(3);
    for (const slot of SLOTS) {
      const stored = JSON.parse(storedRow(slot)!.weights) as SlotWeights;
      expect(sumOf(stored)).toBeCloseTo(sumOf(DEFAULT_WEIGHTS[slot]), 12);
      for (const k of COMPONENTS) {
        const d = DEFAULT_WEIGHTS[slot][k];
        if (d === 0) {
          expect(stored[k]).toBe(0); // a 0 default is 0 forever — the slot's character
          continue;
        }
        expect(stored[k]).toBeGreaterThanOrEqual(CLAMP_LO * d);
        expect(stored[k]).toBeLessThanOrEqual(CLAMP_HI * d);
      }
    }
  });
});

describe('zero-default invariance (a slot cannot change its character)', () => {
  it("habitual's N and C stay exactly 0 no matter what the log says", async () => {
    // Both components scream: N covaries perfectly with reward, C anti-covaries.
    for (let i = 0; i < 10; i++) {
      logRow({ outcome: 'staged', scores: { F: 0.5, H: 0.5, Q: 0.5, N: 1, C: 0 }, ageDays: 3 + i });
      logRow({ outcome: 'dismissed', scores: { F: 0.5, H: 0.5, Q: 0.5, N: 0, C: 1 }, ageDays: 3 + i });
    }
    await calibrateTriality(OWNER, NOW);
    const w = await getWeights(OWNER, 'habitual');
    expect(w.N).toBe(0);
    expect(w.C).toBe(0);
    // Same argument, contextual's unused axes.
    seedCovaryingLog({ slot: 'contextual', component: 'C' });
    await calibrateTriality(OWNER, NOW);
    const ctx = await getWeights(OWNER, 'contextual');
    expect(ctx.Q).toBe(0);
    expect(ctx.C).toBe(0);
    // A 0 default is 0 at the rule level too, whatever delta arrives.
    expect(applyUpdateRule('habitual', { F: 0, H: 0, Q: 0, N: 99, C: 99 })!.clamped.N).toBe(0);
  });
});

describe('floor (§6b — learning never runs on noise)', () => {
  it('19 decided rows write nothing; the 20th flips the slot to written', async () => {
    for (let i = 0; i < 19; i++) {
      logRow({ outcome: i % 2 === 0 ? 'staged' : 'dismissed', scores: { F: i % 2, H: 0.5, Q: 0.5 }, ageDays: 3 + i });
    }
    logRows(5, { outcome: 'shown', scores: { F: 1, H: 1, Q: 1 }, ageDays: 0.1 }); // pending, cannot help
    const floored = await calibrateTriality(OWNER, NOW);
    expect(floored).toEqual({ outcomeRows: 19, slotsWritten: 0, slotsFloored: 3, floor: OUTCOME_FLOOR });
    expect(storedRow('habitual')).toBeNull();
    expect(await getWeights(OWNER, 'habitual')).toEqual(DEFAULT_WEIGHTS.habitual); // absence == defaults

    logRow({ outcome: 'dismissed', scores: { F: 1, H: 0.5, Q: 0.5 }, ageDays: 25 });
    const written = await calibrateTriality(OWNER, NOW);
    expect(written).toEqual({ outcomeRows: 20, slotsWritten: 1, slotsFloored: 2, floor: OUTCOME_FLOOR });
    expect(storedRow('habitual')!.sample_count).toBe(20);
    expect(storedRow('habitual')!.computed_date).toBe(NOW.toISOString().slice(0, 10)); // owner-local day (UTC prefs)
  });

  it('rows outside the 90-day window are not evidence', async () => {
    seedCovaryingLog();
    logRows(10, { outcome: 'staged', scores: { F: 1 }, ageDays: LEARNING_WINDOW_DAYS + 1 });
    expect((await calibrateTriality(OWNER, NOW)).outcomeRows).toBe(OUTCOME_FLOOR);
  });
});

describe('stale-row hygiene', () => {
  it('a slot that drops below the floor loses its row', async () => {
    seedCovaryingLog();
    expect((await calibrateTriality(OWNER, NOW)).slotsWritten).toBe(1);
    expect(storedRow('habitual')).not.toBeNull();

    // Evidence shrinks (rows aged out, or the owner reset their log).
    sqlite.prepare(`DELETE FROM triality_log WHERE id IN (SELECT id FROM triality_log LIMIT 3)`).run();
    const after = await calibrateTriality(OWNER, NOW);
    expect(after.slotsWritten).toBe(0);
    expect(after.slotsFloored).toBe(3);
    expect(storedRow('habitual')).toBeNull(); // a shrinking sample must not keep old weights alive
    expect(await getWeights(OWNER, 'habitual')).toEqual(DEFAULT_WEIGHTS.habitual);
  });
});

describe('WHO rule (owner ruling 2026-07-16 — a cron/agent write must not stamp)', () => {
  it('calibrateTriality writes NO audit_log row, even when it replaces weights', async () => {
    await flushAudits();
    const audits = () => (sqlite.prepare(`SELECT COUNT(*) AS c FROM audit_log`).get() as { c: number }).c;
    seedCovaryingLog();
    const before = audits();
    expect((await calibrateTriality(OWNER, NOW)).slotsWritten).toBe(1); // it really wrote something
    expect(audits()).toBe(before);
    // …and the DELETE half of the wholesale replacement is equally unstamped.
    sqlite.prepare(`DELETE FROM triality_log WHERE id IN (SELECT id FROM triality_log LIMIT 3)`).run();
    expect((await calibrateTriality(OWNER, NOW)).slotsWritten).toBe(0);
    expect(storedRow('habitual')).toBeNull();
    expect(audits()).toBe(before);
  });
});

describe('per-owner isolation', () => {
  it("each owner's weights derive from their own log only", async () => {
    createOwner();
    // Owner A: high F accepted. Owner B: the exact opposite, plus too few rows.
    seedCovaryingLog();
    seedCovaryingLog({ owner: SECOND_OWNER_ID, highOutcome: 'dismissed', lowOutcome: 'staged' });

    const a = await calibrateTriality(OWNER, NOW);
    expect(a.outcomeRows).toBe(OUTCOME_FLOOR); // B's 20 rows are invisible here
    expect(storedRow('habitual', SECOND_OWNER_ID)).toBeNull(); // A's run never writes for B

    const b = await calibrateTriality(SECOND_OWNER_ID, NOW);
    expect(b.outcomeRows).toBe(OUTCOME_FLOOR);
    const wA = await getWeights(OWNER, 'habitual');
    const wB = await getWeights(SECOND_OWNER_ID, 'habitual');
    expect(wA.F).toBeGreaterThan(DEFAULT_WEIGHTS.habitual.F);
    expect(wB.F).toBeLessThan(DEFAULT_WEIGHTS.habitual.F);
    // B's run must not have disturbed A's row.
    expect(await getWeights(OWNER, 'habitual')).toEqual(wA);
  });

  it("one owner's floored slot does not delete another owner's row", async () => {
    createOwner();
    seedCovaryingLog();
    logRows(4, { owner: SECOND_OWNER_ID, outcome: 'staged', scores: { F: 1 } });
    await calibrateTriality(OWNER, NOW);
    await calibrateTriality(SECOND_OWNER_ID, NOW);
    expect(storedRow('habitual')).not.toBeNull();
    expect(storedRow('habitual', SECOND_OWNER_ID)).toBeNull();
  });
});

describe('malformed evidence', () => {
  it('unparseable scores JSON neither throws nor poisons the other components', async () => {
    // Every row carries a usable H; F is non-numeric on the staged half and CONSTANT
    // on the dismissed half — so F receives no signal while H learns normally.
    for (let i = 0; i < 10; i++) {
      logRow({ outcome: 'staged', scores: { H: 1, Q: 0.5, F: 'high', N: null }, ageDays: 3 + i });
      logRow({ outcome: 'dismissed', scores: { H: 0, Q: 0.5, F: 0.5, total: 'x' }, ageDays: 3 + i });
    }
    logRow({ outcome: 'staged', scores: 'null', ageDays: 30 });          // valid JSON, not an object
    logRow({ outcome: 'dismissed', scores: '{"H":1,"Q":', ageDays: 30 }); // truncated ⇒ the WHOLE row votes on nothing

    // A rejected promise fails the test — the async form of "does NOT throw".
    await calibrateTriality(OWNER, NOW);
    const row = storedRow('habitual')!;
    expect(row.sample_count).toBe(22); // a corrupt row is still a decided outcome
    const w = await getWeights(OWNER, 'habitual');
    expect(w.H).toBeGreaterThan(DEFAULT_WEIGHTS.habitual.H);
    // F got no usable variance, so its share relative to Q is untouched (both moved
    // only by the shared renormalization factor).
    expect(w.F / w.Q).toBeCloseTo(DEFAULT_WEIGHTS.habitual.F / DEFAULT_WEIGHTS.habitual.Q, 12);
  });

  it('a truncated-JSON row that yields NO components still counts, and delta is 0', async () => {
    logRows(OUTCOME_FLOOR, { outcome: 'staged', scores: '{oops' });
    await calibrateTriality(OWNER, NOW);
    expect(componentDeltas([{ reward: 1, scores: {} }])).toEqual({ F: 0, H: 0, Q: 0, N: 0, C: 0 });
    expect(await getWeights(OWNER, 'habitual')).toEqual(DEFAULT_WEIGHTS.habitual);
  });
});

// ── End-to-end: learning actually changes the suggestion ──────────────────────

function insertTask(
  title: string,
  o: { status?: string; estimate?: number | null; completedAt?: string; mood?: string } = {},
): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, estimated_minutes, completed_at, completion_mood, priority)
         VALUES (uuid7(), ?, ?, ?, ?, ?, ?, 3) RETURNING id`,
      )
      .get(title, OWNER, o.status ?? 'open', o.estimate === undefined ? 30 : o.estimate, o.completedAt ?? null, o.mood ?? null) as { id: string }
  ).id;
}

function addCategory(taskId: string, name: string): void {
  const existing = sqlite
    .prepare(`SELECT id FROM tags WHERE owner_id = ? AND kind = 'category' AND LOWER(name) = LOWER(?)`)
    .get(OWNER, name) as { id: string } | undefined;
  const tagId =
    existing?.id ??
    (sqlite
      .prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (uuid7(), ?, ?, 'category', 1) RETURNING id`)
      .get(OWNER, name) as { id: string }).id;
  sqlite
    .prepare(`INSERT INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('task', ?, ?, 0)`)
    .run(taskId, tagId);
}

/**
 * How far back of 14:00 every seeded completion is nudged, so that it lands in the
 * MORNING band on the owner's clock (09:00 for an integer age).
 *
 * This fixture is about LEARNED WEIGHTS, and it can only be about them if nothing else
 * in the ranking moves underneath it. Ages alone do not say that: v2.3 reads the modal
 * TIME BAND of each signature class out of these very rows, and `daysAgo(n)` for whole n
 * puts every completion at 14:00 — the same afternoon as NOW — so a class with three or
 * more completions would claim "this is an afternoon habit", match, and collect a
 * contextFit pairing that has nothing to do with what the owner accepted.
 *
 * The morning is the band that says nothing: `OPPOSITE_BAND` pairs only morning⇄evening,
 * so a morning rhythm read at 14:00 is neither a match nor an opposition and drops out of
 * the dot product entirely. The weekday half needs no device — 2/3/4 days before a
 * Wednesday are a Monday, a Sunday and a Saturday, and the weekday pairing has no −1 arm,
 * so a non-matching weekday is inactive rather than negative.
 */
const MORNING_SHIFT_DAYS = 6 / 24;

/** A completed, ritual-confirmed task of one category class at a chosen age. */
function completedIn(category: string, ageDays: number): string {
  const id = insertTask(`done-${category}-${ageDays}`, {
    status: 'done',
    completedAt: daysAgo(ageDays + MORNING_SHIFT_DAYS),
    mood: 'flat',
  });
  addCategory(id, category);
  return id;
}

function setPriorities(rows: Array<{ category: string; importance: number; satisfaction: number }>): void {
  for (const r of rows) {
    sqlite
      .prepare(
        `INSERT INTO life_priorities (owner_id, category, satisfaction, importance, target_hours_per_week)
         VALUES (?, ?, ?, ?, 10)
         ON CONFLICT(owner_id, category) DO UPDATE SET satisfaction = excluded.satisfaction, importance = excluded.importance`,
      )
      .run(OWNER, r.category, r.satisfaction, r.importance);
  }
}

describe('end-to-end adaptation (the test that justifies the feature)', () => {
  it('a log where habit strength earned the acceptances reorders the habitual pick', async () => {
    // Ranking fixture: four candidates whose H spread puts `career` at the top band,
    // `growth`/`leisure` in the middle band and `health` at the bottom, while the
    // §6 deficits give health the only positive F and career the only negative one.
    // Habitual's dot product therefore TIES career/growth/leisure at 0, and the tie
    // break is the slot's weighted score — exactly the seam learning moves.
    for (let i = 0; i < 10; i++) insertTask(`noise-${i}`, { status: 'done', completedAt: daysAgo(1 + i), mood: 'flat' });
    for (const age of [2, 3, 4]) completedIn('career', age);
    for (const age of [3, 5]) completedIn('growth', age);
    completedIn('leisure', 0.5);
    completedIn('relationships', 0.1); // most recent, class-unique ⇒ Q is 0 for every candidate
    setPriorities([
      { category: 'health', importance: 9, satisfaction: 2 },
      { category: 'career', importance: 2, satisfaction: 9 },
    ]);
    const careerCand = insertTask('another work thing'); addCategory(careerCand, 'career');
    const growthCand = insertTask('read a chapter');     addCategory(growthCand, 'growth');
    const leisureCand = insertTask('play guitar');       addCategory(leisureCand, 'leisure');
    const healthCand = insertTask('short run');          addCategory(healthCand, 'health');

    const before = await trialityNext(OWNER, NOW, { embedFn: null });
    if (before.refused) throw new Error(`unexpected refusal: ${before.refused}`);
    const habitualBefore = before.picks[0] as ScoredPick;
    expect(habitualBefore.ref).toBe(growthCand); // default habitual weights: F .40 / H .40

    // Evidence: the accepted picks were the high-H, low-F ones — the log says habit
    // strength, not context fit, is what this owner actually acts on.
    for (let i = 0; i < 10; i++) {
      logRow({ outcome: 'staged', scores: { F: 0, H: 1, Q: 0.5, N: 0, C: 0 }, ageDays: 3 + i });
      logRow({ outcome: 'dismissed', scores: { F: 1, H: 0, Q: 0.5, N: 0, C: 0 }, ageDays: 3 + i });
    }
    const res = await calibrateTriality(OWNER, NOW);
    expect(res).toEqual({ outcomeRows: 20, slotsWritten: 1, slotsFloored: 2, floor: OUTCOME_FLOOR });

    const learned = await getWeights(OWNER, 'habitual');
    expect(learned.H).toBeCloseTo(0.5, 6);  // 0.40 · (1 + 0.5·0.5)
    expect(learned.F).toBeCloseTo(0.3, 6);  // 0.40 · (1 − 0.5·0.5)
    expect(learned.Q).toBeCloseTo(0.2, 6);  // no variance in Q ⇒ untouched
    expect(await getWeights(OWNER, 'contextual')).toEqual(DEFAULT_WEIGHTS.contextual); // floored slots stand

    const after = await trialityNext(OWNER, NOW, { embedFn: null });
    if (after.refused) throw new Error('unexpected refusal');
    const habitualAfter = after.picks[0] as ScoredPick;
    expect(habitualAfter.ref).not.toBe(habitualBefore.ref); // the ORDER moved
    expect(habitualAfter.ref).toBe(careerCand);
    // …and the same candidate's total is scored differently under learned weights.
    const defaultRun = await trialityNext(OWNER, NOW, { embedFn: null, getWeightsFn: (_o, s) => DEFAULT_WEIGHTS[s] });
    if (defaultRun.refused) throw new Error('unexpected refusal');
    expect((defaultRun.picks[0] as ScoredPick).ref).toBe(habitualBefore.ref);
    expect(habitualAfter.scores.total).not.toBe((defaultRun.picks[0] as ScoredPick).scores.total);
    // Untouched slots keep their picks: learning is per-slot.
    expect(after.picks[1]?.ref).toBe(healthCand);
    expect(after.picks[1]?.ref).toBe(before.picks[1]?.ref);
    void leisureCand;
  });
});
