/**
 * Phase Z · Z7 (Time-Sense) — the Voice loop (renderCopy) + its deterministic gate.
 *
 * The Ollama `generate` seam is mocked as a configurable vi.fn so each test drives a
 * specific model behavior (good line / banned / repeat / down). The gate is exercised
 * directly (pure, model-free) to prove generator ≠ evaluator.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/mcp/ollama.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/mcp/ollama.js')>();
  return { ...mod, generate: vi.fn() };
});

import { sqlite } from '../src/db/index.js';
import { generate } from '../src/mcp/ollama.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb } from './helpers.js';
import { renderCopy, SURFACES } from '../src/agents/render-copy.js';
import { gateCopy, computeSignature, isRepetitive, trigramSimilarity } from '../src/agents/voice-gate.js';

const mockGenerate = generate as unknown as ReturnType<typeof vi.fn>;
const OWNER = SYSTEM_OWNER;

function historyCount(surface: string): number {
  return (sqlite
    .prepare(`SELECT COUNT(*) AS n FROM copy_history WHERE owner_id = ? AND surface = ?`)
    .get(OWNER, surface) as { n: number }).n;
}

beforeEach(() => {
  resetDb();
  mockGenerate.mockReset();
});

// ── Migration shape (0109) ─────────────────────────────────────────────────────

describe('migration 0109 copy_history', () => {
  it('created the copy_history support table', () => {
    const t = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='copy_history'`).get();
    expect(t).toBeDefined();
    const cols = (sqlite.prepare(`PRAGMA table_info(copy_history)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'owner_id', 'surface', 'signature', 'created_at']);
  });
});

// ── The gate (§2V.2 step 4) — pure, model-free ───────────────────────────────────

describe('voice gate', () => {
  const base = { required: [] as string[], recent: [], maxLen: 140 };

  it('rejects banned words and emoji', () => {
    expect(gateCopy('Just leave by 12:00.', base).reason).toBe('banned');
    expect(gateCopy('You can leverage the gap.', base).reason).toBe('banned');
    expect(gateCopy('Great job today.', base).reason).toBe('banned');
    expect(gateCopy('Time to go 🎉', base).reason).toBe('banned');
    // A word that merely CONTAINS a banned substring is fine (word-boundary match).
    expect(gateCopy('You adjusted the plan by 12:00.', base).ok).toBe(true);
  });

  it('requires the grounding datum to be present', () => {
    expect(gateCopy('You planned to leave soon.', { ...base, required: ['12:00'] }).reason).toBe('missing_datum');
    expect(gateCopy('You planned to leave by 12:00.', { ...base, required: ['12:00'] }).ok).toBe(true);
  });

  it('enforces the length budget', () => {
    expect(gateCopy('x'.repeat(200), { ...base, maxLen: 140 }).reason).toBe('too_long');
  });

  it('rejects a near-duplicate of a recent signature but allows a differently-shaped line', () => {
    const prior = computeSignature('You planned to leave by 12:00 for lunch.');
    // Same opener → repetitive, even with a different tail.
    expect(gateCopy('You planned to leave by 12:00, Dana is waiting.', { ...base, recent: [prior] }).reason).toBe('repetitive');
    // Same datum, genuinely different shape → passes.
    expect(gateCopy('Noon was your leave-by; the block is close.', { ...base, recent: [prior], required: [] }).ok).toBe(true);
  });

  it('is a pure evaluator — it never calls the model (generator ≠ evaluator)', () => {
    mockGenerate.mockImplementation(() => { throw new Error('the gate must not call this'); });
    const r = gateCopy('You planned to leave by 12:00.', { ...base, required: ['12:00'] });
    expect(r.ok).toBe(true);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('trigram similarity is 1 for identical, lower for divergent shapes', () => {
    const a = computeSignature('the quick brown fox jumps high').trigrams;
    expect(trigramSimilarity(a, a)).toBe(1);
    const b = computeSignature('a slow green turtle crawls low').trigrams;
    expect(trigramSimilarity(a, b)).toBeLessThan(0.6);
    expect(isRepetitive(computeSignature('a slow green turtle crawls low'), [computeSignature('the quick brown fox jumps high')])).toBe(false);
  });
});

// ── renderCopy — the bounded loop (§2V.2) ────────────────────────────────────────

describe('renderCopy', () => {
  const payload = { planned_departure: '12:00', next: 'lunch with Dana' };

  it('emits a model line when it passes the gate, and records the signature', async () => {
    mockGenerate.mockResolvedValue('You planned to leave by 12:00 for lunch with Dana.');
    const r = await renderCopy('timing_note', payload, { ownerId: OWNER });
    expect(r.source).toBe('model');
    expect(r.text).toContain('12:00');
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(historyCount('timing_note')).toBe(1);
  });

  it('regenerates once when the first draft fails the gate', async () => {
    mockGenerate
      .mockResolvedValueOnce('Just leave by 12:00.') // banned → rejected
      .mockResolvedValueOnce('You planned to leave by 12:00 for lunch.'); // clean
    const r = await renderCopy('timing_note', payload, { ownerId: OWNER });
    expect(r.source).toBe('model');
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it('falls back to the rotation pool when the model keeps failing the gate', async () => {
    mockGenerate.mockResolvedValue('Simply relax now.'); // banned + missing datum, every time
    const r = await renderCopy('timing_note', payload, { ownerId: OWNER });
    expect(r.source).toBe('fallback');
    expect(r.text).toContain('12:00'); // datum-slotting: the offline line still carries the fact
    expect(mockGenerate).toHaveBeenCalledTimes(2); // bounded: draft + one regen, then give up
  });

  it('never throws when Ollama is down — straight to the fallback pool', async () => {
    mockGenerate.mockRejectedValue(new Error('ollama unreachable'));
    const r = await renderCopy('timing_note', payload, { ownerId: OWNER });
    expect(r.source).toBe('fallback');
    expect(r.text).toContain('12:00');
    expect(mockGenerate).toHaveBeenCalledTimes(1); // one throw → break, no retry storm
  });

  it('the fallback pool does not repeat within the pool size (datum-slotting + rotation)', async () => {
    mockGenerate.mockRejectedValue(new Error('down'));
    const poolSize = SURFACES.calibration_chip.fallbacks.length;
    const seen: string[] = [];
    for (let i = 0; i < poolSize; i++) {
      const r = await renderCopy('calibration_chip', { suggested: 45, current: 30 }, { ownerId: OWNER });
      seen.push(r.text);
    }
    expect(new Set(seen).size).toBe(poolSize); // every template distinct across a full rotation
  });

  it('when the model repeats a just-emitted line, the gate forces a different fallback', async () => {
    const line = 'You planned to leave by 12:00 for lunch with Dana.';
    mockGenerate.mockResolvedValue(line); // always the same phrasing
    const first = await renderCopy('timing_note', payload, { ownerId: OWNER });
    expect(first.source).toBe('model');
    const second = await renderCopy('timing_note', payload, { ownerId: OWNER });
    expect(second.source).toBe('fallback'); // the repeat was rejected twice → escape hatch
    expect(second.text).not.toBe(first.text);
    expect(second.text).toContain('12:00');
  });

  it('prunes the anti-repetition window back to the surface K', async () => {
    mockGenerate.mockRejectedValue(new Error('down'));
    const k = SURFACES.weekly_review.historyK; // 4
    for (let i = 0; i < k + 3; i++) {
      await renderCopy('weekly_review', { facts: `week ${i} recap` }, { ownerId: OWNER });
    }
    expect(historyCount('weekly_review')).toBe(k);
  });
});
