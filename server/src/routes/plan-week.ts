import Router from '@koa/router';
import {
  openSession, appendTranscript, setTranscript, closeSession,
  listSessions, getSession, deleteSession, planWeekCandidates,
  type TranscriptMessage,
} from '../services/planning-sessions.js';
import { planWeekReview, defaultAnchorForOwner } from '../services/plan-week-review.js';
import { planWeekNextStep } from '../services/plan-week.js';
import { parseInstruction, InstructError } from '../agents/plan.js';
import { currentOwnerId } from '../lib/context.js';
import { isValidISODate, localISODate } from '../lib/dates.js';

/**
 * Plan-my-week session log (FTUE · T1, #337) — thin transport over
 * services/planning-sessions.ts.
 *
 * The service self-scopes via `currentOwnerId()`, so these handlers never resolve or
 * pass an owner; they only shape requests, map results to status codes, and emit JSON.
 * A row owned by someone else comes back `undefined` exactly like a missing one, so
 * both land on a flat 404 and the API never reveals that an id exists.
 *
 * Auth is inherited: `/api/plan-week/*` is absent from `PUBLIC_PREFIXES`, so the central
 * `requireAuth()` in app.ts gates reads on `planning:read` and mutations on
 * `planning:write`. Nothing scope-related belongs in this file.
 *
 * No SSE broadcasts — the Logs tab (T6) refetches (ticket Non-goals).
 */
export function planWeekRouter() {
  const router = new Router();

  /**
   * T5 — the deterministic weekly recap. Defaults to the week that just ended, since
   * reviewing "past data" from today's anchor would show the in-progress week.
   * Read-only and LLM-free; auth is inherited (GET ⇒ planning:read).
   */
  router.get('/api/plan-week/review', async (ctx) => {
    const raw = ctx.query.anchor;
    if (raw !== undefined && !isValidISODate(raw)) {
      ctx.status = 422; ctx.body = { error: 'anchor must be YYYY-MM-DD' }; return;
    }
    ctx.body = planWeekReview((raw as string | undefined) ?? defaultAnchorForOwner());
  });

  /**
   * T3 — what "Fill next week" would stage/place, for the preview step. Read-only:
   * a GET is auto-gated `planning:read` by the central guard, and the service runs
   * no writes, so the preview can be re-run freely as the user changes the horizon.
   */
  router.get('/api/plan-week/candidates', async (ctx) => {
    // No `start` param: the staging day is not the caller's to choose — /api/auto/fill
    // resolves ownerToday itself, so the service anchors on the same value and echoes it.
    ctx.body = planWeekCandidates(ctx.query.horizon);
  });

  /**
   * T7 — the hybrid follow-up layer. ALWAYS 200s (Ollama-down / gate-rejected ⇒
   * `source: 'fallback'` with the caller's own deterministic question/options echoed
   * back verbatim); the only error is `422` on a malformed body, before any renderCopy
   * call is made.
   */
  router.post('/api/plan-week/next-step', async (ctx) => {
    const body = (ctx.request.body ?? {}) as {
      branch?: string;
      context?: Record<string, unknown>;
      fallbackQuestion?: string;
      fallbackOptions?: string[];
    };

    const fallbackQuestion = typeof body.fallbackQuestion === 'string' ? body.fallbackQuestion.trim() : '';
    if (!fallbackQuestion) {
      ctx.status = 422; ctx.body = { error: 'fallbackQuestion is required' }; return;
    }
    const fallbackOptions = body.fallbackOptions;
    if (
      !Array.isArray(fallbackOptions) ||
      fallbackOptions.length !== 3 ||
      !fallbackOptions.every((o) => typeof o === 'string' && o.trim().length > 0)
    ) {
      ctx.status = 422; ctx.body = { error: 'fallbackOptions must be exactly 3 non-empty strings' }; return;
    }

    ctx.body = await planWeekNextStep({
      branch: typeof body.branch === 'string' ? body.branch : '',
      context: body.context && typeof body.context === 'object' ? body.context : undefined,
      fallbackQuestion,
      fallbackOptions,
    });
  });

  /**
   * T8 — parse a free-text answer into a structured scheduling intent WITHOUT applying
   * it (authoring/execution is T9). Reuses `parseInstruction` directly, NOT
   * `instructPlan` (the apply-wrapper `POST /api/plan/instruct` uses) — this route makes
   * no writes. Error mapping mirrors `POST /api/plan/instruct` byte-for-byte
   * (routes/plan.ts).
   */
  router.post('/api/plan-week/parse', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { text?: string; date?: string };
    const text = (body.text ?? '').trim();
    if (!text) { ctx.status = 422; ctx.body = { error: 'text is required' }; return; }
    const date = body.date ?? localISODate();
    const owner = currentOwnerId();

    let result;
    try {
      result = await parseInstruction(owner, date, text);
    } catch (err) {
      if (err instanceof InstructError) {
        ctx.status = err.code === 'unavailable' ? 503 : 422;
        ctx.body = { error: err.message };
        return;
      }
      throw err;
    }
    ctx.body = { ok: true, date, pins: result.pins, hints: result.hints };
  });

  router.post('/api/plan-week/sessions', async (ctx) => {
    const body = (ctx.request.body ?? {}) as { entry_branch?: string };
    const res = openSession(String(body.entry_branch ?? ''));
    if (!res.ok) { ctx.status = 422; ctx.body = { error: res.error }; return; }
    ctx.status = 201;
    ctx.body = { session: res.value };
  });

  router.get('/api/plan-week/sessions', async (ctx) => {
    ctx.body = { sessions: listSessions() };
  });

  router.get('/api/plan-week/sessions/:id', async (ctx) => {
    const session = getSession(ctx.params.id);
    if (!session) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ctx.body = { session };
  });

  /**
   * One PATCH, several optional ops applied in order: append a message (or replace the
   * whole transcript), then close. Sending `{ message }` and `{ status }` together is
   * legal and lands both — the assistant's final turn plus the close in one call.
   */
  router.patch('/api/plan-week/sessions/:id', async (ctx) => {
    const id = ctx.params.id;
    const body = (ctx.request.body ?? {}) as {
      message?: { role: string; text: string; ts?: string };
      transcript?: TranscriptMessage[];
      status?: string;
      summary?: string;
      llm_used?: boolean;
    };

    let session = getSession(id);
    if (!session) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }

    if (body.message !== undefined) {
      const res = appendTranscript(id, body.message);
      if (!res) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      if (!res.ok) { ctx.status = 422; ctx.body = { error: res.error }; return; }
      session = res.value;
    } else if (Array.isArray(body.transcript)) {
      const next = setTranscript(id, body.transcript);
      if (!next) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      session = next;
    }

    if (body.status !== undefined) {
      const res = closeSession(id, { status: body.status, summary: body.summary, llmUsed: body.llm_used });
      if (!res) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
      if (!res.ok) { ctx.status = 422; ctx.body = { error: res.error }; return; }
      session = res.value;
    }

    ctx.body = { session };
  });

  router.delete('/api/plan-week/sessions/:id', async (ctx) => {
    if (!deleteSession(ctx.params.id)) { ctx.status = 404; ctx.body = { error: 'not found' }; return; }
    ctx.body = { ok: true };
  });

  return router;
}
