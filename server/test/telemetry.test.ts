import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import {
  resolveTelemetrySettings,
  isLocalOnly,
  isTelemetryOptedOut,
  telemetryPermission,
} from '../src/lib/telemetry/settings.js';
import { scrubEvent, scrubString, scrubUrl } from '../src/lib/telemetry/scrub.js';
import { withTimeout } from '../src/lib/telemetry/timeout.js';
import { startTestServer, api, type TestServer } from './helpers.js';

/**
 * Error reporting (Sentry) — the opt-in gate and the payload scrubber.
 *
 * Both modules are pure and env-injected precisely so this suite can assert the whole
 * matrix without touching the SDK or the network. The properties under test are the
 * privacy contract itself, shared with CI-Server and CI-Import-Tools: off unless a DSN
 * is present, off regardless of the DSN when an operator says so, and nothing
 * credential- or path-shaped ever leaves the process.
 */

const DSN = 'https://publickey@o1.ingest.us.sentry.io/2';
const COMPONENT = 'ci-planning-server';

describe('resolveTelemetrySettings', () => {
  it('is disabled when no DSN is configured', () => {
    const settings = resolveTelemetrySettings({}, COMPONENT);

    expect(settings.enabled).toBe(false);
    expect(settings.disabledReason).toBe('no-dsn');
    expect(settings.dsn).toBeNull();
  });

  it('is enabled once a DSN is present', () => {
    const settings = resolveTelemetrySettings({ SENTRY_DSN: DSN }, COMPONENT);

    expect(settings.enabled).toBe(true);
    expect(settings.disabledReason).toBeNull();
    expect(settings.dsn).toBe(DSN);
  });

  it.each(['off', 'OFF', 'false', '0', 'no', 'disabled'])(
    'CI_TELEMETRY=%s overrides a configured DSN',
    (value) => {
      const settings = resolveTelemetrySettings({ SENTRY_DSN: DSN, CI_TELEMETRY: value }, COMPONENT);

      expect(settings.enabled).toBe(false);
      expect(settings.disabledReason).toBe('opt-out');
    },
  );

  it.each(['on', 'true', '1', 'enabled', ''])('CI_TELEMETRY=%s leaves the DSN in charge', (value) => {
    expect(resolveTelemetrySettings({ SENTRY_DSN: DSN, CI_TELEMETRY: value }, COMPONENT).enabled).toBe(true);
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on'])('CI_LOCAL_ONLY=%s forbids all reporting', (value) => {
    const settings = resolveTelemetrySettings({ SENTRY_DSN: DSN, CI_LOCAL_ONLY: value }, COMPONENT);

    expect(settings.enabled).toBe(false);
    expect(settings.disabledReason).toBe('local-only');
  });

  it.each(['false', '0', 'no', 'off', ''])('CI_LOCAL_ONLY=%s leaves the DSN in charge', (value) => {
    expect(resolveTelemetrySettings({ SENTRY_DSN: DSN, CI_LOCAL_ONLY: value }, COMPONENT).enabled).toBe(true);
  });

  it('reports local-only ahead of opt-out ahead of a missing DSN', () => {
    expect(
      resolveTelemetrySettings({ CI_LOCAL_ONLY: 'true', CI_TELEMETRY: 'off' }, COMPONENT).disabledReason,
    ).toBe('local-only');
    expect(resolveTelemetrySettings({ CI_TELEMETRY: 'off' }, COMPONENT).disabledReason).toBe('opt-out');
    expect(resolveTelemetrySettings({}, COMPONENT).disabledReason).toBe('no-dsn');
  });

  it('treats blank values as unset (compose writes empty strings for unset vars)', () => {
    const settings = resolveTelemetrySettings({ SENTRY_DSN: '   ', CI_LOCAL_ONLY: '  ' }, COMPONENT);

    expect(settings.enabled).toBe(false);
    expect(settings.disabledReason).toBe('no-dsn');
    expect(settings.dsn).toBeNull();
  });

  it('derives the release from CI_PLANNING_VERSION when SENTRY_RELEASE is unset', () => {
    const settings = resolveTelemetrySettings({ SENTRY_DSN: DSN, CI_PLANNING_VERSION: '0.3.0' }, COMPONENT);

    expect(settings.release).toBe('ci-planning-server@0.3.0');
    expect(settings.deploymentVersion).toBe('0.3.0');
  });

  it('leaves the release undefined when neither is set', () => {
    expect(resolveTelemetrySettings({ SENTRY_DSN: DSN }, COMPONENT).release).toBeUndefined();
  });

  it('prefers an explicit SENTRY_RELEASE', () => {
    const settings = resolveTelemetrySettings(
      { SENTRY_DSN: DSN, CI_PLANNING_VERSION: '0.3.0', SENTRY_RELEASE: 'ci-planning-server@abc1234' },
      COMPONENT,
    );

    expect(settings.release).toBe('ci-planning-server@abc1234');
  });

  it('falls back through SENTRY_ENV, CI_PLANNING_ENVIRONMENT, then NODE_ENV', () => {
    expect(resolveTelemetrySettings({ SENTRY_DSN: DSN }, COMPONENT).environment).toBe('development');
    expect(resolveTelemetrySettings({ SENTRY_DSN: DSN, NODE_ENV: 'production' }, COMPONENT).environment).toBe(
      'production',
    );
    expect(
      resolveTelemetrySettings(
        { SENTRY_DSN: DSN, NODE_ENV: 'production', CI_PLANNING_ENVIRONMENT: 'appliance' },
        COMPONENT,
      ).environment,
    ).toBe('appliance');
    expect(
      resolveTelemetrySettings(
        {
          SENTRY_DSN: DSN,
          NODE_ENV: 'production',
          CI_PLANNING_ENVIRONMENT: 'appliance',
          SENTRY_ENV: 'staging',
        },
        COMPONENT,
      ).environment,
    ).toBe('staging');
  });

  it('exposes the two switches on their own', () => {
    expect(isTelemetryOptedOut({ CI_TELEMETRY: 'off' })).toBe(true);
    expect(isTelemetryOptedOut({ CI_TELEMETRY: 'on' })).toBe(false);
    expect(isTelemetryOptedOut({})).toBe(false);
    expect(isLocalOnly({ CI_LOCAL_ONLY: 'yes' })).toBe(true);
    expect(isLocalOnly({ CI_LOCAL_ONLY: 'no' })).toBe(false);
    expect(isLocalOnly({})).toBe(false);
  });
});

