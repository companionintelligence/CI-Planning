/**
 * Coarse, deterministic shape for a task nobody has read.
 *
 * This is the `--no-llm` path — the one `pnpm seed -- --no-llm` uses to stage the
 * product screenshots, and the one every owner hits whenever Ollama is down. It used
 * to hand back `priority: 3, estimatedMinutes: 30` for every single item, so a
 * fifty-task backlog rendered as fifty identical "30m · P3" rows. The planner had
 * nothing real to sort by, the day-load bar was a multiple of thirty by construction,
 * and the whole screen read as placeholder rather than as a backlog.
 *
 * These are keyword heuristics, not extraction, and they are honest about it: callers
 * keep the low `confidence` that says "guessed". The rules are pure and ordered, so
 * the same text always yields the same numbers — which is what keeps the committed
 * capture screenshots byte-stable across re-seeds.
 */

/** Ordered longest-first: the first matching band wins. */
const DEEP = /\b(narrative|proposal|deck|report|spec|memo|strategy|forecast|roadmap|architecture|deep work|one-pager|whitepaper)\b/;
const LONG = /\b(draft|write|prepare|prep|build|create|design|plan|scope|research)\b/;
const MEDIUM = /\b(review|approve|triage|update|categorize|categorise|audit|reconcile|label|sync|call|standup|1:1|meeting)\b/;
const QUICK = /\b(send|reply|respond|forward|book|confirm|rsvp|pay|order|upload|register|sign|share|ping|schedule|cancel|renew)\b/;

const BLOCKING = /\b(blocked|blocker|urgent|asap|critical|escalat\w*)\b/;
const DEADLINED = /\b(due|deadline|expires?|expiring|renewal|by (mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)\w*|before (mon|tues?|wed(nes)?|thur?s?|fri|sat(ur)?|sun)\w*|tax|invoice|contract|deposit)\b/;
const LOW = /\b(someday|eventually|nice to have|when there is time|backlog|explore)\b/;

/** Minutes a task of this shape plausibly takes. */
export function guessEstimateMinutes(text: string): number {
  const t = text.toLowerCase();
  if (DEEP.test(t)) return 90;
  if (LONG.test(t)) return 60;
  if (MEDIUM.test(t)) return 45;
  if (QUICK.test(t)) return 15;
  return 30;
}

/** 1 (highest) .. 5 (lowest). Blocking beats a deadline beats the 3 default. */
export function guessPriority(text: string): number {
  const t = text.toLowerCase();
  if (BLOCKING.test(t)) return 1;
  if (DEADLINED.test(t)) return 2;
  if (LOW.test(t)) return 4;
  return 3;
}
