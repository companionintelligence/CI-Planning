import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  calibrateClassification, canonicalValue, classificationHint, classificationInput,
  decidedRows, exemplarPrompt, logAnsweredAssignment, logAssignment, recordCorrection, retrieveExemplars, rowOutcome,
  CORRECTION_FLOOR, HELD_OUT_STRIDE, LEARNING_WINDOW_DAYS, MAX_EXEMPLARS, PENDING_MS, RETRIEVE_K,
  type ClassifiedField, type Exemplar,
} from '../src/services/classification-learning.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';
import { ollama } from '../src/mcp/ollama.js';
import { packVector } from '../src/lib/vector.js';

/**
 * Phase 8 — the parse/classify LLM learns from the owner's corrections.
 *
 * The contract under test is triality-learning's, applied to classification: batch
 * over durable evidence, bounded, never online. So the tests are shaped like that
 * file's — raw sqlite fixtures, a frozen `NOW`, every timestamp derived from it, and
 * an INJECTED embedder throughout so not one assertion depends on whether this box
 * has an embedder pulled. (An ungated live embed call is what made `triality-routes`
 * look flaky for weeks; see #552.)
 */

const OWNER = SYSTEM_OWNER;
const NOW = new Date('2026-08-14T14:00:00.000Z');
const msAgo = (ms: number) => new Date(NOW.getTime() - ms);

/** Settled long enough ago to be evidence rather than pending. */
const SETTLED = 3 * 86_400_000;

/**
 * A deterministic stand-in for nomic-embed: a bag-of-words vector over a fixed
 * dictionary. Similar sentences share words and therefore point the same way, which
 * is the only property retrieval actually depends on — and it makes "the nearest
 * exemplar" a fact of the fixture rather than a fact about a model.
 */
const DICT = ['gym', 'run', 'workout', 'invoice', 'taxes', 'budget', 'mum', 'dinner', 'book', 'read'];
const fakeEmbed = async (text: string): Promise<number[]> => {
  const words = new Set(text.toLowerCase().split(/[^a-z]+/));
  const v = DICT.map((w) => (words.has(w) ? 1 : 0));
  // A non-zero tail keeps a text with no dictionary word from being a zero vector,
  // which cosine would score 0 against everything (a tie, not a ranking).
  return [...v, 0.01];
};

/** Log an assignment and settle it in one step, at a chosen age. */
async function evidence(opts: {
  field?: ClassifiedField;
  text: string;
  llm: string | string[];
  final?: string | string[];   // omitted ⇒ never touched (accepted after PENDING_MS)
  ageMs?: number;
  owner?: string;
  taskId?: string;
}): Promise<string> {
  const owner = opts.owner ?? OWNER;
  const field = opts.field ?? 'category';
  const idx = seq++;
  const taskId = opts.taskId ?? `task-${idx}`;
  // Each successive row is one second NEWER, so the evidence has a total order by
  // `assigned_at`. Sharing one timestamp would leave the read's `ORDER BY assigned_at,
  // id` to break ties on uuid7's within-millisecond RANDOM bytes — which decides which
  // rows the held-out stride takes, and made this file pass alone and fail in the suite.
  const at = msAgo(opts.ageMs ?? SETTLED - idx * 1000);
  await logAssignment(owner, { taskId, field, inputText: opts.text, llmValue: opts.llm }, at);
  if (opts.final !== undefined) {
    // Corrected a minute after it was assigned — the owner noticed straight away.
    await recordCorrection(owner, taskId, field, opts.final, new Date(at.getTime() + 60_000));
  }
  return taskId;
}
let seq = 0;

const logRows = (owner = OWNER) =>
  sqlite.prepare(`SELECT * FROM classification_log WHERE owner_id = ? ORDER BY assigned_at, id`).all(owner) as {
    id: string; task_id: string | null; field: string; input_text: string;
    llm_value: string; final_value: string | null; corrected_at: string | null; local_date: string;
  }[];

const exemplarRows = (field = 'category', owner = OWNER) =>
  sqlite.prepare(
    `SELECT * FROM classification_exemplars WHERE owner_id = ? AND field = ? ORDER BY log_id`,
  ).all(owner, field) as {
    log_id: string; input_text: string; llm_value: string; correct_value: string; embedding: Buffer | null;
  }[];

const accuracyRows = (owner = OWNER) =>
  sqlite.prepare(`SELECT * FROM classification_accuracy WHERE owner_id = ? ORDER BY field`).all(owner) as {
    field: string; held_out: number; correct: number; accuracy: number | null;
  }[];

beforeEach(() => {
  resetDb();
  sqlite.exec('DELETE FROM classification_log; DELETE FROM classification_exemplars; DELETE FROM classification_accuracy;');
  seq = 0;
});

// ── Capture ──────────────────────────────────────────────────────────────────

describe('capturing evidence', () => {
  it('logs what the model claimed, canonicalised', async () => {
    await logAssignment(OWNER, {
      taskId: 't1', field: 'category', inputText: 'gym session', llmValue: [' Leisure ', 'Health'],
    }, NOW);
    const [row] = logRows();
    expect(row.field).toBe('category');
    expect(row.llm_value).toBe('Leisure, Health');
    expect(row.final_value).toBeNull();
    expect(row.local_date).toBe('2026-08-14');
  });

  it('claims nothing when the model said nothing', async () => {
    await logAssignment(OWNER, { taskId: 't1', field: 'category', inputText: 'gym', llmValue: [] }, NOW);
    await logAssignment(OWNER, { taskId: 't2', field: 'category', inputText: '   ', llmValue: ['Health'] }, NOW);
    expect(logRows()).toHaveLength(0);
  });

  it('records the owner’s answer against the open assignment', async () => {
    await logAssignment(OWNER, { taskId: 't1', field: 'category', inputText: 'gym', llmValue: ['Leisure'] }, NOW);
    expect(await recordCorrection(OWNER, 't1', 'category', ['Health'], NOW)).toBe(true);
    const [row] = logRows();
    expect(row.final_value).toBe('Health');
    expect(row.corrected_at).not.toBeNull();
  });

  it('teaches nothing from an answer the model never contradicted', async () => {
    // The owner categorising a task the model never touched is not a correction —
    // there was no claim. Logging it would fill the index with "you said (nothing)".
    expect(await recordCorrection(OWNER, 'never-classified', 'category', ['Health'], NOW)).toBe(false);
    expect(logRows()).toHaveLength(0);
  });

  it('keeps only the owner’s FIRST answer to a claim', async () => {
    await logAssignment(OWNER, { taskId: 't1', field: 'category', inputText: 'gym', llmValue: ['Leisure'] }, NOW);
    await recordCorrection(OWNER, 't1', 'category', ['Health'], NOW);
    // A later re-edit is a new opinion about a settled matter, not a second lesson.
    expect(await recordCorrection(OWNER, 't1', 'category', ['Finance'], NOW)).toBe(false);
    expect(logRows()[0].final_value).toBe('Health');
  });

  it('never throws when the log cannot be written', async () => {
    // A classification that succeeded must not be reported as failed because the
    // learning log had a bad day.
    sqlite.exec(`ALTER TABLE classification_log RENAME TO classification_log_hidden`);
    try {
      await expect(logAssignment(OWNER, { taskId: 't1', field: 'category', inputText: 'gym', llmValue: ['x'] }, NOW))
        .resolves.toBeUndefined();
      await expect(recordCorrection(OWNER, 't1', 'category', ['y'], NOW)).resolves.toBe(false);
    } finally {
      sqlite.exec(`ALTER TABLE classification_log_hidden RENAME TO classification_log`);
    }
  });
});