describe('scrubString', () => {
  it('redacts bearer tokens', () => {
    const scrubbed = scrubString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def');

    expect(scrubbed).toContain('[Filtered]');
    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts labelled secrets', () => {
    expect(scrubString('api_key=sk-live-1234567890')).not.toContain('sk-live-1234567890');
    expect(scrubString('password: hunter2')).not.toContain('hunter2');
    expect(scrubString('{"token":"abcdef123456"}')).not.toContain('abcdef123456');
  });

  it('redacts tailscale auth keys', () => {
    expect(scrubString('tskey-auth-abc123-def456')).toBe('[Filtered]');
  });

  it('redacts credentials embedded in connection URLs', () => {
    const scrubbed = scrubString('postgres://planning:pg_s3cure@postgres:5432/planning');

    expect(scrubbed).not.toContain('pg_s3cure');
    expect(scrubbed).toContain('[Filtered]');
  });

  it('collapses home directories, which leak the account name', () => {
    expect(scrubString('/Users/liam/devel/ci/file.ts')).toBe('~/devel/ci/file.ts');
    expect(scrubString('/home/ci/data/companion.db')).toBe('~/data/companion.db');
    expect(scrubString('C:\\Users\\liam\\app.log')).toBe('~\\app.log');
  });

  it('truncates oversized strings', () => {
    const scrubbed = scrubString('a'.repeat(9000));

    expect(scrubbed).toHaveLength(8000 + '… [truncated]'.length);
    expect(scrubbed.endsWith('… [truncated]')).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(scrubString('Cannot read properties of undefined (reading "id")')).toBe(
      'Cannot read properties of undefined (reading "id")',
    );
  });
});

