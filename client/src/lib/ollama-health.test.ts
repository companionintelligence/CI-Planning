import { describe, it, expect } from 'vitest';
import { ollamaHealth, ollamaHealthDescription } from './ollama-health.js';
import type { Integrations } from './api.js';

/**
 * The Ollama health states Settings renders. Until this file, nothing pinned them at all —
 * the three-way choice lived as inline ternaries in a 2000-line view with no test file.
 *
 * The state that matters is the middle one. `available` (Ollama answered) and `ready` (the
 * models it would use are pulled) are different, and collapsing them is a real regression
 * with a real history: a reachable Ollama with nothing pulled rendered a green tick over
 * completely dead AI features. If someone "simplifies" this back to a boolean, the
 * `unusable` cases below fail.
 */

const base = (ollama: Partial<Integrations['ollama']>): Integrations =>
  ({
    ollama: {
      available: true,
      models: ['llama3.2:latest'],
      fastModel: 'llama3.2:latest',
      qualityModel: 'llama3.1:latest',
      embedModel: 'nomic-embed-text',
      ...ollama,
    },
  }) as Integrations;

describe('ollamaHealth', () => {
  it('is down when the resource has not loaded — fail closed', () => {
    // Before the first read lands, AI controls must stay hidden rather than dangle.
    expect(ollamaHealth(undefined)).toBe('down');
  });

  it('is down when Ollama did not answer', () => {
    expect(ollamaHealth(base({ available: false, ready: false }))).toBe('down');
  });

  it('is UNUSABLE when Ollama answered but the models are not pulled', () => {
    // The state this whole three-way split exists for.
    expect(ollamaHealth(base({ available: true, ready: false }))).toBe('unusable');
  });

  it('is ready when Ollama answered and the models are pulled', () => {
    expect(ollamaHealth(base({ available: true, ready: true }))).toBe('ready');
  });

  it('believes a server that says ready:false — it does not fall back to available', () => {
    // The regression guard: `ready ?? available` must not become `available`.
    expect(ollamaHealth(base({ available: true, ready: false }))).not.toBe('ready');
  });

  it('falls back to available only when the server omits ready entirely', () => {
    // An older server than this client: absent field, not a false one.
    expect(ollamaHealth(base({ available: true, ready: undefined }))).toBe('ready');
  });
});

describe('ollamaHealthDescription', () => {
  it('tells you how to start Ollama when it is down', () => {
    expect(ollamaHealthDescription(base({ available: false }))).toMatch(/start Ollama/i);
  });

  it('NAMES the missing models when running but unusable', () => {
    // "AI features are off" without saying which model to pull is the same dead end as the
    // green-tick-over-nothing this replaced.
    const text = ollamaHealthDescription(
      base({ available: true, ready: false, missingModels: ['qwen2.5:0.5b', 'gemma3n:e4b'] }),
    );
    expect(text).toContain('qwen2.5:0.5b');
    expect(text).toContain('gemma3n:e4b');
    expect(text).toMatch(/not installed/i);
  });

  it('degrades honestly when unusable but the server did not say which model', () => {
    const text = ollamaHealthDescription(base({ available: true, ready: false }));
    expect(text).toMatch(/not installed/i);
    expect(text).not.toContain('undefined');
  });

  it('reports the effective models when ready, in fast/quality vocabulary', () => {
    const text = ollamaHealthDescription(
      base({ available: true, ready: true, models: ['a', 'b', 'c'] }),
    );
    expect(text).toContain('3 models');
    expect(text).toContain('fast: llama3.2:latest');
    expect(text).toContain('quality: llama3.1:latest');
    // The tier rename is user-visible; the old vocabulary must not come back.
    expect(text).not.toMatch(/\bsmall\b|\bmedium\b/);
  });
});
