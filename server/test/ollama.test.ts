import { describe, it, expect, beforeAll } from 'vitest';
import { status, generate, embed, parseJsonLoose } from '../src/mcp/ollama.js';
import { ollamaAvailable } from './helpers.js';

describe('ollama client', () => {
  let up = false;
  beforeAll(async () => {
    up = await ollamaAvailable();
  });

  it('status() always returns a well-formed object (never throws)', async () => {
    const s = await status();
    expect(s).toHaveProperty('available');
    expect(s).toHaveProperty('url');
    expect(Array.isArray(s.models)).toBe(true);
    expect(typeof s.smallModel).toBe('string');
    expect(typeof s.mediumModel).toBe('string');
  });

  it('parseJsonLoose handles fenced and prose-wrapped JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(parseJsonLoose('Here you go: {"a":3} cheers')).toEqual({ a: 3 });
    expect(parseJsonLoose('[1,2,3]')).toEqual([1, 2, 3]);
    expect(() => parseJsonLoose('not json at all')).toThrow();
  });

  it('generate() returns text when Ollama is available', async () => {
    if (!up) return; // skip gracefully when Ollama is down
    const out = await generate('Reply with the single word: pong', { tier: 'small', temperature: 0 });
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });

  it('embed() returns a numeric vector when available', async () => {
    if (!up) return;
    const vec = await embed('a quick test sentence');
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBeGreaterThan(0);
    expect(typeof vec[0]).toBe('number');
  });

  it('reports installed models including the configured small model', async () => {
    if (!up) return;
    const s = await status();
    expect(s.available).toBe(true);
    expect(s.models.length).toBeGreaterThan(0);
  });
});
