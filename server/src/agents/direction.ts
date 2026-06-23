/**
 * Direction inference (D3/D4). Resolves every ingested item to exactly one of the
 * three direction (pattern) tags the Auto engine places against — HOME, WORK, or
 * COMMUNITY. Pure + deterministic: no LLM, so it runs unchanged when Ollama is down
 * (the always-on guarantee — nothing arrives untagged). Source decides first; the
 * LLM's free-form content tags only break a tie (a community signal always wins).
 */

export type Direction = 'home' | 'work' | 'community';

// Common personal mail providers → a `from` on one of these is treated as HOME.
// Anything else (a company domain) is treated as WORK. Inferred by the system for
// now (D3), not user-configured.
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'aol.com',
]);

// Content keyword → direction. The LLM emits free-form single-word tags; this maps
// the placement-relevant ones down to a direction as the tiebreaker.
const CONTENT_HINTS: Record<string, Direction> = {
  // community
  volunteer: 'community', community: 'community', church: 'community', charity: 'community',
  fundraiser: 'community', donation: 'community', neighborhood: 'community', nonprofit: 'community',
  // home
  family: 'home', home: 'home', personal: 'home', grocery: 'home', groceries: 'home',
  errand: 'home', errands: 'home', chore: 'home', chores: 'home', household: 'home',
  // work
  work: 'work', project: 'work', client: 'work', invoice: 'work', meeting: 'work',
  deadline: 'work', report: 'work', proposal: 'work',
};

function personalDomain(from?: string): boolean {
  const m = from?.toLowerCase().match(/@([^>\s]+)/);
  return m ? PERSONAL_DOMAINS.has(m[1]) : false;
}

/** First content tag that maps to a direction (community wins ties), or null. */
export function contentDirectionHint(tags: string[]): Direction | null {
  let found: Direction | null = null;
  for (const t of tags) {
    const d = CONTENT_HINTS[t.toLowerCase()];
    if (d === 'community') return 'community'; // strongest signal — decide now
    if (d && !found) found = d;
  }
  return found;
}

/**
 * The one direction an ingested item resolves to. Source first: a personal/work
 * email domain decides directly; a calendar event defaults to WORK; freeform text
 * is ambiguous, so content breaks the tie (default HOME). A community content
 * signal always overrides.
 */
export function inferDirection(input: {
  sourceKind: string;
  from?: string;
  contentTags?: string[];
}): Direction {
  const hint = contentDirectionHint(input.contentTags ?? []);
  switch (input.sourceKind) {
    case 'gmail': {
      const base: Direction = personalDomain(input.from) ? 'home' : 'work';
      return hint === 'community' ? 'community' : base;
    }
    case 'gcal':
      return hint === 'community' ? 'community' : 'work';
    default: // 'text' / unknown — source is ambiguous, let content decide
      return hint ?? 'home';
  }
}
