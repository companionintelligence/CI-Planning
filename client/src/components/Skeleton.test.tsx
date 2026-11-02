import { describe, it, expect } from 'vitest';
import { render } from '@solidjs/testing-library';
import { Skeleton } from './Skeleton.js';

describe('Skeleton', () => {
  it('takes its size from the caller and is hidden from assistive technology', () => {
    const { container } = render(() => <Skeleton class="h-3 w-1/2" />);
    const bar = container.querySelector('.skeleton');
    expect(bar).toHaveClass('block', 'h-3', 'w-1/2');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
  });
});
