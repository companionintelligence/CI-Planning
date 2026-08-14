/**
 * `agents/tags.ts` · suggestTags — how this surface COMPOSES the shared never-invent rule.
 *
 * The shared rule itself (`constrainToVocabulary`) is covered directly by `constrain.test.ts`;
 * what is pinned here is the composition at this call site, because this call site is a WRITE
 * path: `services/auto-tag.ts` feeds `suggestTags` into `tagUntaggedTasks`, which inserts
 * `entity_tags` rows for both the Tasks view's Auto-tag button and the hourly `tag_tasks` cron.
 * "One more answer survives the allow-list" therefore means "one more tag gets written
 * automatically", so the exact set that survives is behaviour, not an implementation detail.
 *
 * The Ollama `generateJson` seam is mocked as a configurable vi.fn (the pattern
 * `render-copy.test.ts` uses) so each test drives a specific model answer. Nothing here touches a
 * live Ollama — the suite stays offline and the assertions stay deterministic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../src/mcp/ollama.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/mcp/ollama.js')>();
  return { ...mod, generateJson: vi.fn() };
});

import { generateJson } from '../src/mcp/ollama.js';
import { suggestTags } from '../src/agents/tags.js';
import { mergeTags } from '../src/services/auto-tag.js';

const mockGenerateJson = generateJson as unknown as ReturnType<typeof vi.fn>;

/** The owner's vocabulary, deliberately capitalised — the model's answers below are not. */
const VOCAB = ['Finance', 'Email', 'Deep-Work'];

/** The prompt string handed to the model on the Nth call. */
const promptAt = (n = 0) => mockGenerateJson.mock.calls[n][0] as string;

beforeEach(() => {
  mockGenerateJson.mockReset();
});

// ── The allow-list, as this surface applies it ───────────────────────────────

describe('suggestTags vocabulary match', () => {
  // ⚠️ DELIBERATE DECISION (2026-08-14, PR #525) — do NOT "fix" this to a case-sensitive
  // match. Before #525 a model answering "finance" for a tag named "Finance" was silently
  // dropped, which is a latent bug: the answer is right and the casing is the model's, not
  // the owner's. The match is now case-INSENSITIVE and the returned name is the OWNER's
  // casing, never the model's. Reverting the shared rule to an exact match fails here.
  it('keeps an answer whose casing differs from the vocabulary, returned in the VOCABULARY\'s casing', async () => {
    mockGenerateJson.mockResolvedValue({ tags: ['finance', 'DEEP-WORK'] });

    expect(await suggestTags('Reconcile the quarterly numbers', VOCAB)).toEqual(['Finance', 'Deep-Work']);
  });

  // The never-invent rule: a suggester that can mint names is a second author of the
  // owner's taxonomy. Widening the match on casing must not widen it on membership.
  it('drops a name the owner does not have', async () => {
    mockGenerateJson.mockResolvedValue({ tags: ['finance', 'Budgeting'] });

    expect(await suggestTags('Reconcile the quarterly numbers', VOCAB)).toEqual(['Finance']);
  });

  // The dedupe key is the lowercased name, so the case-insensitive match cannot turn one
  // tag into several rows on the write path.
  it('collapses repeats that differ only by case to a single entry', async () => {
    mockGenerateJson.mockResolvedValue({ tags: ['finance', 'Finance', 'FINANCE'] });

    expect(await suggestTags('Reconcile the quarterly numbers', VOCAB)).toEqual(['Finance']);
  });

  // Small local models pad list items; trimming is part of "the answer is right, the
  // formatting is the model's".
  it('tolerates leading and trailing whitespace in the answer', async () => {
    mockGenerateJson.mockResolvedValue({ tags: ['  finance ', '\tEmail\n'] });

    expect(await suggestTags('Reconcile the quarterly numbers', VOCAB)).toEqual(['Finance', 'Email']);
  });

  // Every caller is a best-effort overlay, so a malformed answer degrades to "no
  // suggestions" — it must never throw into the Auto-tag sweep mid-batch.
  it('yields [] for a non-array answer, and skips non-string elements, rather than throwing', async () => {
    mockGenerateJson.mockResolvedValue({ tags: 'finance' });
    await expect(suggestTags('Reconcile the quarterly numbers', VOCAB)).resolves.toEqual([]);

    mockGenerateJson.mockResolvedValue({});
    await expect(suggestTags('Reconcile the quarterly numbers', VOCAB)).resolves.toEqual([]);

    mockGenerateJson.mockResolvedValue({ tags: [42, null, { name: 'Finance' }, 'finance'] });
    await expect(suggestTags('Reconcile the quarterly numbers', VOCAB)).resolves.toEqual(['Finance']);
  });
});

