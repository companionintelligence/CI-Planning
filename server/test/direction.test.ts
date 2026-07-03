import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { resetDb } from './helpers.js';
import { inferDirection } from '../src/agents/direction.js';
import { upsertPossible } from '../src/agents/ingest.js';
import type { ExtractedTask } from '../src/agents/extract.js';

const mk = (over: Partial<ExtractedTask> = {}): ExtractedTask => ({
  title: 'T', priority: 3, tags: [], confidence: 0.8, ...over,
});

const patternTagsFor = (possibleId: string): string[] =>
  (sqlite
    .prepare(
      `SELECT tg.name AS name FROM possible_task_tags pt JOIN tags tg ON tg.id = pt.tag_id
        WHERE pt.possible_task_id = ? AND tg.kind = 'direction'`,
    )
    .all(possibleId) as { name: string }[]).map((r) => r.name);

describe('inferDirection — deterministic, source-first (D3/D4)', () => {
  it('a work email domain → work', () => {
    expect(inferDirection({ sourceKind: 'gmail', from: 'Boss <boss@acme.co>' })).toBe('work');
  });
  it('a personal email domain → home', () => {
    expect(inferDirection({ sourceKind: 'gmail', from: 'Me <me@gmail.com>' })).toBe('home');
  });
  it('a calendar event → work', () => {
    expect(inferDirection({ sourceKind: 'gcal' })).toBe('work');
  });
  it('freeform text → home when content is silent', () => {
    expect(inferDirection({ sourceKind: 'text' })).toBe('home');
  });
  it('a community content signal overrides the source', () => {
    expect(inferDirection({ sourceKind: 'gmail', from: 'x@acme.co', contentTags: ['volunteer'] })).toBe('community');
  });
  it('content breaks the tie for ambiguous text', () => {
    expect(inferDirection({ sourceKind: 'text', contentTags: ['client'] })).toBe('work');
  });
  it('always-on: empty content (Ollama down) still resolves by source', () => {
    expect(inferDirection({ sourceKind: 'gcal', contentTags: [] })).toBe('work');
    expect(inferDirection({ sourceKind: 'gmail', from: 'me@icloud.com', contentTags: [] })).toBe('home');
  });
});

describe('upsertPossible attaches exactly one direction (pattern) tag', () => {
  beforeEach(() => resetDb());

  it('tags a work email WORK', () => {
    expect(upsertPossible(mk({ title: 'Send report' }), 'gmail', 'm1', { from: 'boss@acme.co' })).toBe('created');
    const pid = (sqlite.prepare(`SELECT id FROM possible_tasks WHERE source_ref = 'm1'`).get() as { id: string }).id;
    expect(patternTagsFor(pid)).toEqual(['work']);
  });

  it('still tags by source with no content tags (the Ollama-down shape)', () => {
    upsertPossible(mk({ title: 'Note', tags: [] }), 'text', 't1', { ref: 't1' });
    const pid = (sqlite.prepare(`SELECT id FROM possible_tasks WHERE source_ref = 't1'`).get() as { id: string }).id;
    expect(patternTagsFor(pid)).toEqual(['home']);
  });

  it('exactly one direction tag even when content tags are present', () => {
    upsertPossible(mk({ title: 'Invoice', tags: ['finance', 'urgent'] }), 'gmail', 'm2', { from: 'ar@vendor.io' });
    const pid = (sqlite.prepare(`SELECT id FROM possible_tasks WHERE source_ref = 'm2'`).get() as { id: string }).id;
    expect(patternTagsFor(pid)).toEqual(['work']); // exactly one pattern tag; content tags are intention-kind
  });
});
