import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import { resetDb } from './helpers.js';
import { extractTasks, type ExtractSource } from '../src/agents/extract.js';

/**
 * Close-loop wave, ticket 5 — threading ticket 4's rendered `dismissalHint()` into the
 * extraction prompt. `buildPrompt` itself is not exported (it stays a private
 * prompt-builder inside agents/extract.ts), so every prompt-shape assertion below goes
 * through the same seam production does: the prompt handed to `generateJson`.
 *
 * Partial mock, NOT a wholesale replacement (the llm-9 lesson, README-llm-wave.md):
 * `extractTasks` doesn't call `llmOrNull` itself, but `ingest.ts`'s `runExtraction` does,
 * so spreading the original keeps `llmOrNull` defined for the end-to-end tests below.
 */
const { prompts, ollamaControl } = vi.hoisted(() => ({
  prompts: [] as string[],
  // Flipped by one test to simulate Ollama being unreachable, so `llmOrNull` degrades
  // to `fallbackTask` even though a hint was resolved for the item.
  ollamaControl: { unavailable: false },
}));
vi.mock('../src/mcp/ollama.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mcp/ollama.js')>();
  return {
    ...actual,
    generateJson: vi.fn(async (prompt: string) => {
      if (ollamaControl.unavailable) throw new actual.OllamaUnavailable('Ollama unreachable (test)');
      prompts.push(prompt);
      return { tasks: [{ title: 'Renew the license', priority: 3, tags: [], confidence: 0.8 }] };
    }),
  };
});

/**
 * Partial mock of the ticket-4 service: real `dismissalHint`/`retrieveDismissals` by
 * default (so the "reaches the real prompt" and "no exemplars" tests exercise the real
 * retrieval path over seeded rows), with a hoisted flag one test flips to force a throw
 * — proving `runExtraction`'s resolver guard, not `dismissalHint`'s own internal one
 * (already covered by dismissal-hint.test.ts).
 */
const { hintControl } = vi.hoisted(() => ({ hintControl: { throwing: false } }));
vi.mock('../src/services/dismissal-learning.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/dismissal-learning.js')>();
  return {
    ...actual,
    dismissalHint: async (ownerId: string, text: string, opts?: Record<string, unknown>) => {
      if (hintControl.throwing) throw new Error('dismissal hint resolver exploded');
      return actual.dismissalHint(ownerId, text, opts);
    },
  };
});

import { ingestText } from '../src/agents/ingest.js';

const SOURCE: ExtractSource = {
  kind: 'text',
  ref: 'note-1',
  text: 'Please remember to renew the domain license before it lapses.',
};

const HINT =
  '\nThis user has dismissed suggestions like these before:\n' +
  '- You once suggested a task from something like this: renew car registration — the user dismissed it.\n';

let seq = 0;

/** Insert one `possible_dismissal_exemplars` row directly — the rollup shape
 *  `calibrateDismissals` (ticket 3) writes, without running the batch pass. Mirrors
 *  dismissal-hint.test.ts's own `seedExemplar` helper. */
function seedExemplar(text: string, owner: string = SYSTEM_OWNER): void {
  sqlite
    .prepare(
      `INSERT INTO possible_dismissal_exemplars (owner_id, log_id, input_text, source_kind, embedding, computed_date)
       VALUES (?, ?, ?, ?, NULL, '2026-08-14')`,
    )
    .run(owner, `ex-${seq++}`, text, 'text');
}

const run = <T>(fn: () => Promise<T>) => runWithOwner(SYSTEM_OWNER, ALL_SCOPES, fn);

beforeEach(() => {
  resetDb();
  prompts.length = 0;
  hintControl.throwing = false;
  ollamaControl.unavailable = false;
  seq = 0;
});

