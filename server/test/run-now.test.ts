import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { config } from '../src/lib/config.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { issueApiKey } from '../src/lib/auth/apiKey.js';
import { SCOPE_READ } from '../src/lib/auth/types.js';
import { RUN_NOW_KINDS, type JobRunResult } from '../src/jobs/index.js';
import { startTestServer, resetDb, api, ollamaAvailable, type TestServer } from './helpers.js';

/**
 * FTUE · T12 (#348) — POST /api/jobs/run-now: the "Run my first sync now" trigger.
 * Deliberately NOT admin-gated (unlike POST /api/jobs/:id/run) — it runs the calling
 * owner's OWN ingest under ordinary write scope, same as every other mutation.
 *
 * The base read/write scope gate (`requireAuth`'s `hasScope` check) is ONLY enforced
 * on the `sso`/`standalone` auth-mode branches — the `test`-mode branch binds whatever
 * `x-test-scopes` says straight through to `next()` with no `hasScope` check at all
 * (confirmed by reading requireAuth.ts; `x-test-scopes` only feeds `currentScopes()`
 * for route-level checks like `requireAdmin`). So exercising the 403 path for real
 * needs `config.auth.mode = 'standalone'` + a real read-only API key, mirroring
 * auth.test.ts's own pattern — `x-test-scopes` cannot reach it.
 *
 * ingest_gmail/ingest_gcal need Ollama to actually extract possibles from the fixture
 * files (mirrors jobs.test.ts's own "ingestion jobs (require Ollama)" gating) — this
 * suite's env pins GOOGLE_MODE=fixture, but that only selects the fixture DATA SOURCE,
 * it doesn't stand in for the extractor.
 */

function lastRun(kind: string) {
  return sqlite
    .prepare(
      `SELECT r.status FROM job_runs r JOIN scheduled_jobs j ON j.id = r.job_id
       WHERE j.kind = ? ORDER BY r.id DESC LIMIT 1`,
    )
    .get(kind) as { status: string } | undefined;
}

describe('POST /api/jobs/run-now', () => {
  let server: TestServer;
  let ollamaUp = false;
  beforeAll(async () => {
    server = await startTestServer();
    ollamaUp = await ollamaAvailable();
  });
  afterAll(() => server.close());
  beforeEach(() => resetDb());
  afterEach(() => { config.auth.mode = 'test'; sqlite.exec('DELETE FROM api_keys'); });

  const post = (headers?: Record<string, string>) =>
    api<{ ok: boolean; ran: JobRunResult[] }>(server.url, '/api/jobs/run-now', {
      method: 'POST', ...(headers ? { headers } : {}),
    });

  it('runs exactly RUN_NOW_KINDS, in order, and records a job_runs row for each', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ran.map((r) => r.kind)).toEqual([...RUN_NOW_KINDS]);
    for (const kind of RUN_NOW_KINDS) {
      expect(lastRun(kind)).toBeDefined();
    }
  });

  it('a plain write-scope credential succeeds — no admin scope required', async () => {
    const res = await post({ 'x-test-scopes': 'planning:read,planning:write' });
    expect(res.status).toBe(200);
    expect(res.body.ran).toHaveLength(RUN_NOW_KINDS.length);
  });

  it('403s a read-only credential (ordinary write gate) — not the admin gate', async () => {
    config.auth.mode = 'standalone';
    const key = issueApiKey(SYSTEM_OWNER, [SCOPE_READ]);
    const res = await post({ 'x-api-key': key });
    expect(res.status).toBe(403);
    expect(res.body as unknown).toEqual({ error: 'forbidden' });
  });

  it('under fixture mode, ingest kinds report processed items when Ollama is reachable', async () => {
    if (!ollamaUp) return; // same gate jobs.test.ts uses for real extraction from fixtures
    const res = await post();
    const gmail = res.body.ran.find((r) => r.kind === 'ingest_gmail')!;
    const gcal = res.body.ran.find((r) => r.kind === 'ingest_gcal')!;
    expect(gmail.status).toBe('done');
    expect(gcal.status).toBe('done');
    const possibles = sqlite.prepare(`SELECT COUNT(*) AS n FROM possible_tasks`).get() as { n: number };
    expect(possibles.n).toBeGreaterThan(0);
  });
});
