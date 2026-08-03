import { describe, it, expect } from 'vitest';
import type { ErrorEvent } from '@sentry/browser';
import { scrubBrowserEvent, scrubUrl, shouldDropEvent, isTelemetryEnabled } from './telemetry.js';
import { scrubHeaders, scrubString, scrubValue } from './telemetry-scrub.js';
import { INNOCUOUS_KEYS, SENSITIVE_KEYS, STRING_CASES, URL_CASES } from './telemetry-fixtures.js';

/**
 * Browser error reporting — the pure halves of lib/telemetry.ts and its scrubber.
 * Runs in the node `unit` project: no DOM is needed, and `initTelemetry` is a
 * deliberate no-op without a window, so nothing here can reach the network even if a
 * DSN leaked into the environment.
 *
 * The STRING_CASES / URL_CASES / *_KEYS fixtures are the same ones the server suite
 * runs against its own scrubber — that shared set is what keeps the two twins honest.
 */

const event = (partial: Partial<ErrorEvent>) => partial as ErrorEvent;

describe('scrubString (browser twin)', () => {
  it.each(STRING_CASES)('$name', ({ input, expected, absent }) => {
    const scrubbed = scrubString(input);

    if (expected !== undefined) expect(scrubbed).toBe(expected);
    for (const secret of absent ?? []) expect(scrubbed).not.toContain(secret);
  });

  it('truncates oversized strings', () => {
    const scrubbed = scrubString('a'.repeat(9000));

    expect(scrubbed).toHaveLength(8000 + '… [truncated]'.length);
    expect(scrubbed.endsWith('… [truncated]')).toBe(true);
  });
});

describe('scrubValue (browser twin)', () => {
  it.each(SENSITIVE_KEYS)('redacts the %s key wholesale', (key) => {
    expect((scrubValue({ [key]: 'super-secret-value' }) as Record<string, unknown>)[key]).toBe('[Filtered]');
  });

  it.each(INNOCUOUS_KEYS)('keeps the %s key, which carries real signal', (key) => {
    expect((scrubValue({ [key]: 'plain' }) as Record<string, unknown>)[key]).toBe('plain');
  });

  it('recurses into arrays and nested objects', () => {
    const scrubbed = scrubValue({ list: [{ token: 'abc' }], nested: { note: '/home/ci/x' } }) as {
      list: { token: string }[];
      nested: { note: string };
    };

    expect(scrubbed.list[0]!.token).toBe('[Filtered]');
    expect(scrubbed.nested.note).toBe('~/x');
  });

  it('is depth-guarded, so a cyclic payload cannot stall the reporting path', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => scrubValue(cyclic)).not.toThrow();
  });
});

describe('scrubUrl', () => {
  it.each(URL_CASES)('$name', ({ input, expected }) => {
    expect(scrubUrl(input)).toBe(expected);
  });

  it('leaves the origin and path exactly as written', () => {
    expect(scrubUrl('https://plan.localhost/a b/c')).toBe('https://plan.localhost/a b/c');
  });
});

describe('shouldDropEvent', () => {
  it.each([
    'Loading chunk 42 failed',
    'Failed to fetch dynamically imported module: /assets/x.js',
    'ResizeObserver loop completed with undelivered notifications',
  ])('drops known noise: %s', (message) => {
    expect(shouldDropEvent(event({ message }))).toBe(true);
  });

  it('keeps a real application error', () => {
    expect(shouldDropEvent(event({ message: 'Cannot read properties of undefined' }))).toBe(false);
  });

  it('inspects exception values, not just the message', () => {
    expect(shouldDropEvent(event({ exception: { values: [{ value: 'Loading chunk 7 failed' }] } }))).toBe(true);
  });
});

