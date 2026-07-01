import { describe, it, expect } from 'vitest';
import { createSignal } from 'solid-js';
import { render, fireEvent } from '@solidjs/testing-library';

/**
 * Harness canary — proves the jsdom + Solid `dom` project genuinely RE-RENDERS
 * on a signal change. This is the guard against a false-green harness: if two
 * copies of solid-js are loaded (the dedupe in vitest.config.ts regresses), the
 * signal updates but the component's DOM does NOT, and this test FAILS at the
 * `1` assertion. Its only job is to catch exactly that.
 */
describe('reactivity smoke', () => {
  it('re-renders the DOM when a signal changes', async () => {
    function Counter() {
      const [count, setCount] = createSignal(0);
      return (
        <button type="button" onClick={() => setCount((c) => c + 1)}>
          count: {count()}
        </button>
      );
    }

    const { getByRole } = render(() => <Counter />);
    const btn = getByRole('button');

    expect(btn).toHaveTextContent('count: 0');

    fireEvent.click(btn);

    // If Solid is deduped, the reactive update flushes and the DOM now reads 1.
    expect(btn).toHaveTextContent('count: 1');
  });
});
