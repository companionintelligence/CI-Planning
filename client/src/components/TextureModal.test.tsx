import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, screen } from '@solidjs/testing-library';
import { TextureTrigger, TextureModal } from './TextureModal.js';

/**
 * The texture picker collapsed into a pop-up (0151) — what used to be an On/Off chip,
 * an Auto chip, and a 14-swatch grid wrapping to three rows in the wizard's 290px pane.
 *
 * The trigger has to say the current state on its own, because that state is no longer
 * visible: a control you must open to read is worse than the grid it replaced.
 */

describe('the collapsed trigger', () => {
  it('reads On · Auto when the colour is derived', () => {
    render(() => <TextureTrigger enabled colorToken={null} onOpen={() => {}} />);
    expect(screen.getByText('On · Auto')).toBeTruthy();
  });

  it('reads On when a colour is pinned, and Off when disabled', () => {
    const { unmount } = render(() => <TextureTrigger enabled colorToken="tag-3" onOpen={() => {}} />);
    expect(screen.getByText('On')).toBeTruthy();
    unmount();
    render(() => <TextureTrigger enabled={false} colorToken={null} onOpen={() => {}} />);
    expect(screen.getByText('Off')).toBeTruthy();
  });

  it('opens on click', () => {
    const onOpen = vi.fn();
    render(() => <TextureTrigger enabled colorToken={null} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe('the modal', () => {
  type Props = Parameters<typeof TextureModal>[0];
  const setup = (over: Partial<Props> = {}) => {
    const props: Props = {
      enabled: true, colorToken: null,
      onToggle: vi.fn(), onColor: vi.fn(), onClose: vi.fn(), ...over,
    };
    render(() => <TextureModal {...props} />);
    return props;
  };

  it('hides the colour grid when texture is off — nothing to colour', () => {
    setup({ enabled: false });
    expect(screen.queryByText('Colour')).toBeNull();
  });

  it('toggles and closes', () => {
    const props = setup();
    fireEvent.click(screen.getByText('On'));
    expect(props.onToggle).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByText('Done'));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('explains what Auto actually derives from', () => {
    setup({ colorToken: null });
    expect(screen.getByText(/derived from the categories/)).toBeTruthy();
  });

  it('closes on Escape and on a backdrop click, not on a click inside', () => {
    const props = setup();
    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(dialog); // backdrop — the click target IS the dialog element
    expect(props.onClose).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByText('Texture')); // inside the card
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });
});
