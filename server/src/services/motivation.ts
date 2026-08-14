import { store } from '../db/store.js';
import { generateJson } from '../mcp/ollama.js';
import { MOTIVATION_RUBRIC, isMotivation, type Motivation } from '../agents/rubric.js';

/**
 * Motivation axis (design §3b) — who the work is for: 'me' | 'us' | 'them',
 * NULL = unlabeled (and NULL ≠ 'us', the axis's core correctness rule).
 *
 * Labeling is LLM-first with two hard guardrails:
 *  - unsure ⇒ null, NEVER 'us' — 'us' is a positive claim of shared benefit,
 *    not a shrug; and
 *  - a user-set label wins permanently (the guarded UPDATE below enforces it
 *    at the SQL level, so no caller ordering can overwrite one).
 */

// ── Deterministic keyword fallback ────────────────────────────────────────────
// Runs inline at create (cheap, sync) and whenever Ollama is down. Even more
// conservative than the model: it never answers 'us' at all, and only fires on
// unambiguous phrasing. Word-boundary matching mirrors auto-tag's fallback.
const THEM_SIGNALS = [
  /\bfor (my |our )?(mom|mum|dad|mother|father|parents|grandma|grandmother|grandpa|grandfather|wife|husband|partner|kids?|children|son|daughter|family|friends?|neighbou?rs?|team|boss|client|her|him|them)\b/,
  /\bvolunteer(ing)?\b/,
  /\bcaregiv(e|ing)|care for\b/,
  /\bhelp(ing)? (out )?\w+/,
  /\bdonat(e|ion)\b/,
  /\bso (mom|mum|dad|she|he|they)\b/,
];
const ME_SIGNALS = [
  /\bmy (own )?(goal|dream|career|health|growth|legacy|business|portfolio|savings)\b/,
  /\bfor (myself|me)\b/,
  /\bself[- ](care|improvement|study)\b/,
];

export function classifyMotivationKeyword(text: string): Extract<Motivation, 'me' | 'them'> | null {
  const t = text.toLowerCase();
  // 'them' checked first: "help my mom with her taxes" carries both a THEM verb and
  // a possessive that ME_SIGNALS could clip — other-directedness is the rarer, more
  // deliberate signal, so it wins the tie.
  if (THEM_SIGNALS.some((re) => re.test(t))) return 'them';
  if (ME_SIGNALS.some((re) => re.test(t))) return 'me';
  return null;
}

// ── LLM classifier ────────────────────────────────────────────────────────────
/** Injectable for deterministic tests (the possibles.ts embedFn idiom). */
export type MotivationLLM = (prompt: string) => Promise<unknown>;

/**
 * Ask the local small model who the task is for. Junk / refusal / anything
 * outside the vocabulary ⇒ null. Throws only what generateJson throws (Ollama
 * down) — callers treat that as "no answer", never as an error the user sees.
 */
export async function classifyMotivationLLM(
  title: string,
  notes?: string | null,
  llm: MotivationLLM = (p) => generateJson(p, { tier: 'fast', temperature: 0.1, timeoutMs: 15_000 }),
): Promise<Motivation | null> {
  // Output shape first, rule adjacent to the field it governs (the 3B layout
  // doctrine measured in agents/quickadd.ts).
  const out = (await llm(
    `Who is this task for? Reply with JSON {"motivation": <"me" | "us" | "them" | null>}. ` +
      MOTIVATION_RUBRIC +
      `\nTask: "${title}"` +
      (notes?.trim() ? `\nNotes: "${notes.trim().slice(0, 300)}"` : ''),
  )) as { motivation?: unknown } | null;
  const v = out && typeof out === 'object' ? out.motivation : null;
  return isMotivation(v) ? v : null;
}

// ── Machine-apply (fill-blanks-only, enforced in SQL) ─────────────────────────
// SQL at module level, `prepare` INSIDE the function (§5.5): a module-level
// store().prepare runs at import time, which for any module imported before boot
// installs the backend throws "store not initialised".
const APPLY_SQL = `UPDATE tasks SET motivation = ?, motivation_source = 'llm'
    WHERE id = ? AND owner_id = ? AND motivation IS NULL`;

/**
 * Write a machine-attributed label ('llm' covers the model AND the keyword
 * fallback — both are machine testimony, and the metrics disclose the share).
 * The `motivation IS NULL` guard is the never-re-tag contract: a user label, or
 * an earlier machine label, always stands. Returns whether a row was written.
 */
export async function applyMachineMotivation(ownerId: string, taskId: string, value: Motivation): Promise<boolean> {
  const res = await store().prepare(APPLY_SQL).run(value, taskId, ownerId);
  return res.changes > 0;
}
