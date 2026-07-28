/**
 * Heuristic auto-tagging for the New Task wizard (offline, deterministic). Picks
 * the user's EXISTING tags whose name shows up in the title, so a task is tagged
 * the moment it's typed — no model required. The LLM path (suggest-tags endpoint)
 * refines this when Ollama is available; this is the always-on baseline.
 *
 * Matching is word-aware for single-word tags ("email" tags "Email Bluepeak" but not
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

// The LLM/heuristic merge for the bulk auto-tag action used to live here too. It moved
// server-side (services/auto-tag.ts `mergeTags`) when the Tasks Auto-tag button switched
// to POST /api/tasks/auto-tag, so the button and the `tag_tasks` cron share one copy.

/** Days-from-today YYYY-MM-DD in local time (start-day quick picks: 0/1/7). */
export function localDayPlus(days: number, base = new Date()): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
