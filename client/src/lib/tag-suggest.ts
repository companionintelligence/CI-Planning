/**
 * Heuristic auto-tagging for the New Task wizard (offline, deterministic). Picks
 * the user's EXISTING tags whose name shows up in the title, so a task is tagged
 * the moment it's typed — no model required. The LLM path (suggest-tags endpoint)
 * refines this when Ollama is available; this is the always-on baseline.
 *
 * Matching is word-aware for single-word tags ("email" tags "Email Rek" but not
 * "emailing"), and phrase-aware for multi-word tags ("deep-work" tags "deep work
 * session"). Returns the original tag names (already normalized by the store).
 */
export function suggestTagsFromTitle(title: string, existing: string[]): string[] {
  const lower = title.toLowerCase();
  const words = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  const out: string[] = [];
  for (const tag of existing) {
    const n = tag.trim().replace(/^#+/, '').toLowerCase();
    if (!n) continue;
    const multi = n.includes('-') || n.includes(' ');
    if (multi) {
      if (lower.includes(n) || lower.includes(n.replace(/-/g, ' '))) out.push(tag);
    } else if (words.has(n)) {
      out.push(tag);
    }
  }
  return out;
}

/**
 * Merge LLM suggestions with the offline heuristic for the bulk auto-tag action,
 * keeping only names in the vocabulary (never invent a tag) and de-duping while
 * preserving order (LLM picks first). With Ollama down, `llm` is `[]` and this
 * degrades to the deterministic heuristic — the always-on baseline.
 */
export function mergeSuggestedTags(llm: string[], heuristic: string[], vocabulary: string[]): string[] {
  const allow = new Set(vocabulary);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...llm, ...heuristic]) {
    if (allow.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

/** Days-from-today YYYY-MM-DD in local time (start-day quick picks: 0/1/7). */
export function localDayPlus(days: number, base = new Date()): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