describe('scrubBrowserEvent', () => {
  it('returns null for dropped noise', () => {
    expect(scrubBrowserEvent(event({ message: 'Loading chunk 3 failed' }))).toBeNull();
  });

  it('scrubs the message and exception values, like the server does', () => {
    const scrubbed = scrubBrowserEvent(
      event({
        message: 'render failed for /Users/liam/plans',
        exception: { values: [{ value: 'Bearer secrettokenvalue rejected' }] },
      }),
    )!;

    expect(scrubbed.message).toBe('render failed for ~/plans');
    expect(scrubbed.exception!.values![0]!.value).not.toContain('secrettokenvalue');
  });

  it('filters sensitive keys in extra, at any depth', () => {
    const extra = scrubBrowserEvent(
      event({ message: 'boom', extra: { outer: { password: 'hunter2' }, note: '/home/ci/x' } }),
    )!.extra as { outer: { password: string }; note: string };

    expect(extra.outer.password).toBe('[Filtered]');
    expect(extra.note).toBe('~/x');
  });

  it('scrubs stack frames', () => {
    const frame = scrubBrowserEvent(
      event({
        message: 'boom',
        exception: {
          values: [
            {
              value: 'boom',
              stacktrace: {
                frames: [{ filename: '/Users/liam/app/main.tsx', abs_path: '/Users/liam/app/main.tsx' }],
              },
            },
          ],
        },
      }),
    )!.exception!.values![0]!.stacktrace!.frames![0]!;

    expect(frame.filename).toBe('~/app/main.tsx');
    expect(frame.abs_path).toBe('~/app/main.tsx');
  });

  it('scrubs the request url and removes cookies and query string', () => {
    const scrubbed = scrubBrowserEvent(
      event({
        message: 'boom',
        request: {
          url: 'https://plan.localhost/tasks?q=private#x',
          cookies: { session: 'abc' },
          query_string: 'q=private',
        },
      }),
    )!;

    expect(scrubbed.request!.url).toBe('https://plan.localhost/tasks');
    expect(scrubbed.request!.cookies).toBeUndefined();
    expect(scrubbed.request!.query_string).toBeUndefined();
  });

  it('strips the query string from the Referer header httpContextIntegration adds', () => {
    // document.referrer keeps the FULL same-origin previous URL under the default
    // referrer policy, so this is a real leak of the last screen the user was on.
    const headers = scrubBrowserEvent(
      event({
        message: 'boom',
        request: {
          url: '/tasks',
          headers: {
            Referer: 'https://plan.localhost/tasks?q=divorce+lawyer#t-9',
            'User-Agent': 'Mozilla/5.0',
          },
        },
      }),
    )!.request!.headers!;

    expect(headers.Referer).toBe('https://plan.localhost/tasks');
    expect(headers['User-Agent']).toBe('Mozilla/5.0');
  });

  it('scrubs navigation breadcrumb from/to', () => {
    const scrubbed = scrubBrowserEvent(
      event({
        message: 'boom',
        breadcrumbs: [{ category: 'navigation', data: { from: '/tasks?q=x', to: '/calendar#2026-08-02' } }],
      }),
    );

    expect(scrubbed!.breadcrumbs![0]!.data).toEqual({ from: '/tasks', to: '/calendar' });
  });

  it('scrubs fetch and console breadcrumbs too, not just navigation', () => {
    // breadcrumbsIntegration is on by default: fetch crumbs carry data.url WITH the
    // query string, console crumbs carry the message and raw data.arguments.
    const [fetchCrumb, consoleCrumb] = scrubBrowserEvent(
      event({
        message: 'boom',
        breadcrumbs: [
          { category: 'fetch', data: { url: '/api/tasks?q=therapy+appointment', status_code: 500 } },
          { category: 'console', message: 'token: abc123def', data: { arguments: ['password: hunter2'] } },
        ],
      }),
    )!.breadcrumbs!;

    expect(fetchCrumb!.data!.url).toBe('/api/tasks');
    expect(fetchCrumb!.data!.status_code).toBe(500);
    expect(consoleCrumb!.message).not.toContain('abc123def');
    expect(JSON.stringify(consoleCrumb!.data!.arguments)).not.toContain('hunter2');
  });

  it('leaves non-string breadcrumb data alone', () => {
    const scrubbed = scrubBrowserEvent(
      event({ message: 'boom', breadcrumbs: [{ category: 'ui.click', data: { count: 3 } }] }),
    );

    expect(scrubbed!.breadcrumbs![0]!.data).toEqual({ count: 3 });
  });

  it('passes a clean event through untouched', () => {
    expect(scrubBrowserEvent(event({ message: 'real failure' }))).toEqual({ message: 'real failure' });
  });
});

describe('scrubHeaders', () => {
  it('filters x-api-key however it is spelled', () => {
    expect(scrubHeaders({ 'x-api-key': 'cp_live_abc' })['x-api-key']).toBe('[Filtered]');
    expect(scrubHeaders({ 'X-Api-Key': 'cp_live_abc' })['X-Api-Key']).toBe('[Filtered]');
    expect(scrubHeaders({ apikey: 'cp_live_abc' }).apikey).toBe('[Filtered]');
  });
});

describe('isTelemetryEnabled', () => {
  it('is false until initTelemetry runs — which it cannot, with no window and no DSN', () => {
    expect(isTelemetryEnabled()).toBe(false);
  });
});
