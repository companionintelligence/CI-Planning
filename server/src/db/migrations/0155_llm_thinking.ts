import type { Database } from 'better-sqlite3';

export const id = '0155_llm_thinking';

/**
 * Per-owner opt-in for Ollama "thinking" mode on generation calls (fast/quality tiers).
 *
 * `lib/models.ts` deliberately EXCLUDES thinking-capable models from auto-selection —
 * measured against Ollama 0.30.10, some of them return an EMPTY `response` under
 * `format:"json"` regardless of the `think` flag. That exclusion stays; this column is
 * for the operator who explicitly overrides Settings to a thinking model anyway (the
 * override already bypasses the auto-select filter) and wants the app to say so
 * explicitly to Ollama — `think:false` by default (matches the pre-existing implicit
 * behavior of not setting the field), opt-in `true` for owners who want the model's
 * real reasoning pass. See mcp/ollama.ts generate() for the timeout implication: a
 * thinking pass needs materially more time than the CALL_POLICY budgets assume.
 *
 * A plain scheduling_prefs boolean, the triality_enabled shape (0139).
 *
 * Idempotent via the B0 addColumn-if-missing pattern.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === 'llm_thinking_enabled')) {
    db.exec(`ALTER TABLE scheduling_prefs ADD COLUMN llm_thinking_enabled INTEGER DEFAULT 0`);
  }
}
