import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractTasks } from '../src/agents/extract.js';
import { ollamaAvailable } from './helpers.js';

const fixtures = join(import.meta.dirname, 'fixtures');
const emails = JSON.parse(readFileSync(join(fixtures, 'emails.json'), 'utf8')) as {
  id: string;
  subject: string;
  body: string;
  receivedAt: string;
}[];

describe('extract agent', () => {
  let up = false;
  beforeAll(async () => {
    up = await ollamaAvailable();
  });

  it('extracts actionable tasks from an email with clear asks', async () => {
    if (!up) return;
    const email = emails.find((e) => e.id === 'email-001')!;
    const tasks = await extractTasks(
      { kind: 'gmail', ref: email.id, subject: email.subject, text: email.body, at: email.receivedAt },
      { tier: 'medium' }
    );
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    for (const t of tasks) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.priority).toBeGreaterThanOrEqual(1);
      expect(t.priority).toBeLessThanOrEqual(5);
      expect(t.confidence).toBeGreaterThanOrEqual(0);
      expect(t.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(t.tags)).toBe(true);
    }
  });

  it('returns a well-formed (possibly empty) array for an FYI/newsletter', async () => {
    if (!up) return;
    const newsletter = emails.find((e) => e.id === 'email-012')!;
    const tasks = await extractTasks(
      { kind: 'gmail', ref: newsletter.id, subject: newsletter.subject, text: newsletter.body },
      { tier: 'medium' }
    );
    expect(Array.isArray(tasks)).toBe(true);
    // A good model ignores newsletters; we don't hard-assert 0 to avoid flakiness.
    expect(tasks.length).toBeLessThanOrEqual(3);
  });

  it('normalizes garbage dates to null rather than throwing', async () => {
    if (!up) return;
    const tasks = await extractTasks(
      { kind: 'text', ref: 'manual-1', text: 'Remember to renew the domain sometime.' },
      { tier: 'small' }
    );
    for (const t of tasks) {
      if (t.dueAt !== null && t.dueAt !== undefined) {
        expect(Number.isNaN(new Date(t.dueAt).getTime())).toBe(false);
      }
    }
  });
});
