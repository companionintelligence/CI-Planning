import { describe, it, expect } from 'vitest';
import type { ErrorEvent } from '@sentry/browser';
import { scrubBrowserEvent, scrubUrl, shouldDropEvent, isTelemetryEnabled } from './telemetry.js';

/**
 * Browser error reporting — the pure halves of lib/telemetry.ts (URL scrubbing, noise
 * filtering, `beforeSend`). Runs in the node `unit` project: no DOM is needed, and
 * `initTelemetry` is a deliberate no-op without a window, so nothing here can reach the
 * network even if a DSN leaked into the environment.
 */

const event = (partial: Partial<ErrorEvent>) => partial as ErrorEvent;

describe('scrubUrl', () => {
  it('drops the query string and the hash', () => {
    expect(scrubUrl('https://plan.localhost/tasks?q=therapy+appointment#t-42')).toBe(
      'https://plan.localhost/tasks',
    );
  });

  it('drops a hash with no query', () => {
    expect(scrubUrl('/calendar#2026-08-02')).toBe('/calendar');
  });

  it('keeps a bare path intact', () => {
    expect(scrubUrl('/tasks/2026')).toBe('/tasks/2026');
  });

  it('leaves the origin and path exactly as written', () => {
    expect(scrubUrl('https://plan.localhost/a b/c')).toBe('https://plan.localhost/a b/c');
  });

  it('handles unparseable input without throwing', () => {
    expect(scrubUrl('::not a url::?q=secret')).toBe('::not a url::');
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
    );

    expect(scrubbed!.request!.url).toBe('https://plan.localhost/tasks');
    expect(scrubbed!.request!.cookies).toBeUndefined();
    expect(scrubbed!.request!.query_string).toBeUndefined();
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

describe('isTelemetryEnabled', () => {
  it('is false until initTelemetry runs — which it cannot, with no window and no DSN', () => {
    expect(isTelemetryEnabled()).toBe(false);
  });
});
