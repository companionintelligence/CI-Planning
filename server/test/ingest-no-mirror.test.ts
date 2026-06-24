import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import type { GoogleClient, CalendarEvent } from '../src/mcp/google.js';

// Mock the LLM extraction so this test is deterministic and Ollama-independent: every event
// yields exactly one extracted task → one possible. (We assert >0 possibles, not an exact n.)
vi.mock('../src/agents/extract.js', () => ({
  extractTasks: vi.fn(async (source: { subject?: string; text: string }) => [
    {
      title: (source.subject ?? source.text).slice(0, 200) || 'Prep',
      summary: undefined,
      priority: 3,
      dueAt: null,
      estimatedMinutes: null,
      tags: [],
      confidence: 0.9,
    },
  ]),
}));

import { ingestEvents } from '../src/agents/ingest.js';

function futureDate(daysAhead: number, hourOffset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(9 + hourOffset, 0, 0, 0);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function fakeClient(events: CalendarEvent[]): GoogleClient {
  return {
    mode: 'fixture',
    async listEmails() {
      return [];
    },
    async listEvents() {
      return events;
    },
  };
}

const run = <T>(fn: () => Promise<T>) => runWithOwner(SYSTEM_OWNER, fn);

describe('ingestEvents — no meeting-block mirror (WP5)', () => {
  beforeEach(() => {
    sqlite.exec('DELETE FROM possible_task_tags; DELETE FROM possible_tasks; DELETE FROM time_blocks; DELETE FROM tags;');
  });

  it('produces possibles but creates zero time_blocks; blocksCreated === 0', async () => {
    const client = fakeClient([
      { id: 'evt-1', title: 'Quarterly review', description: 'Bring the deck and the numbers', start: futureDate(1), end: futureDate(1, 1) },
      { id: 'evt-2', title: 'Vendor call', description: 'Confirm the contract terms', start: futureDate(2), end: futureDate(2, 1) },
    ]);

    const result = await run(() => ingestEvents(client));

    // Inbound mirror is now sync.ts's job exclusively — ingest creates no meeting blocks.
    const blockCount = (sqlite.prepare('SELECT COUNT(*) AS n FROM time_blocks').get() as { n: number }).n;
    expect(blockCount).toBe(0);
    expect(result.blocksCreated).toBe(0);

    // But it still mines possibles from the event text.
    const possibles = (sqlite.prepare('SELECT COUNT(*) AS n FROM possible_tasks').get() as { n: number }).n;
    expect(possibles).toBeGreaterThan(0);
    expect(result.possiblesCreated).toBeGreaterThan(0);
  });
});
