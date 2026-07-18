import Router from '@koa/router';
import {
  openSession, appendTranscript, setTranscript, closeSession,
  listSessions, getSession, deleteSession,
  type TranscriptMessage,
} from '../services/planning-sessions.js';

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