// ── Evidence semantics ────────────────────────────────────────────────────────

describe('what counts as evidence', () => {
  const row = (over: Partial<Parameters<typeof rowOutcome>[0]> = {}) => ({
    id: 'l1', input_text: 'gym', llm_value: 'Leisure', final_value: null,
    assigned_at: msAgo(SETTLED).toISOString(), corrected_at: null, ...over,
  });

  it('is undecided while an untouched assignment is younger than the pending window', () => {
    expect(rowOutcome(row({ assigned_at: msAgo(PENDING_MS - 1000).toISOString() }), NOW)).toBeNull();
  });

  it('counts an untouched assignment as accepted once the window passes', () => {
    expect(rowOutcome(row({ assigned_at: msAgo(PENDING_MS + 1000).toISOString() }), NOW)).toBe('accepted');
  });

  it('counts a changed value as a correction', () => {
    expect(rowOutcome(row({ final_value: 'Health', corrected_at: NOW.toISOString() }), NOW)).toBe('corrected');
  });

  it('counts agreement as acceptance, not correction', () => {
    // An owner who "corrects" to the same value has agreed. Treating it as a
    // correction would fill the index with examples that teach nothing.
    expect(rowOutcome(row({ final_value: 'Leisure', corrected_at: NOW.toISOString() }), NOW)).toBe('accepted');
  });

  it('refuses to age a row whose timestamp will not parse', () => {
    expect(rowOutcome(row({ assigned_at: 'not-a-date' }), NOW)).toBeNull();
  });

  it('reads only decided rows inside the window', async () => {
    await evidence({ text: 'gym session', llm: 'Leisure', final: 'Health' });
    await evidence({ text: 'run', llm: 'Leisure', ageMs: PENDING_MS / 2 });          // pending
    await evidence({ text: 'old taxes', llm: 'Career', final: 'Finance', ageMs: (LEARNING_WINDOW_DAYS + 5) * 86_400_000 });

    const rows = await decidedRows(OWNER, 'category', NOW);
    expect(rows.map((r) => r.inputText)).toEqual(['gym session']);
    expect(rows[0].correctValue).toBe('Health');
    expect(rows[0].corrected).toBe(true);
  });

  it('never pools one owner’s corrections into another’s', async () => {
    createOwner(SECOND_OWNER_ID);
    await evidence({ text: 'gym session', llm: 'Leisure', final: 'Health' });
    await evidence({ text: 'gym session', llm: 'Leisure', final: 'Finance', owner: SECOND_OWNER_ID });
    expect((await decidedRows(OWNER, 'category', NOW)).map((r) => r.correctValue)).toEqual(['Health']);
    expect((await decidedRows(SECOND_OWNER_ID, 'category', NOW)).map((r) => r.correctValue)).toEqual(['Finance']);
  });
});

// ── Calibration ───────────────────────────────────────────────────────────────

describe('the batch calibration', () => {
  it('teaches nothing below the floor, and says so', async () => {
    await evidence({ text: 'gym session', llm: 'Leisure', final: 'Health' });
    const r = await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    const cat = r.fields.find((f) => f.field === 'category')!;
    expect(cat.corrections).toBe(1);
    expect(cat.indexed).toBe(0);
    expect(cat.accuracy).toBeNull();
    expect(exemplarRows()).toHaveLength(0);
  });

  it('builds the index once the floor is cleared', async () => {
    for (let i = 0; i < CORRECTION_FLOOR; i++) {
      await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' });
    }
    const r = await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    const cat = r.fields.find((f) => f.field === 'category')!;
    expect(cat.indexed).toBeGreaterThan(0);
    expect(cat.embedded).toBe(cat.indexed);
    const rows = exemplarRows();
    expect(rows).toHaveLength(cat.indexed);
    expect(rows[0].correct_value).toBe('Health');
    expect(rows[0].llm_value).toBe('Leisure');
    expect(rows[0].embedding).not.toBeNull();
  });

  it('empties a stale index when the corrections go away', async () => {
    for (let i = 0; i < 8; i++) await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' });
    await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    expect(exemplarRows().length).toBeGreaterThan(0);

    // The owner deletes their history; the next run must stop teaching from it.
    sqlite.exec(`DELETE FROM classification_log`);
    await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    expect(exemplarRows()).toHaveLength(0);
  });

  it('holds out every Nth correction, and never indexes what it grades', async () => {
    for (let i = 0; i < 12; i++) await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' });
    const graded: string[] = [];
    const r = await calibrateClassification(OWNER, NOW, {
      embedFn: fakeEmbed,
      scoreFn: async ({ inputText }) => { graded.push(inputText); return 'Health'; },
    });
    const cat = r.fields.find((f) => f.field === 'category')!;
    expect(cat.corrections).toBe(12);
    expect(graded).toHaveLength(12 / HELD_OUT_STRIDE);
    expect(cat.indexed).toBe(12 - graded.length);
    // An example that grades itself measures nothing.
    const indexedTexts = new Set(exemplarRows().map((e) => e.input_text));
    for (const t of graded) expect(indexedTexts.has(t)).toBe(false);
  });

  it('records accuracy per field, and a gap rather than a zero when nothing was scored', async () => {
    for (let i = 0; i < 8; i++) await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' });
    for (let i = 0; i < 8; i++) {
      await evidence({ field: 'motivation', text: `help mum ${i}`, llm: 'me', final: 'them' });
    }
    // The category grader is right; the motivation grader cannot answer at all.
    await calibrateClassification(OWNER, NOW, {
      embedFn: fakeEmbed,
      scoreFn: async ({ field }) => (field === 'category' ? 'Health' : null),
    });
    const rows = accuracyRows();
    const cat = rows.find((r) => r.field === 'category')!;
    const mot = rows.find((r) => r.field === 'motivation')!;
    expect(cat.accuracy).toBe(1);
    expect(cat.held_out).toBe(2);
    expect(mot.held_out).toBe(0);
    expect(mot.accuracy).toBeNull(); // not measured — must not plot as 0%

    // The other route to "not measured": no grader at all (no Ollama). Same answer,
    // different branch — and a 0 here would tell the owner learning collapsed on a
    // week when nothing was even tried.
    await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    expect(accuracyRows().find((r) => r.field === 'category')!.accuracy).toBeNull();
  });

  it('counts a wrong answer as wrong and a broken grader as unmeasured', async () => {
    for (let i = 0; i < 8; i++) await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' });
    const wrong = await calibrateClassification(OWNER, NOW, {
      embedFn: fakeEmbed, scoreFn: async () => 'Finance',
    });
    expect(wrong.fields.find((f) => f.field === 'category')!.accuracy).toBe(0);

    // A model that fell over is not a wrong answer — counting it as one would make the
    // trend say learning got worse when what happened is Ollama died.
    const broken = await calibrateClassification(OWNER, NOW, {
      embedFn: fakeEmbed, scoreFn: async () => { throw new Error('ollama down'); },
    });
    expect(broken.fields.find((f) => f.field === 'category')!.accuracy).toBeNull();
  });

  it('is deterministic — same evidence, same clock, same index', async () => {
    for (let i = 0; i < 10; i++) await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' });
    await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    const first = exemplarRows().map((e) => `${e.log_id}|${e.input_text}|${e.correct_value}`);
    await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    expect(exemplarRows().map((e) => `${e.log_id}|${e.input_text}|${e.correct_value}`)).toEqual(first);
  });

  it('caps the index and keeps the RECENT corrections when it bites', async () => {
    // Enough that the TRAINING slice alone overflows the cap: the stride takes one in
    // every HELD_OUT_STRIDE first, so a fixture sized to the cap would never reach it.
    const total = Math.ceil(MAX_EXEMPLARS * (HELD_OUT_STRIDE / (HELD_OUT_STRIDE - 1))) + 20;
    // Ages descend with i, so `gym workout 0` is the oldest.
    for (let i = 0; i < total; i++) {
      await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health', ageMs: SETTLED + (total - i) * 60_000 });
    }
    await calibrateClassification(OWNER, NOW, { embedFn: null });
    const rows = exemplarRows();
    expect(rows).toHaveLength(MAX_EXEMPLARS);
    const texts = new Set(rows.map((e) => e.input_text));
    expect(texts.has('gym workout 0')).toBe(false);              // oldest dropped
    expect(texts.has(`gym workout ${total - 1}`)).toBe(true);    // newest kept
  });

  it('indexes without an embedder, marking the rows unretrievable by similarity', async () => {
    for (let i = 0; i < 8; i++) await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' });
    const r = await calibrateClassification(OWNER, NOW, { embedFn: null });
    const cat = r.fields.find((f) => f.field === 'category')!;
    expect(cat.indexed).toBeGreaterThan(0);
    expect(cat.embedded).toBe(0);
    expect(exemplarRows().every((e) => e.embedding === null)).toBe(true);
  });
});

