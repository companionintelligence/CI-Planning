import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { BootScreen } from './BootScreen.js';

/**
 * The first screen a person sees while the app starts. It is the only thing on screen while the
 * server answers, so it has to say what is happening to a screen reader, and draw its mark as
 * decoration rather than as part of the spoken name.
 */
describe('BootScreen', () => {
  it('announces that Companion Planning is loading, as a status region', () => {
    render(() => <BootScreen />);
    const status = screen.getByRole('status', { name: 'Loading Companion Planning' });
    expect(status.textContent).toContain('Companion Planning');
  });

  it('draws the mark and the progress bar as decoration, hidden from assistive technology', () => {
    render(() => <BootScreen />);
    expect(document.querySelector('.boot-mark')?.getAttribute('aria-hidden')).toBe('true');
    expect(document.querySelector('.boot-progress')?.getAttribute('aria-hidden')).toBe('true');
  });
});
