import { generateJson } from '../mcp/ollama.js';
import type { ParsedQuick } from '../engine/quickadd.js';

/**
 * Optional best-effort overlay on the deterministic parse: a small local model
 * fills ONLY metadata the parser couldn't (a missing estimate, a priority). It
 * never overrides a field the parser set (title/dates/tags stay authoritative),
 * and any failure (Ollama down, bad JSON) must be caught by the caller, which
 * then keeps the deterministic result. This keeps quick-add reproducible.
 */
export async function enrichQuick(text: string, parsed: ParsedQuick): Promise<ParsedQuick> {
  const out = await generateJson<{ estimatedMinutes?: number | null; priority?: number | null }>(
    `From this quick task entry, infer ONLY missing metadata. Reply with JSON ` +
      `{"estimatedMinutes": <minutes or null>, "priority": <1-5 or null>}. ` +
      `1 is highest priority. Entry: "${text}"`,
    { tier: 'small', temperature: 0.1, timeoutMs: 15_000 }
  );

  const estimatedMinutes =
    parsed.estimatedMinutes ?? (typeof out.estimatedMinutes === 'number' ? out.estimatedMinutes : undefined);
  const priority =
    out.priority && out.priority >= 1 && out.priority <= 5 ? out.priority : undefined;

  return { ...parsed, estimatedMinutes, priority };
}