// A cleared category picker is an answer the owner gave ("none of these") but not a label
// the category classifier could have produced: its prompt makes the model choose from the
// owner's list. So it is decided evidence that never counts as a learnable correction.
describe('a category answered with "" (a cleared picker)', () => {
  const cat = (r: Awaited<ReturnType<typeof calibrateClassification>>) => r.fields.find((f) => f.field === 'category')!;
  const mot = (r: Awaited<ReturnType<typeof calibrateClassification>>) => r.fields.find((f) => f.field === 'motivation')!;

  it('is decided evidence, and a correction as far as its outcome goes', async () => {
    await evidence({ text: 'gym workout 0', llm: 'Leisure', final: '' });
    const [row] = await decidedRows(OWNER, 'category', NOW);
    expect(row).toMatchObject({ correctValue: '', corrected: true });
  });

  it('does not clear the floor, however many there are', async () => {
    await evidence({ text: 'gym workout 0', llm: 'Leisure', final: 'Health' });
    for (let i = 1; i <= CORRECTION_FLOOR + 4; i++) await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: '' });
    // A stale index from before must go too: below the floor the stock prompt stands.
    sqlite.prepare(
      `INSERT INTO classification_exemplars (owner_id, field, log_id, input_text, llm_value, correct_value, embedding, computed_date)
       VALUES (?, 'category', 'stale', 'gym', 'Leisure', 'Health', NULL, '2026-08-01')`,
    ).run(OWNER);

    const r = await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    expect(cat(r).decided).toBe(CORRECTION_FLOOR + 5);   // they are evidence …
    expect(cat(r).corrections).toBe(1);                  // … but only one is a label
    expect(cat(r).indexed).toBe(0);
    expect(cat(r).accuracy).toBeNull();
    expect(exemplarRows()).toHaveLength(0);
  });

  it('stays out of the index and the held-out slice, and cannot drag the accuracy down', async () => {
    // Interleaved, so that a stride over EVERY correction would land only on cleared ones.
    for (let i = 0; i < 8; i++) {
      await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' });
      await evidence({ text: `cleared picker ${i}`, llm: 'Leisure', final: '' });
    }
    const graded: string[] = [];
    const hints: string[] = [];
    const r = await calibrateClassification(OWNER, NOW, {
      embedFn: fakeEmbed,
      scoreFn: async ({ inputText, hint }) => { graded.push(inputText); hints.push(hint); return 'Health'; },
    });
    expect(cat(r).decided).toBe(16);
    expect(cat(r).corrections).toBe(8);
    expect(graded).toHaveLength(8 / HELD_OUT_STRIDE);
    expect(graded.every((t) => t.startsWith('gym workout'))).toBe(true);
    expect(cat(r).indexed).toBe(8 - graded.length);
    expect(exemplarRows().map((e) => e.correct_value)).not.toContain('');
    expect(exemplarRows().every((e) => e.input_text.startsWith('gym workout'))).toBe(true);
    expect(cat(r).accuracy).toBe(1);

    // And the scorer's prompt, which asks for a pick from the list, is never taught "(nothing)".
    expect(hints.length).toBeGreaterThan(0);
    for (const h of hints) {
      expect(h).toContain('the user chose Health');
      expect(h).not.toContain('(nothing)');
    }
  });

  it('is kept for motivation, where null is a real label', async () => {
    await evidence({ field: 'motivation', text: 'help mum 0', llm: 'me', final: 'them' });
    await evidence({ field: 'motivation', text: 'tidy the desk', llm: 'me', final: '' });
    const r = await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    expect(mot(r).corrections).toBe(2);
    expect(mot(r).indexed).toBe(2);
    expect(exemplarRows('motivation').map((e) => e.correct_value).sort()).toEqual(['', 'them']);
    expect(await classificationHint(OWNER, 'motivation', 'tidy', { embedFn: null })).toContain('the user chose (nothing).');
  });

  it('is never scored when it lands in the held-out slice (a motivation null)', async () => {
    // The scorer answers with a value or null, so a '' target is a guaranteed miss or a
    // skip. It is left unmeasured; the three real labels are still indexed.
    for (let i = 0; i < HELD_OUT_STRIDE - 1; i++) {
      await evidence({ field: 'motivation', text: `help mum ${i}`, llm: 'me', final: 'them' });
    }
    await evidence({ field: 'motivation', text: 'tidy the desk', llm: 'me', final: '' }); // every Nth: held out
    const graded: string[] = [];
    const r = await calibrateClassification(OWNER, NOW, {
      embedFn: fakeEmbed,
      scoreFn: async ({ inputText }) => { graded.push(inputText); return 'them'; },
    });
    expect(graded).toEqual([]);
    expect(mot(r).heldOut).toBe(0);
    expect(mot(r).accuracy).toBeNull();
    expect(mot(r).indexed).toBe(HELD_OUT_STRIDE - 1);
  });
});

