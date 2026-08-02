import { describe, it, expect } from 'vitest';
import type { ErrorEvent } from '@sentry/node';
import { resolveTelemetrySettings, isLocalOnly, isTelemetryOptedOut } from '../src/lib/telemetry/settings.js';
import { scrubEvent, scrubString } from '../src/lib/telemetry/scrub.js';

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
