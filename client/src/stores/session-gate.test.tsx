import { describe, it, expect, vi } from 'vitest';

/**
 * The account resources in stores/index.ts are created at import time. Before sign-in every
 * one of them would be refused with a 401, and in the Capacitor shell, before a server is
 * chosen, there is nothing to ask at all. These cases pin that none of them requests anything
 * until a session exists, and that they load once one does.
 */

const { calls, api } = vi.hoisted(() => {
  const calls: string[] = [];
  const recorder = (path: string[]): any =>
    new Proxy(() => {}, {
      get: (_target, key) => (key === 'then' ? undefined : recorder([...path, String(key)])),
      apply: () => {
        calls.push(path.join('.'));
        return Promise.resolve({});
      },
    });
  return { calls, api: recorder([]) };
});

vi.mock('../lib/api.js', () => ({ api }));
vi.mock('../lib/sse.js', () => ({ on: () => () => {} }));

const store = await import('./index.js');
const { setSignedIn } = await import('../lib/session.js');

describe('account data waits for a session', () => {
  it('requests nothing while signed out, and loads once signed in', async () => {
    expect(calls).toEqual([]);

    setSignedIn(true);
    await vi.waitFor(() => expect(calls).toEqual(expect.arrayContaining(['tasks.list', 'blocks.list'])));
    expect(calls).toEqual(expect.arrayContaining(['prefs.get', 'tags.list']));

    setSignedIn(false);
    const requested = calls.length;
    store.refetchTasks();
    expect(calls.length).toBe(requested);
  });
});