// ── Retrieval ─────────────────────────────────────────────────────────────────

describe('what a live classification reads', () => {
  /** Build an index from corrections, the way a calibration run would. */
  async function indexed(pairs: { text: string; llm: string; final: string }[], embedFn: typeof fakeEmbed | null = fakeEmbed) {
    for (const p of pairs) await evidence({ text: p.text, llm: p.llm, final: p.final });
    await calibrateClassification(OWNER, NOW, { embedFn });
  }

  it('says nothing at all when there is no index', async () => {
    expect(await retrieveExemplars(OWNER, 'category', 'gym session', { embedFn: fakeEmbed })).toEqual([]);
    // The prompt fragment must be EMPTY, not a header with no examples — an owner with
    // no corrections gets a byte-identical prompt to before this feature existed.
    expect(await classificationHint(OWNER, 'category', 'gym session', { embedFn: fakeEmbed })).toBe('');
  });

  it('retrieves the nearest corrections, not just any', async () => {
    await indexed([
      { text: 'gym workout monday', llm: 'Leisure', final: 'Health' },
      { text: 'gym workout tuesday', llm: 'Leisure', final: 'Health' },
      { text: 'quarterly invoice', llm: 'Career', final: 'Finance' },
      { text: 'invoice the client', llm: 'Career', final: 'Finance' },
      { text: 'read a book', llm: 'Career', final: 'Leisure' },
      { text: 'book club', llm: 'Career', final: 'Leisure' },
    ]);
    const got = await retrieveExemplars(OWNER, 'category', 'gym run', { embedFn: fakeEmbed, k: 1 });
    expect(got).toHaveLength(1);
    expect(got[0].correctValue).toBe('Health');

    const money = await retrieveExemplars(OWNER, 'category', 'invoice taxes', { embedFn: fakeEmbed, k: 1 });
    expect(money[0].correctValue).toBe('Finance');
  });

  it('never hands the prompt more than it is allowed', async () => {
    await indexed(Array.from({ length: 10 }, (_, i) => ({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' })));
    expect(await retrieveExemplars(OWNER, 'category', 'gym', { embedFn: fakeEmbed })).toHaveLength(RETRIEVE_K);
  });

  it('falls back to the owner’s most frequent corrections with no embedder', async () => {
    // Sized so BOTH values survive the held-out stride — with one Finance correction
    // the stride would take it and the fixture would be blind to what it claims to test.
    await indexed([
      { text: 'gym workout monday', llm: 'Leisure', final: 'Health' },
      { text: 'gym workout tuesday', llm: 'Leisure', final: 'Health' },
      { text: 'gym workout friday', llm: 'Leisure', final: 'Health' },
      { text: 'quarterly invoice', llm: 'Career', final: 'Finance' },
      { text: 'invoice the client', llm: 'Career', final: 'Finance' },
      { text: 'file the taxes', llm: 'Career', final: 'Finance' },
      { text: 'gym workout sunday', llm: 'Leisure', final: 'Health' },
    ], null);
    const got = await retrieveExemplars(OWNER, 'category', 'gym run', { embedFn: null });
    // Health was corrected three times, Finance once — the coarser question, which is
    // the right thing to lose first when vectors are unavailable.
    expect(got[0].correctValue).toBe('Health');
    expect(got.map((e) => e.correctValue)).toContain('Finance');
  });

  it('falls back rather than failing when the embedder is there but does not answer', async () => {
    await indexed([
      { text: 'gym workout monday', llm: 'Leisure', final: 'Health' },
      { text: 'gym workout tuesday', llm: 'Leisure', final: 'Health' },
    ]);
    const got = await retrieveExemplars(OWNER, 'category', 'gym run', {
      embedFn: async () => { throw new Error('timeout'); },
    });
    expect(got.length).toBeGreaterThan(0);
    expect(got[0].correctValue).toBe('Health');
  });

  it('survives a corrupt index rather than breaking the classification', async () => {
    await indexed([
      { text: 'gym workout monday', llm: 'Leisure', final: 'Health' },
      { text: 'gym workout tuesday', llm: 'Leisure', final: 'Health' },
    ]);
    sqlite.prepare(`UPDATE classification_exemplars SET embedding = ?`).run(Buffer.from([1, 2, 3]));
    // A truncated blob is unreadable, so similarity is impossible — but the rows are
    // still usable exemplars, and nothing throws.
    const got = await retrieveExemplars(OWNER, 'category', 'gym run', { embedFn: fakeEmbed });
    expect(got.length).toBeGreaterThan(0);
  });

  it('on the frequency path, never reads the vectors at all', async () => {
    // The interactive path asks for `embedFn: null` precisely so that it costs one small
    // read. Hide the embedding column: any SELECT that names it now throws, and retrieval
    // turns a throw into "no exemplars". So an answer proves the column was not read.
    await indexed([
      { text: 'gym workout monday', llm: 'Leisure', final: 'Health' },
      { text: 'gym workout tuesday', llm: 'Leisure', final: 'Health' },
      { text: 'gym workout friday', llm: 'Leisure', final: 'Health' },
      { text: 'quarterly invoice', llm: 'Career', final: 'Finance' },
      { text: 'invoice the client', llm: 'Career', final: 'Finance' },
      { text: 'file the taxes', llm: 'Career', final: 'Finance' },
      { text: 'gym workout sunday', llm: 'Leisure', final: 'Health' },
    ]);
    expect(exemplarRows().every((e) => e.embedding !== null)).toBe(true); // vectors ARE stored
    const plain = await retrieveExemplars(OWNER, 'category', 'gym run', { embedFn: null });
    expect(plain.length).toBeGreaterThan(0);

    sqlite.exec(`ALTER TABLE classification_exemplars RENAME COLUMN embedding TO embedding_hidden`);
    try {
      expect(await retrieveExemplars(OWNER, 'category', 'gym run', { embedFn: null })).toEqual(plain);
      expect(await classificationHint(OWNER, 'category', 'gym run', { embedFn: null })).toBe(exemplarPrompt(plain));
      // The poison bites where vectors are wanted, so the assertions above are not vacuous.
      expect(await retrieveExemplars(OWNER, 'category', 'gym run', { embedFn: fakeEmbed })).toEqual([]);
    } finally {
      sqlite.exec(`ALTER TABLE classification_exemplars RENAME COLUMN embedding_hidden TO embedding`);
    }
  });

  it('does not touch a live embedder that is not installed', async () => {
    // The #552 lesson: an UNGATED embed call against an Ollama with no embedder pulled
    // is what made triality-routes look flaky for weeks. With `embedFn` left undefined
    // — the production default — retrieval must ask `embedReady` first and take the
    // frequency path when the answer is no, without ever calling `embed`.
    await indexed([
      { text: 'gym workout monday', llm: 'Leisure', final: 'Health' },
      { text: 'gym workout tuesday', llm: 'Leisure', final: 'Health' },
    ], null);

    const ready = vi.spyOn(ollama, 'embedReady').mockResolvedValue(false);
    const embed = vi.spyOn(ollama, 'embed').mockRejectedValue(new Error('no embedder pulled'));
    try {
      const got = await retrieveExemplars(OWNER, 'category', 'gym run');  // embedFn omitted
      expect(ready).toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
      expect(got.length).toBeGreaterThan(0);   // frequency path still answers
    } finally {
      ready.mockRestore();
      embed.mockRestore();
    }
  });

  it('renders exemplars as corrections, naming both sides', async () => {
    const text = exemplarPrompt([
      { logId: 'l1', inputText: 'gym workout monday', llmValue: 'Leisure', correctValue: 'Health' },
    ]);
    expect(text).toContain('gym workout monday');
    expect(text).toContain('you said Leisure');
    expect(text).toContain('the user chose Health');
    expect(exemplarPrompt([])).toBe('');
  });

  it('keeps one owner’s exemplars out of another’s prompt', async () => {
    createOwner(SECOND_OWNER_ID);
    await indexed([
      { text: 'gym workout monday', llm: 'Leisure', final: 'Health' },
      { text: 'gym workout tuesday', llm: 'Leisure', final: 'Health' },
    ]);
    expect(await classificationHint(SECOND_OWNER_ID, 'category', 'gym run', { embedFn: fakeEmbed })).toBe('');
  });
});

// ── The owner's acceptance test ───────────────────────────────────────────────

describe('the owner’s acceptance test', () => {
  it('correcting a category twice teaches the third similar input', async () => {
    // "Done when: correcting a task's category twice makes the third similar input
    // classify correctly." Two corrections is exactly CORRECTION_FLOOR, so this test
    // fails the moment someone raises the floor without revisiting the promise.
    await evidence({ text: 'gym session before work', llm: 'Leisure', final: 'Health' });
    await evidence({ text: 'gym workout with a trainer', llm: 'Leisure', final: 'Health' });
    expect(CORRECTION_FLOOR).toBe(2);

    await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });

    const hint = await classificationHint(OWNER, 'category', 'gym run tomorrow', { embedFn: fakeEmbed });
    expect(hint).toContain('Health');
    expect(hint).toContain('Leisure');   // names what it got wrong, not just the answer

    // …and the grader, given that hint, now answers Health where it used to say Leisure.
    const answered: string[] = [];
    await calibrateClassification(OWNER, NOW, {
      embedFn: fakeEmbed,
      scoreFn: async ({ hint: h }) => { answered.push(h); return h.includes('Health') ? 'Health' : 'Leisure'; },
    });
    // With only two corrections the stride holds nothing out, so nothing is graded —
    // the hint above is the assertion that matters, and this proves the run is honest
    // about having measured nothing rather than inventing a score.
    expect(accuracyRows().find((r) => r.field === 'category')?.accuracy ?? null).toBeNull();
  });

  it('one correction is a slip, not a lesson', async () => {
    await evidence({ text: 'gym session before work', llm: 'Leisure', final: 'Health' });
    await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    expect(await classificationHint(OWNER, 'category', 'gym run tomorrow', { embedFn: fakeEmbed })).toBe('');
  });
});

// ── Shared helpers ────────────────────────────────────────────────────────────

describe('input and value normalisation', () => {
  it('builds one canonical input string from a title and notes', () => {
    expect(classificationInput('  Gym  ', '  with a trainer ')).toBe('Gym\nwith a trainer');
    expect(classificationInput('Gym', null)).toBe('Gym');
    expect(classificationInput('Gym', '   ')).toBe('Gym');
  });

  it('makes category sets comparable so agreement is decidable', () => {
    expect(canonicalValue(['Health', ' Career '])).toBe('Health, Career');
    expect(canonicalValue('them')).toBe('them');
    expect(canonicalValue(null)).toBe('');
    expect(canonicalValue([])).toBe('');
  });
});

// ── Embed reuse (weekly rebuild optimization) ──────────────────────────────────

describe('embed reuse by log_id', () => {
  /** Counts calls and delegates to the deterministic fakeEmbed, so tests can assert
   *  exactly how many rows a run actually embedded. */
  function countingEmbed(): { fn: (text: string) => Promise<number[]>; calls: () => number } {
    let n = 0;
    return { fn: async (text) => { n++; return fakeEmbed(text); }, calls: () => n };
  }

  it('a second run over an unchanged history re-embeds nothing', async () => {
    for (let i = 0; i < 8; i++) await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' });

    const first = countingEmbed();
    const r1 = await calibrateClassification(OWNER, NOW, { embedFn: first.fn });
    const cat1 = r1.fields.find((f) => f.field === 'category')!;
    expect(first.calls()).toBe(cat1.indexed); // cold index: everything is a fresh embed
    expect(cat1.reused).toBe(0);

    const second = countingEmbed();
    const r2 = await calibrateClassification(OWNER, NOW, { embedFn: second.fn });
    const cat2 = r2.fields.find((f) => f.field === 'category')!;
    // Nothing changed between runs — the embedder is never called at all.
    expect(second.calls()).toBe(0);
    expect(cat2.reused).toBe(cat2.indexed);
    expect(cat2.embedded).toBe(cat2.indexed);
  });

  it('only the NEW correction is embedded when one is added between runs', async () => {
    for (let i = 0; i < 8; i++) await evidence({ text: `gym workout ${i}`, llm: 'Leisure', final: 'Health' });
    await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });

    await evidence({ text: 'brand new correction', llm: 'Leisure', final: 'Health' });

    const second = countingEmbed();
    const r2 = await calibrateClassification(OWNER, NOW, { embedFn: second.fn });
    const cat2 = r2.fields.find((f) => f.field === 'category')!;
    expect(second.calls()).toBe(1); // exactly the one new row
    expect(cat2.reused).toBe(cat2.indexed - 1);
  });

  it('a reused row carries over the SAME vector bytes, not a re-derived one', async () => {
    await evidence({ text: 'gym workout unique-marker', llm: 'Leisure', final: 'Health' });
    for (let i = 0; i < CORRECTION_FLOOR; i++) {
      await evidence({ text: `filler ${i}`, llm: 'Leisure', final: 'Health' });
    }
    await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    const before = exemplarRows().find((r) => r.input_text.includes('unique-marker'))!.embedding;
    expect(before).not.toBeNull();

    // A DIFFERENT embedder on the second run — if the row were re-embedded instead of
    // reused, its bytes would change here. They must not.
    const otherEmbed = async (text: string) => (await fakeEmbed(text)).map((x) => x + 100);
    await calibrateClassification(OWNER, NOW, { embedFn: otherEmbed });
    const after = exemplarRows().find((r) => r.input_text.includes('unique-marker'))!.embedding;
    expect(after).not.toBeNull();
    expect(Buffer.compare(before!, after!)).toBe(0);
  });
});

