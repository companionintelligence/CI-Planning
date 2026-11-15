import { describe, it, expect } from 'vitest';
import { HINT_MODELS, hintModels, modelUsesHint } from '../src/agents/quickadd-hint-models.js';

/**
 * The allow-list of models quick add shows the hint to (2 Nov 2026, docs/quickadd-hint-guard-2026-11.md).
 * Three of six models measured used it and three answered worse, with no pattern in size, so the list is of
 * names and everything else is "no". These are the names, the matching rule and the one way to add to it.
 */
describe('the models the hint was measured on', () => {
  it('are the three that gained from it', () => {
    expect([...HINT_MODELS]).toEqual(['gemma3n:e4b', 'qwen2.5:3b', 'gemma3:4b']);
    for (const m of HINT_MODELS) expect(modelUsesHint(m, {})).toBe(true);
  });

  it('exclude the three that answered worse with it, and everything not measured', () => {
    // qwen2.5:0.5b answered a number, gemma3:1b lost its valid direction, llama3.2:3b answered null.
    for (const m of ['qwen2.5:0.5b', 'gemma3:1b', 'llama3.2:3b']) expect(modelUsesHint(m, {}), m).toBe(false);
    // Not measured: a larger model, a sibling tag, another family.
    for (const m of ['qwen3-coder:30b', 'gemma3n:e2b', 'qwen2.5:7b', 'gemma3:12b', 'llama3.1:8b', 'mystery:latest']) {
      expect(modelUsesHint(m, {}), m).toBe(false);
    }
  });

  it('do not depend on size: llama3.2:3b (3.2B) is out and qwen2.5:3b (3.1B) is in', () => {
    expect(modelUsesHint('qwen2.5:3b', {})).toBe(true);
    expect(modelUsesHint('llama3.2:3b', {})).toBe(false);
  });
});

describe('matching a name', () => {
  it('ignores case and surrounding space', () => {
    expect(modelUsesHint('  Gemma3n:E4B ', {})).toBe(true);
    expect(modelUsesHint('QWEN2.5:3B', {})).toBe(true);
  });

  it('reads a name with no tag as its :latest, as Ollama does, and a tag is not a prefix match', () => {
    expect(modelUsesHint('gemma3n', {})).toBe(false); // gemma3n:latest is not gemma3n:e4b
    expect(modelUsesHint('gemma3n:e4b-it-q4_K_M', {})).toBe(false);
    expect(modelUsesHint('gemma3n:e4b:extra', {})).toBe(false);
    expect(modelUsesHint('mystery', { QUICK_ADD_HINT_MODELS: 'mystery:latest' })).toBe(true);
    expect(modelUsesHint('mystery:latest', { QUICK_ADD_HINT_MODELS: 'mystery' })).toBe(true);
  });

  it('says no to a missing or blank name', () => {
    for (const m of [undefined, null, '', '   ']) expect(modelUsesHint(m, {})).toBe(false);
  });
});

describe('QUICK_ADD_HINT_MODELS', () => {
  it('adds the names it lists, comma separated, and keeps the measured ones', () => {
    const env = { QUICK_ADD_HINT_MODELS: 'llama3.2:3b, qwen3-coder:30b ,,' };
    expect(modelUsesHint('llama3.2:3b', env)).toBe(true);
    expect(modelUsesHint('qwen3-coder:30b', env)).toBe(true);
    expect(modelUsesHint('gemma3n:e4b', env)).toBe(true);
    expect(modelUsesHint('qwen2.5:0.5b', env)).toBe(false);
    expect(hintModels(env)).toEqual(['gemma3n:e4b', 'qwen2.5:3b', 'gemma3:4b', 'llama3.2:3b', 'qwen3-coder:30b']);
  });

  it('has no wildcard: "*" or "all" name no model, because "every model" is the state that hurt half of them', () => {
    for (const v of ['*', 'all', 'ALL', 'true', '1']) {
      expect(modelUsesHint('qwen2.5:0.5b', { QUICK_ADD_HINT_MODELS: v }), v).toBe(false);
      expect(modelUsesHint('llama3.2:3b', { QUICK_ADD_HINT_MODELS: v }), v).toBe(false);
    }
  });

  it('dedupes, and an unset or empty value adds nothing', () => {
    expect(hintModels({ QUICK_ADD_HINT_MODELS: 'GEMMA3N:E4B,gemma3n:e4b' })).toEqual(['gemma3n:e4b', 'qwen2.5:3b', 'gemma3:4b']);
    expect(hintModels({})).toEqual(['gemma3n:e4b', 'qwen2.5:3b', 'gemma3:4b']);
    expect(hintModels({ QUICK_ADD_HINT_MODELS: '' })).toEqual(['gemma3n:e4b', 'qwen2.5:3b', 'gemma3:4b']);
  });

  it('is read at the call, so setting it needs no restart of the module', () => {
    const before = process.env.QUICK_ADD_HINT_MODELS;
    try {
      delete process.env.QUICK_ADD_HINT_MODELS;
      expect(modelUsesHint('llama3.2:3b')).toBe(false);
      process.env.QUICK_ADD_HINT_MODELS = 'llama3.2:3b';
      expect(modelUsesHint('llama3.2:3b')).toBe(true);
    } finally {
      if (before === undefined) delete process.env.QUICK_ADD_HINT_MODELS; else process.env.QUICK_ADD_HINT_MODELS = before;
    }
  });
});
