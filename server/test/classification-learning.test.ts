import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import {
  calibrateClassification, canonicalValue, classificationHint, classificationInput,
  decidedRows, exemplarPrompt, logAssignment, recordCorrection, retrieveExemplars, rowOutcome,
  CORRECTION_FLOOR, HELD_OUT_STRIDE, LEARNING_WINDOW_DAYS, MAX_EXEMPLARS, PENDING_MS, RETRIEVE_K,
  type ClassifiedField,
} from '../src/services/classification-learning.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';
import { ollama } from '../src/mcp/ollama.js';

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