// ── The accept filter (what quick-add can actually use) ───────────────────────
//
// Quick-add asks for a category from the owner's CURRENT list, so an exemplar whose value
// is no longer on that list (renamed, deleted, muted, or a cleared answer) must never
// reach its prompt as "the user chose X". Retrieval hands back at most k, so the filter
// has to run BEFORE the cut: dropping afterwards would leave the slot empty instead of
// giving it to the next valid lesson.

describe('the accept filter', () => {
  let exSeq = 0;
  beforeEach(() => { exSeq = 0; });

  /**
   * Write one index row directly, so a test controls exactly how often each value was
   * corrected and which row is newest (the frequency path picks the highest log_id of
   * each value, and the ids here ascend with the call order).
   */
  async function exemplar(o: {
    correct: string; text?: string; llm?: string; field?: ClassifiedField; owner?: string; vec?: boolean;
  }): Promise<void> {
    const logId = `ex-${String(exSeq++).padStart(4, '0')}`;
    const text = o.text ?? `${o.correct} chore ${logId}`;
    sqlite.prepare(
      `INSERT INTO classification_exemplars (owner_id, field, log_id, input_text, llm_value, correct_value, embedding, computed_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-08-14')`,
    ).run(
      o.owner ?? OWNER, o.field ?? 'category', logId, text, o.llm ?? 'Leisure', o.correct,
      o.vec ? packVector(await fakeEmbed(text)) : null,
    );
  }

  /** Gardening 3x, Cleaning 2x, Cooking 2x, then one each of Career, Finance, Health:
   *  without a filter the top three by frequency are Gardening, Cleaning, Cooking. */
  async function frequencyIndex(): Promise<void> {
    for (const c of ['Gardening', 'Gardening', 'Gardening', 'Cleaning', 'Cleaning', 'Cooking', 'Cooking', 'Health', 'Finance', 'Career']) {
      await exemplar({ correct: c });
    }
  }

  /** Two Gardening rows sit nearest to the query 'gym run'; three valid values trail them. */
  async function similarityIndex(): Promise<void> {
    await exemplar({ text: 'gym run', correct: 'Gardening', vec: true });
    await exemplar({ text: 'gym workout monday', correct: 'Gardening', vec: true });
    await exemplar({ text: 'gym workout tuesday', correct: 'Health', vec: true });
    await exemplar({ text: 'invoice taxes budget', correct: 'Finance', vec: true });
    await exemplar({ text: 'read book', correct: 'Leisure', vec: true });
  }

  const values = (xs: Exemplar[]) => xs.map((e) => e.correctValue);
  const notGardening = (e: Exemplar) => !['Gardening', 'Cleaning', 'Cooking'].includes(e.correctValue);

  it('changes nothing for a caller that passes no filter, or one that keeps everything', async () => {
    await frequencyIndex();
    const plain = await retrieveExemplars(OWNER, 'category', 'anything', { embedFn: null });
    expect(values(plain)).toEqual(['Gardening', 'Cleaning', 'Cooking']);
    expect(await retrieveExemplars(OWNER, 'category', 'anything', { embedFn: null, accept: undefined })).toEqual(plain);
    expect(await retrieveExemplars(OWNER, 'category', 'anything', { embedFn: null, accept: () => true })).toEqual(plain);

    resetIndex();
    await similarityIndex();
    const nearest = await retrieveExemplars(OWNER, 'category', 'gym run', { embedFn: fakeEmbed });
    expect(nearest).toHaveLength(RETRIEVE_K);
    expect(nearest[0].inputText).toBe('gym run');
    expect(await retrieveExemplars(OWNER, 'category', 'gym run', { embedFn: fakeEmbed, accept: () => true })).toEqual(nearest);
  });

  it('on the frequency path, a lower-ranked valid value takes the slot of a dropped one', async () => {
    await frequencyIndex();
    const got = await retrieveExemplars(OWNER, 'category', 'anything', { embedFn: null, accept: notGardening });
    // Filtering AFTER the cut would have returned nothing: all three slots belonged to
    // the dropped values. Ties among the one-offs break by name.
    expect(values(got)).toEqual(['Career', 'Finance', 'Health']);
  });

  it('still returns the NEWEST lesson of each value it keeps', async () => {
    await exemplar({ correct: 'Health', text: 'old gym note' });
    await exemplar({ correct: 'Health', text: 'new gym note' });
    await exemplar({ correct: 'Gardening' });
    const got = await retrieveExemplars(OWNER, 'category', 'anything', { embedFn: null, accept: notGardening });
    expect(got.map((e) => e.inputText)).toEqual(['new gym note']);
  });

  it('on the similarity path, filters before the cut too', async () => {
    await similarityIndex();
    const unfiltered = await retrieveExemplars(OWNER, 'category', 'gym run', { embedFn: fakeEmbed, k: 1 });
    expect(values(unfiltered)).toEqual(['Gardening']); // the nearest row is a value we are about to refuse

    const top = await retrieveExemplars(OWNER, 'category', 'gym run', {
      embedFn: fakeEmbed, k: 1, accept: (e) => e.correctValue !== 'Gardening',
    });
    expect(values(top)).toEqual(['Health']); // the nearest VALID row, not an empty answer

    const three = await retrieveExemplars(OWNER, 'category', 'gym run', {
      embedFn: fakeEmbed, accept: (e) => e.correctValue !== 'Gardening',
    });
    expect([...values(three)].sort()).toEqual(['Finance', 'Health', 'Leisure']);
  });

  it('says nothing when the filter refuses everything', async () => {
    await frequencyIndex();
    expect(await retrieveExemplars(OWNER, 'category', 'anything', { embedFn: null, accept: () => false })).toEqual([]);
    expect(await classificationHint(OWNER, 'category', 'anything', { embedFn: null, accept: () => false })).toBe('');

    resetIndex();
    await similarityIndex();
    expect(await retrieveExemplars(OWNER, 'category', 'gym run', { embedFn: fakeEmbed, accept: () => false })).toEqual([]);
    expect(await classificationHint(OWNER, 'category', 'gym run', { embedFn: fakeEmbed, accept: () => false })).toBe('');
  });

  it('offers the filter each of the OWNER’s stored rows for the field, and no one else’s', async () => {
    createOwner(SECOND_OWNER_ID);
    await exemplar({ correct: 'Health' });
    await exemplar({ correct: 'Finance' });
    await exemplar({ correct: 'Zebra', owner: SECOND_OWNER_ID });
    await exemplar({ correct: 'them', field: 'motivation' });

    const offered: Exemplar[] = [];
    await retrieveExemplars(OWNER, 'category', 'anything', {
      embedFn: null, accept: (e) => { offered.push(e); return true; },
    });
    expect(offered.map((e) => e.correctValue).sort()).toEqual(['Finance', 'Health']);
    // The filter sees the lesson itself, which is what a vocabulary check needs.
    expect(offered[0]).toMatchObject({ llmValue: 'Leisure' });
    expect(typeof offered[0].inputText).toBe('string');
  });

  it('is passed through by classificationHint, so the rendered text honours it', async () => {
    await frequencyIndex();
    const hint = await classificationHint(OWNER, 'category', 'anything', { embedFn: null, accept: notGardening });
    expect(hint).toContain('the user chose Career.');
    expect(hint).toContain('the user chose Finance.');
    expect(hint).toContain('the user chose Health.');
    for (const dropped of ['Gardening', 'Cleaning', 'Cooking']) expect(hint).not.toContain(`the user chose ${dropped}`);
    // …and without it the same owner is shown exactly what they were shown before.
    const before = await classificationHint(OWNER, 'category', 'anything', { embedFn: null });
    expect(before).toContain('the user chose Gardening.');
    expect(before).not.toContain('Career');
  });

  it('never throws when the filter does', async () => {
    await frequencyIndex();
    const boom = () => { throw new Error('bad predicate'); };
    await expect(retrieveExemplars(OWNER, 'category', 'anything', { embedFn: null, accept: boom })).resolves.toEqual([]);
    await expect(classificationHint(OWNER, 'category', 'anything', { embedFn: null, accept: boom })).resolves.toBe('');
  });

  function resetIndex() {
    sqlite.exec('DELETE FROM classification_exemplars');
    exSeq = 0;
  }
});

