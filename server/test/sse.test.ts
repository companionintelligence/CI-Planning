import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { registerClient, broadcast } from '../src/routes/sse.js';

function collect(stream: PassThrough) {
  let buf = '';
  stream.on('data', (c) => {
    buf += c.toString();
  });
  return () => buf;
}
const tick = () => new Promise((r) => setImmediate(r));

describe('SSE owner isolation', () => {
  it('delivers an event only to streams belonging to the target owner', async () => {
    const a = new PassThrough();
    const b = new PassThrough();
    const textA = collect(a);
    const textB = collect(b);
    const offA = registerClient(a, 1);
    const offB = registerClient(b, 2);

    broadcast(1, 'task:created', { id: 99 });
    await tick();

    expect(textA()).toContain('event: task:created');
    expect(textA()).toContain('"id":99');
    expect(textB()).not.toContain('task:created');

    offA();
    offB();
  });

  it('stops delivering to a client after it unregisters', async () => {
    const a = new PassThrough();
    const textA = collect(a);
    const off = registerClient(a, 5);
    off();

    broadcast(5, 'task:updated', { id: 1 });
    await tick();

    expect(textA()).not.toContain('task:updated');
  });
});