describe('buildPrompt hint injection (unit, via extractTasks)', () => {
  it('is byte-identical whether hint is omitted or explicitly empty', async () => {
    await extractTasks(SOURCE, {});
    const withoutHint = prompts[0];
    prompts.length = 0;
    await extractTasks(SOURCE, { hint: '' });
    expect(prompts[0]).toBe(withoutHint);
  });

  it('contains the hint text, placed after the fence and before the shape spec, with the shape contract still last', async () => {
    await extractTasks(SOURCE, { hint: HINT });
    const prompt = prompts[0];
    expect(prompt).toContain(HINT.trim());

    const fenceClose = prompt.lastIndexOf('"""');
    const hintIdx = prompt.indexOf('This user has dismissed');
    const shapeIdx = prompt.indexOf('Extract actionable to-dos');
    expect(fenceClose).toBeGreaterThan(-1);
    expect(hintIdx).toBeGreaterThan(fenceClose);
    expect(hintIdx).toBeLessThan(shapeIdx);

    const lines = prompt.split('\n');
    expect(lines[lines.length - 1]).toBe('If there are no actionable to-dos, respond with {"tasks":[]}.');
  });

  it('leaves the fenced content untouched when a hint is present', async () => {
    await extractTasks(SOURCE, {});
    const bareFence = prompts[0].slice(prompts[0].indexOf('"""'), prompts[0].lastIndexOf('"""') + 3);
    prompts.length = 0;
    await extractTasks(SOURCE, { hint: HINT });
    const hintedFence = prompts[0].slice(prompts[0].indexOf('"""'), prompts[0].lastIndexOf('"""') + 3);
    expect(hintedFence).toBe(bareFence);
  });

  it('normalize() / ExtractedTask are untouched — a well-formed task still comes back', async () => {
    const tasks = await extractTasks(SOURCE, { hint: HINT });
    expect(tasks).toEqual([
      {
        title: 'Renew the license',
        summary: undefined,
        priority: 3,
        dueAt: null,
        estimatedMinutes: null,
        tags: [],
        confidence: 0.8,
      },
    ]);
  });
});

describe('runExtraction wiring (end-to-end, via ingestText)', () => {
  it('with no rollup, the prompt is unchanged from today\'s', async () => {
    await run(() => ingestText(SOURCE.text, SOURCE.ref));
    expect(prompts).toHaveLength(1);
    const viaIngest = prompts[0];
    expect(viaIngest).not.toContain('dismissed suggestions');

    // Byte-identical to a direct extractTasks(SOURCE, {}) call — the no-rollup case
    // must read exactly like a caller who never passes a hint at all.
    prompts.length = 0;
    await extractTasks(SOURCE, {});
    expect(prompts[0]).toBe(viaIngest);
  });

  it('threads a seeded exemplar into the real prompt', async () => {
    seedExemplar('renew car registration');
    await run(() => ingestText(SOURCE.text, SOURCE.ref));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('This user has dismissed suggestions like these before');
    expect(prompts[0]).toContain('renew car registration');

    // Still ends with the shape contract even when hinted.
    const lines = prompts[0].split('\n');
    expect(lines[lines.length - 1]).toBe('If there are no actionable to-dos, respond with {"tasks":[]}.');
  });

  it('a throwing hint resolver does not break extraction', async () => {
    seedExemplar('renew car registration');
    hintControl.throwing = true;
    const result = await run(() => ingestText(SOURCE.text, SOURCE.ref));
    expect(result.itemsProcessed).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('dismissed suggestions'); // degraded to no hint, not a crash
  });

  it('no Ollama: behaviour is unchanged (fallbackTask) even with a hint resolved', async () => {
    // A hint IS resolved for this item (proving the new plumbing runs), but
    // generateJson throws OllamaUnavailable, so llmOrNull must still degrade to
    // fallbackTask exactly as it did before this ticket — the hint never reaches a
    // response because there is no model call to receive it.
    seedExemplar('renew car registration');
    ollamaControl.unavailable = true;
    const result = await run(() => ingestText(SOURCE.text, SOURCE.ref));
    expect(result.itemsProcessed).toBe(1);
    expect(prompts).toHaveLength(0); // generateJson threw before ever recording a prompt

    const row = sqlite
      .prepare(`SELECT raw_title, confidence FROM possible_tasks WHERE source_ref LIKE ?`)
      .get<{ raw_title: string; confidence: number }>(`${SOURCE.ref}%`);
    // fallbackTask's signature: confidence 0.3, title taken from the raw text/subject.
    expect(row?.confidence).toBe(0.3);
    expect(row?.raw_title).toBe(SOURCE.text);
  });
});