// ── The prompt fragment, exactly ─────────────────────────────────────────────

describe('the rendered lesson', () => {
  it('renders an empty answer as (nothing), the way it already rendered an empty claim', () => {
    // A cleared picker is a real answer now ("none of these"), and "the user chose ."
    // reads as a broken sentence to the model.
    const text = exemplarPrompt([{ logId: 'l1', inputText: 'gym workout monday', llmValue: 'Leisure', correctValue: '' }]);
    expect(text).toContain('you said Leisure; the user chose (nothing).');
    expect(text).not.toContain('the user chose .');
    expect(exemplarPrompt([{ logId: 'l2', inputText: 'gym', llmValue: '', correctValue: 'Health' }]))
      .toContain('you said (nothing); the user chose Health.');
  });

  it('is byte-identical for every non-empty value', () => {
    // Pinned as a literal: this text is model-facing in memory enrichment as well as
    // quick-add, so an edit here is a retune, never a tidy-up.
    expect(exemplarPrompt([
      { logId: 'l1', inputText: 'gym workout monday', llmValue: 'Leisure', correctValue: 'Health' },
      { logId: 'l2', inputText: '  quarterly\n invoice ', llmValue: 'Career, Growth', correctValue: 'Finance, Career' },
    ])).toBe(
      '\nThis user has corrected you before. Follow their vocabulary, not your own:\n' +
      '- For "gym workout monday" you said Leisure; the user chose Health.\n' +
      '- For "quarterly invoice" you said Career, Growth; the user chose Finance, Career.\n',
    );
  });
});

