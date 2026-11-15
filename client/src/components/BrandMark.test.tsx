import { describe, it, expect } from 'vitest';
import { render } from '@solidjs/testing-library';
import { BrandMark } from './BrandMark.js';

describe('BrandMark', () => {
  it('draws the app mark at the size it is given, hidden from assistive technology', () => {
    const { container } = render(() => <BrandMark size={32} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('32');
    expect(svg?.getAttribute('height')).toBe('32');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('gives each mark its own gradient, so two marks on one page never share an id', () => {
    const { container } = render(() => (
      <>
        <BrandMark size={24} />
        <BrandMark size={48} />
      </>
    ));
    const ids = Array.from(container.querySelectorAll('[id^="brand-mark-bg-"]')).map((el) => el.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});
