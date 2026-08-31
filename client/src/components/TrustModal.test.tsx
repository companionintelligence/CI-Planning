import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@solidjs/testing-library';
import { TrustTrigger, TrustModal, TRUST_OPTIONS, trustLabel } from './TrustModal.js';

/**
 * The trust dial as a top-bar button + pop-up, replacing the Suggest/Schedule toggle.
 *
 * The toggle it replaced was a two-state view of a three-state column: it rendered
 * 'cautious' as "Suggest" and could only ever write 'balanced' or 'hands_off'. So an
 * owner who picked Cautious during onboarding saw a control telling them they were on
 * Balanced, and had no way back to Cautious outside the API. These tests pin the two
 * properties that fixes: the trigger reports the REAL mode, and all three are reachable.
 */

describe('the collapsed trigger', () => {
  it('names the mode actually in force — including the one the old toggle could not show', () => {
    const { unmount } = render(() => <TrustTrigger mode="cautious" onOpen={() => {}} />);
    expect(screen.getByText('Cautious')).toBeTruthy();
    unmount();
    render(() => <TrustTrigger mode="hands_off" onOpen={() => {}} />);
    expect(screen.getByText('Hands-off')).toBeTruthy();
  });

  it('falls back to Balanced for an absent or unknown mode, matching the column default', () => {
    const { unmount } = render(() => <TrustTrigger mode={undefined} onOpen={() => {}} />);
    expect(screen.getByText('Balanced')).toBeTruthy();
    unmount();
    render(() => <TrustTrigger mode="bogus" onOpen={() => {}} />);
    expect(screen.getByText('Balanced')).toBeTruthy();
  });

  it('opens on click', () => {
    const onOpen = vi.fn();
    render(() => <TrustTrigger mode="balanced" onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe('the modal', () => {
  type Props = Parameters<typeof TrustModal>[0];
  const setup = (over: Partial<Props> = {}) => {
    const props: Props = { mode: 'balanced', onPick: vi.fn(), onClose: vi.fn(), ...over };
    render(() => <TrustModal {...props} />);
    return props;
  };

  it('offers all three positions — the whole point of replacing the toggle', () => {
    setup();
    for (const opt of TRUST_OPTIONS) expect(screen.getByText(opt.label)).toBeTruthy();
    expect(TRUST_OPTIONS).toHaveLength(3);
  });

  it('marks the active option with aria-pressed', () => {
    setup({ mode: 'cautious' });
    const active = screen.getByText('Cautious').closest('button')!;
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Hands-off').closest('button')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('reports the chosen mode', () => {
    const props = setup({ mode: 'balanced' });
    fireEvent.click(screen.getByText('Cautious').closest('button')!);
    expect(props.onPick).toHaveBeenCalledWith('cautious');
  });

  it('closes on the backdrop and on the close button, but not on a click inside', () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText('Close'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    // A click on the panel itself must not fall through to the backdrop handler.
    fireEvent.click(screen.getByText('Balanced').closest('button')!);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('dialog'));
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('disables the options while a save is in flight', () => {
    setup({ busy: true });
    for (const opt of TRUST_OPTIONS) {
      expect((screen.getByText(opt.label).closest('button') as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('describes each tier without promising auto-promotion, which no tier does any more', () => {
    // The pre-AF-3 copy said Balanced "auto-promotes high-confidence items" and Hands-off
    // "auto-promotes and auto-schedules". Promotion is unconditional in every mode now, so
    // any mention of it here is a description of behaviour the app does not have.
    for (const opt of TRUST_OPTIONS) expect(opt.hint.toLowerCase()).not.toContain('promot');
  });
});

describe('trustLabel', () => {
  it('maps each stored value to its display name, defaulting unknowns to Balanced', () => {
    expect(trustLabel('cautious')).toBe('Cautious');
    expect(trustLabel('balanced')).toBe('Balanced');
    expect(trustLabel('hands_off')).toBe('Hands-off');
    expect(trustLabel(null)).toBe('Balanced');
  });
});
