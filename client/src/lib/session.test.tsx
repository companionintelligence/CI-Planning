import { describe, it, expect, vi } from 'vitest';
import { createResource, createRoot } from 'solid-js';
import { setSignedIn, signedIn, whenSignedIn } from './session.js';

/**
 * The session gate (lib/session.ts). Account resources use it as their source, and Solid
 * does not fetch while the source is false. These cases pin that contract.
 */

describe('session gate', () => {
  it('starts signed out, and whenSignedIn yields false until a session exists', () => {
    expect(signedIn()).toBe(false);
    const source = whenSignedIn(() => 'open');
    expect(source()).toBe(false);

    setSignedIn(true);
    expect(source()).toBe('open');

    setSignedIn(false);
    expect(source()).toBe(false);
  });

  it('does not fetch a resource while signed out, and fetches once a session exists', async () => {
    const fetcher = vi.fn(async (value: string) => ({ value }));
    let data!: () => { value: string } | undefined;
    createRoot(() => {
      const [resource] = createResource(whenSignedIn(() => 'open'), fetcher);
      data = resource;
    });

    expect(fetcher).not.toHaveBeenCalled();

    setSignedIn(true);
    await vi.waitFor(() => expect(data()).toEqual({ value: 'open' }));
    expect(fetcher).toHaveBeenCalledTimes(1);

    setSignedIn(false);
  });
});