// ── Capture with the answer already in hand ──────────────────────────────────

describe('logging an answer along with the claim', () => {
  type AnswerRow = {
    id: string; owner_id: string; task_id: string | null; field: string; input_text: string;
    llm_value: string; final_value: string | null; assigned_at: string; corrected_at: string | null; local_date: string;
  };
  const rows = (owner = OWNER) =>
    sqlite.prepare(`SELECT * FROM classification_log WHERE owner_id = ? ORDER BY assigned_at, id`).all(owner) as AnswerRow[];
  const WEEK_LATER = new Date(NOW.getTime() + 7 * 86_400_000);
  const claim = { taskId: 't1', field: 'category' as const, inputText: 'gym session', llmValue: ['Leisure'] };

  it('writes an OPEN row when the answer is the claim', async () => {
    await logAnsweredAssignment(OWNER, { ...claim, finalValue: ['Leisure'] }, NOW);
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row).toMatchObject({
      owner_id: OWNER, task_id: 't1', field: 'category', input_text: 'gym session',
      llm_value: 'Leisure', final_value: null, corrected_at: null,
      assigned_at: NOW.toISOString(), local_date: '2026-08-14',
    });
    // Exactly the row logAssignment writes: pending for 24h, a weak accept after.
    expect(rowOutcome(row, NOW)).toBeNull();
    expect(rowOutcome(row, WEEK_LATER)).toBe('accepted');
    expect(await decidedRows(OWNER, 'category', NOW)).toEqual([]);
    expect((await decidedRows(OWNER, 'category', WEEK_LATER)).map((r) => r.corrected)).toEqual([false]);
  });

  it('calls spelling variants of the claim agreement, not a correction', async () => {
    await logAnsweredAssignment(OWNER, { ...claim, taskId: 't1', finalValue: 'Leisure' }, NOW);
    await logAnsweredAssignment(OWNER, { ...claim, taskId: 't2', finalValue: [' Leisure '] }, NOW);
    await logAnsweredAssignment(OWNER, { ...claim, taskId: 't3', llmValue: ['Leisure', 'Health'], finalValue: 'Leisure, Health' }, NOW);
    expect(rows().map((r) => [r.final_value, r.corrected_at])).toEqual([[null, null], [null, null], [null, null]]);
  });

  it('writes a row already CLOSED when the answer differs, so it is a correction at once and for good', async () => {
    await logAnsweredAssignment(OWNER, { ...claim, finalValue: ['Health'] }, NOW);
    const [row] = rows();
    expect(rows()).toHaveLength(1);
    expect(row.llm_value).toBe('Leisure');
    expect(row.final_value).toBe('Health');
    // One instant for both: the owner answered at the moment the claim was made.
    expect(row.corrected_at).toBe(NOW.toISOString());
    expect(row.assigned_at).toBe(NOW.toISOString());
    expect(rowOutcome(row, NOW)).toBe('corrected');
    expect(rowOutcome(row, WEEK_LATER)).toBe('corrected');   // never ages into an accept
    expect(await decidedRows(OWNER, 'category', NOW)).toMatchObject([{ correctValue: 'Health', corrected: true }]);
  });

  it('treats a reorder as a correction, because category sets are ordered', async () => {
    await logAnsweredAssignment(OWNER, { ...claim, llmValue: ['Leisure', 'Health'], finalValue: ['Health', 'Leisure'] }, NOW);
    const [row] = rows();
    expect(row.llm_value).toBe('Leisure, Health');
    expect(row.final_value).toBe('Health, Leisure');
    expect(rowOutcome(row, NOW)).toBe('corrected');
  });

  it('records an emptied answer as an answer ("" and not NULL), with [] or with null', async () => {
    await logAnsweredAssignment(OWNER, { ...claim, taskId: 't1', finalValue: [] }, NOW);
    await logAnsweredAssignment(OWNER, { ...claim, taskId: 't2', finalValue: null }, NOW);
    for (const row of rows()) {
      expect(row.final_value).toBe('');
      expect(row.corrected_at).toBe(NOW.toISOString());
      expect(rowOutcome(row, WEEK_LATER)).toBe('corrected');
    }
    expect((await decidedRows(OWNER, 'category', NOW)).map((r) => [r.correctValue, r.corrected])).toEqual([['', true], ['', true]]);
  });

  it('stores an array claim in its canonical, comma-joined form', async () => {
    await logAnsweredAssignment(OWNER, { ...claim, llmValue: [' Leisure ', 'Health'], finalValue: ['Health'] }, NOW);
    expect(rows()[0].llm_value).toBe('Leisure, Health');
  });

  it('claims nothing when there is no claim or nothing to judge', async () => {
    await logAnsweredAssignment(OWNER, { ...claim, llmValue: [], finalValue: ['Health'] }, NOW);
    await logAnsweredAssignment(OWNER, { ...claim, llmValue: '', finalValue: ['Health'] }, NOW);
    await logAnsweredAssignment(OWNER, { ...claim, llmValue: ['  '], finalValue: ['Health'] }, NOW);
    await logAnsweredAssignment(OWNER, { ...claim, inputText: '   ', finalValue: ['Health'] }, NOW);
    await logAnsweredAssignment(OWNER, { ...claim, inputText: '', finalValue: null }, NOW);
    expect(rows()).toHaveLength(0);
  });

  it('writes the same row the two-step form writes, so nothing downstream can tell them apart', async () => {
    await logAnsweredAssignment(OWNER, { ...claim, taskId: 'one-step', finalValue: ['Health'] }, NOW);
    await logAssignment(OWNER, { ...claim, taskId: 'two-step' }, NOW);
    await recordCorrection(OWNER, 'two-step', 'category', ['Health'], NOW);
    const shape = (r: AnswerRow) => ({ ...r, id: '', task_id: '' });
    const [a, b] = [rows().find((r) => r.task_id === 'one-step')!, rows().find((r) => r.task_id === 'two-step')!];
    expect(shape(a)).toEqual(shape(b));
  });

  it('judges agreement exactly as the two-step form and rowOutcome do, case and all', async () => {
    // One equality for the whole house: a pair the existing capture path calls a
    // correction must be a correction here too, whatever the spelling.
    const pairs: [string | string[], string | string[] | null][] = [
      ['Leisure', 'Leisure'],
      ['Leisure', 'leisure'],                    // case matters
      [['Leisure', 'Health'], ['Health', 'Leisure']], // order matters
      [['Leisure', 'Health'], ['Leisure']],
      [['Leisure'], []],
      ['Leisure', null],
      ['Leisure, Health', ['Leisure', 'Health']], // spelling of the same set does not
      [[' Leisure '], ['Leisure']],
    ];
    for (const [i, [llm, final]] of pairs.entries()) {
      await logAnsweredAssignment(OWNER, { ...claim, taskId: `one-${i}`, llmValue: llm, finalValue: final }, NOW);
      await logAssignment(OWNER, { ...claim, taskId: `two-${i}`, llmValue: llm }, NOW);
      await recordCorrection(OWNER, `two-${i}`, 'category', final, NOW);
    }
    const all = rows();
    for (const [i, pair] of pairs.entries()) {
      const one = all.find((r) => r.task_id === `one-${i}`)!;
      const two = all.find((r) => r.task_id === `two-${i}`)!;
      expect(rowOutcome(one, WEEK_LATER), JSON.stringify(pair)).toBe(rowOutcome(two, WEEK_LATER));
      expect(one.llm_value).toBe(two.llm_value);
      // Settled the same way too: born closed exactly when the two-step form's answer differs.
      expect(one.final_value === null, JSON.stringify(pair)).toBe(two.final_value === two.llm_value);
    }
  });

  it('keeps the owner’s first answer: a closed row cannot be re-answered, an open one can', async () => {
    await logAnsweredAssignment(OWNER, { ...claim, taskId: 'closed', finalValue: ['Health'] }, NOW);
    await logAnsweredAssignment(OWNER, { ...claim, taskId: 'open', finalValue: ['Leisure'] }, NOW);

    expect(await recordCorrection(OWNER, 'closed', 'category', ['Finance'], NOW)).toBe(false);
    expect(rows().find((r) => r.task_id === 'closed')!.final_value).toBe('Health');

    // An equal row is just an open assignment: the next edit of the task is the answer.
    expect(await recordCorrection(OWNER, 'open', 'category', ['Finance'], NOW)).toBe(true);
    const reopened = rows().find((r) => r.task_id === 'open')!;
    expect(reopened.final_value).toBe('Finance');
    expect(rowOutcome(reopened, NOW)).toBe('corrected');
  });

  it('belongs to the owner it is logged for', async () => {
    createOwner(SECOND_OWNER_ID);
    await logAnsweredAssignment(SECOND_OWNER_ID, { ...claim, finalValue: ['Health'] }, NOW);
    expect(rows(OWNER)).toHaveLength(0);
    expect(rows(SECOND_OWNER_ID).map((r) => r.owner_id)).toEqual([SECOND_OWNER_ID]);
  });

  it('never throws when the log cannot be written', async () => {
    sqlite.exec(`ALTER TABLE classification_log RENAME TO classification_log_hidden`);
    try {
      await expect(logAnsweredAssignment(OWNER, { ...claim, finalValue: ['Health'] }, NOW)).resolves.toBeUndefined();
      await expect(logAnsweredAssignment(OWNER, { ...claim, finalValue: ['Leisure'] }, NOW)).resolves.toBeUndefined();
    } finally {
      sqlite.exec(`ALTER TABLE classification_log_hidden RENAME TO classification_log`);
    }
  });

  it('teaches the calibration exactly as recorded corrections do', async () => {
    await logAnsweredAssignment(OWNER, { ...claim, taskId: 'a', inputText: 'gym session before work', finalValue: ['Health'] }, NOW);
    await logAnsweredAssignment(OWNER, { ...claim, taskId: 'b', inputText: 'gym workout with a trainer', finalValue: ['Health'] }, NOW);
    const r = await calibrateClassification(OWNER, NOW, { embedFn: fakeEmbed });
    const cat = r.fields.find((f) => f.field === 'category')!;
    expect(cat.corrections).toBe(CORRECTION_FLOOR);
    expect(cat.indexed).toBe(CORRECTION_FLOOR);
    expect(exemplarRows().map((e) => [e.llm_value, e.correct_value])).toEqual([['Leisure', 'Health'], ['Leisure', 'Health']]);
    const hint = await classificationHint(OWNER, 'category', 'gym run tomorrow', { embedFn: fakeEmbed });
    expect(hint).toContain('you said Leisure; the user chose Health.');
  });
});