describe('scrubEvent', () => {
  it('scrubs the message and every exception value', () => {
    const event = {
      message: 'reflow failed for /Users/liam/plans',
      exception: { values: [{ value: 'Bearer secrettokenvalue rejected' }, { value: '/home/ci/companion.db' }] },
    } as ErrorEvent;

    const scrubbed = scrubEvent(event)!;

    expect(scrubbed.message).toBe('reflow failed for ~/plans');
    expect(scrubbed.exception!.values![0]!.value).not.toContain('secrettokenvalue');
    expect(scrubbed.exception!.values![1]!.value).toBe('~/companion.db');
  });

  it('filters sensitive keys in extra, at any depth', () => {
    const event = {
      extra: {
        outer: { password: 'hunter2', note: '/home/ci/x' },
        dsn: 'https://k@o1.ingest.sentry.io/2',
        list: [{ api_key: 'sk-live-abc' }],
      },
    } as unknown as ErrorEvent;

    const extra = scrubEvent(event)!.extra as {
      outer: { password: string; note: string };
      dsn: string;
      list: { api_key: string }[];
    };

    expect(extra.outer.password).toBe('[Filtered]');
    expect(extra.outer.note).toBe('~/x');
    expect(extra.dsn).toBe('[Filtered]');
    expect(extra.list[0]!.api_key).toBe('[Filtered]');
  });

  it('drops request cookies and body, filters the query string, scrubs headers', () => {
    const event = {
      request: {
        cookies: { session: 'abc' },
        data: { title: 'therapy appointment' },
        query_string: 'q=private+search',
        headers: { authorization: 'Bearer abc', 'user-agent': 'curl/8' },
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event)!;

    expect(scrubbed.request!.cookies).toBeUndefined();
    expect(scrubbed.request!.data).toBeUndefined();
    expect(scrubbed.request!.query_string).toBe('[Filtered]');
    expect(scrubbed.request!.headers!.authorization).toBe('[Filtered]');
    expect(scrubbed.request!.headers!['user-agent']).toBe('curl/8');
  });

  it('scrubs breadcrumb messages and data', () => {
    const event = {
      breadcrumbs: [{ message: 'GET /Users/liam', data: { token: 'abc123', path: '/api/tasks' } }],
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event)!;

    expect(scrubbed.breadcrumbs![0]!.message).toBe('GET ~');
    expect(scrubbed.breadcrumbs![0]!.data!.token).toBe('[Filtered]');
    expect(scrubbed.breadcrumbs![0]!.data!.path).toBe('/api/tasks');
  });

  it('survives a cyclic extra payload (depth-guarded, not stack-overflowed)', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => scrubEvent({ extra: cyclic } as unknown as ErrorEvent)).not.toThrow();
  });

  it('passes through an event with nothing to scrub', () => {
    expect(scrubEvent({ message: 'plain failure' } as ErrorEvent)).toEqual({ message: 'plain failure' });
  });
});

/**
 * Regression tests for the leaks an adversarial review found in the first cut of this
 * module. Each one is a field the SDK populates REGARDLESS of `sendDefaultPii: false`
 * (verified against @sentry/core 10.69.0), so none of them is hypothetical.
 */
