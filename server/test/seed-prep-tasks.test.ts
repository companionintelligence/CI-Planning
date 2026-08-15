import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepTaskTitle } from '../src/scripts/prep-task-title.js';
import type { CalendarEvent } from '../src/mcp/google.js';

/**
 * Pins the calendar half of the deterministic (`--no-llm`) seed.
 *
 * These titles are what a viewer reads in the Companion Planning product video and what
 * a new contributor sees on their first `pnpm seed`, so they are asserted verbatim rather
 * than by shape. The fixture is WHOLLY SYNTHETIC — invented companies at example.com —
 * because the set it replaced held real partners, clients and family references, in a
 * repo destined to be public. The rule under test is in src/scripts/prep-task-title.ts: use the event's
 * own words, and create nothing when the event implies nothing.
 *
 * If you edit server/test/fixtures/calendar.json, this test fails — that is the point.
 * Update the expectation deliberately, and re-shoot video/assets/shots in the same PR.
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const events: CalendarEvent[] = JSON.parse(readFileSync(join(fixtures, 'calendar.json'), 'utf8'));

/** event title -> the task it implies, or null for "nothing to do". */
const EXPECTED: Record<string, string | null> = {
  'Quarterly partner review': 'Bring the updated forecast and draft the summary memo',
  'New client onboarding standup': 'Provision the staging environment and confirm API credentials',
  'Engineering working session': 'Circulate the scope doc and a draft agenda',
  'Dentist appointment': 'Bring insurance card',
  'Co-marketing call': 'Finish the joint one-pager draft and prepare the hardware lead intro',
  'Board prep': 'Prepare for the board meeting',
  'Gym - leg day': null,
  'Pilot kickoff': 'Get the data schema sent and the shared channel created',
  'Family birthday dinner': 'Book the reservation and pick up the cake and card',
  'Conference speaker rehearsal': 'Finalize slides and confirm A/V requirements with organizers',
  'Legal review call - vendor NDA': 'Review comments and prepare questions',
  'Deep work - grant narrative': 'Outline the budget justification',
  'Integration sync': 'Prepare the integration spec',
  '1:1 with hardware lead': 'Bring the approved BOM and pricing sign-off',
  'Lunch with mentor': null,
  'Investor meeting planning':
    'Finalize the agenda, confirm the venue, and assign slide owners for the performance deck',
  'Holiday - Office closed': null,
  'Quarterly tax check-in': 'Categorize May transactions and gather the hosting and travel receipts',
};

describe('prepTaskTitle over the calendar fixture', () => {
  it('covers every fixture event exactly once', () => {
    expect(events.map((e) => e.title).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(events.map((e) => [e.title, e] as const))('%s', (title, event) => {
    expect(prepTaskTitle(event)).toBe(EXPECTED[title]);
  });

  it('creates no task for the three events that imply no work', () => {
    const skipped = events.filter((e) => prepTaskTitle(e) === null).map((e) => e.title);
    expect(skipped.sort()).toEqual(['Gym - leg day', 'Holiday - Office closed', 'Lunch with mentor']);
  });

  it('never stamps a title out of the event name', () => {
    for (const event of events) {
      const produced = prepTaskTitle(event);
      if (produced === null) continue;
      expect(produced).not.toMatch(/^Prep for /);
      expect(produced.toLowerCase()).not.toBe(`prep for ${event.title.toLowerCase()}`);
    }
  });

  it('makes 15 calendar tasks, which is what --target is sized against', () => {
    // video/README.md's seed line pins `--target=<total>`; if this number moves, the
    // filler branch in seed-test-data.ts step 5 starts topping the backlog up with rows
    // the film was never staged for. Change both together.
    expect(events.filter((e) => prepTaskTitle(e) !== null)).toHaveLength(15);
  });
});
