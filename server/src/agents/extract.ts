import { generateJson, type ModelTier } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';

export type SourceKind = 'gmail' | 'gcal' | 'text';

export interface ExtractSource {
  kind: SourceKind;
  /** Stable identifier for dedupe (message id, event id, or synthetic). */
  ref: string;
  /** The raw content to mine for todos. */
  text: string;
  /** Optional subject/title shown to the model for context. */
  subject?: string;
  /** ISO timestamp the item was received/occurs — anchors relative dates. */
  at?: string;
}

export interface ExtractedTask {
  title: string;
  summary?: string;
  priority: number; // 1 (highest) .. 5 (lowest)
  dueAt?: string | null; // ISO date or null
  // AB2: START intent (scheduled_for day + optional wall-clock time, in the OWNER's
  // timezone). due_at stays a deadline only — it never selects the placement day.
  scheduledFor?: string | null; // YYYY-MM-DD or null
  taskTime?: string | null; // HH:MM or null
  estimatedMinutes?: number | null;
  tags: string[];
  confidence: number; // 0..1
}

const SYSTEM = `You are a precise task-extraction assistant for a personal planning app.
You read emails, calendar events, and notes, and you identify concrete, actionable to-dos for the user.
Rules:
- Only extract items the USER must act on. Ignore newsletters, receipts, FYIs, and automated notices.
- Each task title is a short imperative phrase ("Send Q3 report", not "The Q3 report is due").
- priority: 1=urgent/blocking, 2=important, 3=normal, 4=low, 5=someday.
- estimatedMinutes: a realistic guess (15, 30, 60, 120...). Null if unknowable.
- tags: 1-3 lowercase single-word topic labels (e.g. "finance", "email", "legal").
- confidence: 0..1, how sure you are this is a real actionable task.
Respond ONLY with JSON.`;

function buildPrompt(source: ExtractSource): string {
  const anchor = source.at ? `\nItem date: ${source.at}` : '';
  const subject = source.subject ? `\nSubject: ${source.subject}` : '';
  return `Source type: ${source.kind}${subject}${anchor}

Content:
"""
${source.text.slice(0, 6000)}
"""

Extract actionable to-dos. Respond with JSON in exactly this shape:
{"tasks":[{"title":"...","summary":"...","priority":3,"dueAt":null,"estimatedMinutes":30,"tags":["..."],"confidence":0.8}]}
If there are no actionable to-dos, respond with {"tasks":[]}.`;
}

interface RawResult {
  tasks?: Partial<ExtractedTask>[];
}

/** Coerce a raw model task into a well-formed ExtractedTask, or null if unusable. */
function normalize(raw: Partial<ExtractedTask> | undefined): ExtractedTask | null {
  if (!raw || typeof raw.title !== 'string' || !raw.title.trim()) return null;
  const priority = clampInt(raw.priority, 1, 5, 3);
  const confidence = typeof raw.confidence === 'number' ? clamp(raw.confidence, 0, 1) : 0.6;
  const tags = Array.isArray(raw.tags)
    ? raw.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.toLowerCase().replace(/\s+/g, '-').slice(0, 32))
        .slice(0, 3)
    : [];
  return {
    title: raw.title.trim().slice(0, 200),
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 500) : undefined,
    priority,
    dueAt: normalizeDate(raw.dueAt),
    estimatedMinutes: typeof raw.estimatedMinutes === 'number' && raw.estimatedMinutes > 0
      ? Math.round(raw.estimatedMinutes)
      : null,
    tags,
    confidence,
  };
}

function normalizeDate(d: unknown): string | null {
  if (typeof d !== 'string' || !d.trim()) return null;
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
function clampInt(n: unknown, lo: number, hi: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(clamp(n, lo, hi)) : fallback;
}

/**
 * Extract actionable tasks from one source item via Ollama.
 * Throws OllamaUnavailable if the LLM is unreachable — callers decide how to degrade.
 */
export async function extractTasks(
  source: ExtractSource,
  opts: { tier?: ModelTier; timeoutMs?: number } = {}
): Promise<ExtractedTask[]> {
  const result = await generateJson<RawResult>(buildPrompt(source), {
    tier: opts.tier ?? 'quality',
    system: SYSTEM,
    temperature: 0.1,
    timeoutMs: opts.timeoutMs ?? 60_000,
  });

  const tasks = (result.tasks ?? [])
    .map(normalize)
    .filter((t): t is ExtractedTask => t !== null);

  logger.debug('extractTasks', { kind: source.kind, ref: source.ref, found: tasks.length });
  return tasks;
}