describe('scrubEvent — fields sendDefaultPii:false does NOT protect', () => {
  it('strips the query string from request.url, where the search terms actually are', () => {
    // The load-bearing one: requestDataIntegration always includes `url`, and on Node
    // it is path+query — so filtering `query_string` alone redacted nothing.
    const event = {
      request: {
        url: 'https://plan.example.com/api/tasks?q=therapy+appointment&api_key=sk-live-1',
        query_string: 'q=therapy+appointment',
      },
    } as unknown as ErrorEvent;

    const scrubbed = scrubEvent(event)!;

    expect(scrubbed.request!.url).toBe('https://plan.example.com/api/tasks');
    expect(scrubbed.request!.url).not.toContain('therapy');
    expect(scrubbed.request!.url).not.toContain('sk-live-1');
    expect(scrubbed.request!.query_string).toBe('[Filtered]');
  });

  it('strips query and hash from the referer header', () => {
    const event = {
      request: {
        headers: {
          referer: 'https://plan.example.com/tasks?q=divorce+lawyer#t-9',
          Referrer: 'https://plan.example.com/calendar?d=2026-08-02',
        },
      },
    } as unknown as ErrorEvent;

    const headers = scrubEvent(event)!.request!.headers!;

    expect(headers.referer).toBe('https://plan.example.com/tasks');
    expect(headers.Referrer).toBe('https://plan.example.com/calendar');
  });

  it('filters the hyphenated x-api-key header (this app authenticates with it)', () => {
    // The SDK denies only ["forwarded","-ip","remote-","via","-user"] when PII is off,
    // so `x-api-key` would otherwise upload in cleartext — and it does not match a
    // bare `apikey|api_key` pattern.
    const event = {
      request: {
        headers: { 'x-api-key': 'cp_live_abcdef123456', 'X-Api-Key': 'cp_live_abcdef123456' },
      },
    } as unknown as ErrorEvent;

    const headers = scrubEvent(event)!.request!.headers!;

    expect(headers['x-api-key']).toBe('[Filtered]');
    expect(headers['X-Api-Key']).toBe('[Filtered]');
  });

  it('removes server_name, which is the machine hostname', () => {
    const event = { message: 'boom', server_name: 'liam-macbook.local' } as unknown as ErrorEvent;

    expect(scrubEvent(event)!.server_name).toBeUndefined();
  });

  it('scrubs stack frames: absolute paths, captured locals and context lines', () => {
    // `stackFrameVariables` stays true with PII off, so `vars` really is populated.
    const event = {
      exception: {
        values: [
          {
            value: 'boom',
            stacktrace: {
              frames: [
                {
                  filename: '/Users/liam/devel/ci/server/src/app.ts',
                  abs_path: '/Users/liam/devel/ci/server/src/app.ts',
                  module: '/home/ci/app',
                  context_line: '  const key = "api_key=sk-live-9";',
                  pre_context: ['// /Users/liam/notes.md'],
                  post_context: ['  logger.info(token)'],
                  vars: { sessionToken: 'abc123', path: '/Users/liam/plan.db', count: 3 },
                },
              ],
            },
          },
        ],
      },
    } as unknown as ErrorEvent;

    const frame = scrubEvent(event)!.exception!.values![0]!.stacktrace!.frames![0]!;

    expect(frame.filename).toBe('~/devel/ci/server/src/app.ts');
    expect(frame.abs_path).toBe('~/devel/ci/server/src/app.ts');
    expect(frame.module).toBe('~/app');
    expect(frame.context_line).not.toContain('sk-live-9');
    expect(frame.pre_context![0]).toBe('// ~/notes.md');
    expect((frame.vars as Record<string, unknown>).sessionToken).toBe('[Filtered]');
    expect((frame.vars as Record<string, unknown>).path).toBe('~/plan.db');
    expect((frame.vars as Record<string, unknown>).count).toBe(3);
  });

  it('strips the query string from fetch/xhr breadcrumb urls, not just navigation', () => {
    const event = {
      breadcrumbs: [
        { category: 'http', data: { url: 'https://plan.example.com/api/tasks?q=secret+plan', status_code: 500 } },
        { category: 'navigation', data: { from: '/tasks?q=x', to: '/calendar#2026-08-02' } },
        { category: 'console', message: 'token: abc123def', data: { arguments: ['password: hunter2'] } },
      ],
    } as unknown as ErrorEvent;

    const [http, navigation, console] = scrubEvent(event)!.breadcrumbs!;

    expect(http!.data!.url).toBe('https://plan.example.com/api/tasks');
    expect(http!.data!.status_code).toBe(500);
    expect(navigation!.data).toEqual({ from: '/tasks', to: '/calendar' });
    expect(console!.message).not.toContain('abc123def');
    expect(JSON.stringify(console!.data!.arguments)).not.toContain('hunter2');
  });
});

