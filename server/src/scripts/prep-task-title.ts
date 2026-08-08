/**
 * The prep task a calendar event actually implies — read out of its own description.
 *
 * `seed-test-data.ts`'s LLM-off path used to title every calendar task
 * `Prep for ${event.title}`, which produced `Prep for Board prep`, `Prep for Gym - leg
 * day` and `Prep for Holiday - Office closed`: a row for every event whether or not it
 * implied any work, each one visibly stamped out by a machine. That is the opposite of
 * what a deterministic fallback is for. The EMAIL fallback has always used the source's
 * own words — the subject IS the task — and this brings the calendar path to the same
 * rule. The fixtures already hold the material: every event's description ends in the
 * sentence a person would have written down ("Prep: finish the joint one-pager draft…",
 * "Remember to bring insurance card", "No prep needed").
 *
 * Deterministic and fixture-scoped on purpose. `seed-test-data.ts` only ever builds a
 * `createFixtureGoogleClient`, so the verb list below has a closed input set, and
 * `server/test/seed-prep-tasks.test.ts` pins the exact result for all 18 fixture events
 * — an edited fixture fails there, rather than surfacing as a mystery row in a product
 * video frame six steps later.
 */

/** Descriptions that say, in the owner's own words, that there is nothing to do. */
const NO_PREP = /\bno prep\b|\bno meetings\b|office is closed|personal workout/i;

/** First words that make a sentence an instruction rather than context. */
const IMPERATIVES = new Set([
  'assign', 'book', 'bring', 'build', 'call', 'categorize', 'check', 'circulate', 'confirm',
  'countersign', 'create', 'draft', 'file', 'finalize', 'finish', 'gather', 'get', 'kick',
  'lock', 'order', 'outline', 'pick', 'prepare', 'provision', 'publish', 'pull', 'reconcile',
  'rehearse', 'renew', 'resolve', 'review', 'schedule', 'send', 'share', 'ship', 'sign',
  'spike', 'triage', 'update', 'upgrade', 'walk', 'write',
]);

/** Markers a person puts in front of the instruction, and what they leave behind. */
const LEAD_MARKERS: [RegExp, string][] = [
  [/^prep:\s*/i, ''],
  [/^action:\s*/i, ''],
  [/^remember to\s+/i, ''],
  [/^need to\s+/i, ''],
  [/^also\s+/i, ''],
  // "Need the schema sent" is an instruction with its verb hidden in the object.
  [/^need\s+/i, 'Get '],
];

/** Hedges that only mean anything beside the event; a task carries its own due date. */
const TRAILING_HEDGES = /\s+(beforehand|ahead of time|before this meeting|in advance|first)$/i;

/**
 * Returns the task title this event implies, or `null` when it implies none — in which
 * case the seeder creates NO task. Three of the eighteen fixture events are like that,
 * and a planner that invents work for your gym slot is a planner nobody trusts.
 */
export function prepTaskTitle(event: { title: string; description: string }): string | null {
  const description = (event.description ?? '').trim();
  if (!description || NO_PREP.test(description)) return null;

  // The LAST actionable sentence, not the first: the opening sentence restates the
  // meeting ("Kick off the Rek pilot."), the closing one is what has to happen before it.
  const sentences = description.split(/(?<=[.;])\s+/).map((s) => s.trim()).filter(Boolean);
  for (let i = sentences.length - 1; i >= 0; i--) {
    let s = sentences[i];
    let marked = false;
    for (const [pattern, replacement] of LEAD_MARKERS) {
      if (pattern.test(s)) {
        s = s.replace(pattern, replacement);
        marked = true;
        break;
      }
    }
    s = s.replace(/[.;]+$/, '').trim();
    if (!s) continue;
    // A marker is its own proof of intent; without one the sentence has to open on a verb.
    if (!marked && !IMPERATIVES.has(s.split(/\s+/)[0].toLowerCase())) continue;

    s = s.replace(TRAILING_HEDGES, '');
    // A long instruction that names its own subject before a colon already contains the
    // title: "Prepare for the board meeting: build the pipeline report, …" is one task,
    // and the head clause is the line a person would actually have written.
    if (s.length > 100 && s.includes(': ')) s = s.slice(0, s.indexOf(': '));
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return null;
}