// ── The input guard (tags.ts:27) ─────────────────────────────────────────────

describe('suggestTags input guard', () => {
  // Not merely "returns []": the sweep calls this once per untagged task, so an empty
  // title or an owner with no tags must not spend a model round-trip to learn there is
  // nothing to answer with.
  it('short-circuits an empty title or an empty vocabulary WITHOUT calling the model', async () => {
    expect(await suggestTags('', VOCAB)).toEqual([]);
    expect(await suggestTags('   ', VOCAB)).toEqual([]); // whitespace-only is empty
    expect(await suggestTags('Reconcile the quarterly numbers', [])).toEqual([]);

    expect(mockGenerateJson).not.toHaveBeenCalled();
  });
});

// ── The grounding guard (tags.ts:31) ─────────────────────────────────────────

describe('suggestTags direction grounding', () => {
  // Defining Work/Home/Community while none of them are pickable would invite the model to
  // answer with a name the allow-list then silently drops — a prompt that asks for what it
  // will not accept. So the grounding rides on the OFFERED vocabulary, not on the caller's
  // direction list.
  it('grounds the direction axis only when the offered vocabulary actually contains those directions', async () => {
    mockGenerateJson.mockResolvedValue({ tags: [] });

    await suggestTags('Reconcile the quarterly numbers', ['Work', ...VOCAB], ['Work']);
    expect(promptAt(0)).toContain("One of these is the task's life area");
    expect(promptAt(0)).toContain('Direction meanings');

    // Same directions argument, but the vocabulary on offer has no direction in it.
    await suggestTags('Reconcile the quarterly numbers', VOCAB, ['Work']);
    expect(promptAt(1)).not.toContain("One of these is the task's life area");
    expect(promptAt(1)).not.toContain('Direction meanings');

    // The pickable test is itself case-insensitive, for the same reason as the match above:
    // a differently-cased direction name is the same direction.
    await suggestTags('Reconcile the quarterly numbers', ['Work', ...VOCAB], ['work']);
    expect(promptAt(2)).toContain('Direction meanings');
  });
});

// ── The downstream invariant — why the accepted change is SAFE ───────────────

describe('suggestTags → mergeTags (services/auto-tag.ts:142)', () => {
  // This is the assertion that makes the 2026-08-14 decision provably safe. `mergeTags`
  // re-filters against the same `names` list case-SENSITIVELY (`new Set(vocabulary).has(t)`),
  // so if `suggestTags` returned the MODEL's casing, every case-corrected suggestion would be
  // silently thrown away one line later and the accepted fix would be a no-op. Because the
  // canonical name is a member of the vocabulary by construction, it survives.
  it('a canonically-cased suggestion survives the case-SENSITIVE downstream filter', async () => {
    mockGenerateJson.mockResolvedValue({ tags: ['finance'] });

    const llm = await suggestTags('Reconcile the quarterly numbers', VOCAB);
    expect(llm).toEqual(['Finance']);
    expect(mergeTags(llm, [], VOCAB)).toEqual(['Finance']);

    // The counter-example that shows the filter is real, not incidentally permissive: the
    // model's own casing would NOT have survived it.
    expect(mergeTags(['finance'], [], VOCAB)).toEqual([]);
  });
});