describe('scrubUrl', () => {
  it('drops the query string and the hash', () => {
    expect(scrubUrl('https://plan.example.com/tasks?q=a#b')).toBe('https://plan.example.com/tasks');
  });

  it('still applies the string rules to what is left', () => {
    expect(scrubUrl('file:///Users/liam/plan.db?x=1')).toBe('file://~/plan.db');
    expect(scrubUrl('postgres://ci:pw@db:5432/planning?sslmode=require')).toContain('[Filtered]');
  });

  it('cannot throw on unparseable input', () => {
    expect(scrubUrl('::not a url::?q=secret')).toBe('::not a url::');
  });
});

describe('withTimeout', () => {
  it('resolves as soon as the promise settles', async () => {
    await expect(withTimeout(Promise.resolve('done'), 5_000)).resolves.toBeUndefined();
  });

  it('resolves on rejection rather than propagating it', async () => {
    await expect(withTimeout(Promise.reject(new Error('transport died')), 5_000)).resolves.toBeUndefined();
  });

  it('gives up at the deadline when the promise never settles', async () => {
    // The real bug this guards: Sentry.close(ms) bounds only the transport wait, so a
    // never-settling flush would hold an exit path open indefinitely.
    const started = Date.now();

    await withTimeout(new Promise(() => {}), 50);

    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('telemetryPermission', () => {
  it('permits reporting by default — the DSN decides from there', () => {
    expect(telemetryPermission({})).toEqual({ permitted: true, disabledReason: null });
  });

  it('is independent of SENTRY_DSN (it answers "allowed?", not "configured?")', () => {
    expect(telemetryPermission({ SENTRY_DSN: DSN }).permitted).toBe(true);
  });

  it.each(['off', 'false', '0', 'no', 'disabled'])('CI_TELEMETRY=%s withholds permission', (value) => {
    expect(telemetryPermission({ CI_TELEMETRY: value })).toEqual({
      permitted: false,
      disabledReason: 'opt-out',
    });
  });

  it.each(['true', '1', 'yes', 'on'])('CI_LOCAL_ONLY=%s withholds permission', (value) => {
    expect(telemetryPermission({ CI_LOCAL_ONLY: value })).toEqual({
      permitted: false,
      disabledReason: 'local-only',
    });
  });

  it('reports local-only ahead of opt-out', () => {
    expect(telemetryPermission({ CI_LOCAL_ONLY: 'true', CI_TELEMETRY: 'off' }).disabledReason).toBe('local-only');
  });
});

describe('GET /api/config/telemetry', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    await server.close();
  });

  it('answers without a credential and reports the runtime verdict', async () => {
    // The browser needs this before it has a session — and before Sentry.init, which
    // is the whole point: its DSN is baked in at build time and cannot see
    // CI_TELEMETRY.
    const res = await api(server.url, '/api/config/telemetry');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, disabledReason: null });
  });

  it('reflects CI_TELEMETRY=off, so the marketplace toggle reaches the browser', async () => {
    process.env.CI_TELEMETRY = 'off';
    try {
      const res = await api(server.url, '/api/config/telemetry');

      expect(res.body).toEqual({ enabled: false, disabledReason: 'opt-out' });
    } finally {
      delete process.env.CI_TELEMETRY;
    }
  });

  it('reflects CI_LOCAL_ONLY=true', async () => {
    process.env.CI_LOCAL_ONLY = 'true';
    try {
      const res = await api(server.url, '/api/config/telemetry');

      expect(res.body).toEqual({ enabled: false, disabledReason: 'local-only' });
    } finally {
      delete process.env.CI_LOCAL_ONLY;
    }
  });

  it('never echoes the DSN or any other configuration', async () => {
    process.env.SENTRY_DSN = DSN;
    try {
      const res = await api(server.url, '/api/config/telemetry');

      expect(Object.keys(res.body as object).sort()).toEqual(['disabledReason', 'enabled']);
      expect(JSON.stringify(res.body)).not.toContain('ingest');
    } finally {
      delete process.env.SENTRY_DSN;
    }
  });
});
