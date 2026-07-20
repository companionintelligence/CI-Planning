import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import type { CalibrationScopes } from '../lib/api.js';

/**
 * CalibrationPins (#390) — the contracts worth pinning:
 *   1. Pin sends the suggestion's ORIGINAL tag_ids array (never a re-split scope_ref);
 *   2. Unpin URL-encodes the '+'-joined ref;
 *   3. flag off → no fetch at all (the resource source is null);
 *   4. labels resolve via tags(); a deleted tag's id renders `unknown`.
 */

const scopesMock = vi.fn(async (): Promise<CalibrationScopes> => ({ rows: [], pins: [], suggestions: [] }));
const addPinMock = vi.fn(async (_ids: string[]) => ({ ok: true, scope_ref: 'a+b' }));
const removePinMock = vi.fn(async (_ref: string) => ({ ok: true }));
vi.mock('../lib/api.js', () => ({
  api: {
    calibration: {
      scopes: () => scopesMock(),
      addPin: (ids: string[]) => addPinMock(ids),
      // Mirror the real wrapper: the component passes the RAW ref; the wrapper encodes.
      removePin: (ref: string) => removePinMock(encodeURIComponent(ref)),
    },
  },
}));

const prefsBox = { current: { time_sense_enabled: true, calibration_loop_enabled: true } as Record<string, unknown> | undefined };
const toastMock = vi.fn();
vi.mock('../stores/index.js', () => ({
  prefs: () => prefsBox.current,
  tags: () => [
    { id: 'tag-deep', name: 'deep' },
    { id: 'tag-writing', name: 'writing' },
  ],
  showToast: (...a: unknown[]) => toastMock(...a),
}));

const { CalibrationPins } = await import('./CalibrationPins.js');

const SUGGESTION = {
  scope_ref: 'tag-deep+tag-writing',
  tag_ids: ['tag-deep', 'tag-writing'],
  sample_count: 7,
  combo_bias: 1.42,
  component_bias: 1.08,
};

describe('CalibrationPins — see, pin, unpin', () => {
  beforeEach(() => {
    scopesMock.mockReset().mockResolvedValue({ rows: [], pins: [], suggestions: [] });
    addPinMock.mockReset().mockResolvedValue({ ok: true, scope_ref: 'a+b' });
    removePinMock.mockReset().mockResolvedValue({ ok: true });
    toastMock.mockReset();
    prefsBox.current = { time_sense_enabled: true, calibration_loop_enabled: true };
  });

  it('renders a suggestion with resolved names, multiplier copy, and sample count', async () => {
    scopesMock.mockResolvedValue({ rows: [], pins: [], suggestions: [SUGGESTION] });
    render(() => <CalibrationPins />);
    await screen.findByText(/#deep \+ #writing/);
    screen.getByText(/~1\.4× typical \(vs ~1\.1× for its tags alone\) · 7 samples/);
  });

  it('Pin sends the ORIGINAL tag_ids array and refetches', async () => {
    scopesMock.mockResolvedValue({ rows: [], pins: [], suggestions: [SUGGESTION] });
    render(() => <CalibrationPins />);
    fireEvent.click(await screen.findByText('Pin'));

    await waitFor(() => expect(addPinMock).toHaveBeenCalledWith(['tag-deep', 'tag-writing']));
    await waitFor(() => expect(scopesMock).toHaveBeenCalledTimes(2)); // initial + refetch
  });

  it('Unpin sends the URL-encoded scope_ref', async () => {
    scopesMock.mockResolvedValue({
      rows: [], suggestions: [],
      pins: [{ scope_ref: 'tag-deep+tag-writing', created_at: '2026-07-19T00:00:00.000Z' }],
    });
    render(() => <CalibrationPins />);
    fireEvent.click(await screen.findByText('Unpin'));

    await waitFor(() => expect(removePinMock).toHaveBeenCalledWith(encodeURIComponent('tag-deep+tag-writing')));
  });

  it('flag off → no fetch, nothing rendered', async () => {
    prefsBox.current = { time_sense_enabled: false };
    const { container } = render(() => <CalibrationPins />);
    await new Promise((r) => setTimeout(r, 30));
    expect(scopesMock).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  });

  it('a tag id missing from tags() renders `unknown` without crashing', async () => {
    scopesMock.mockResolvedValue({
      rows: [], suggestions: [],
      pins: [{ scope_ref: 'tag-deep+tag-GONE', created_at: '2026-07-19T00:00:00.000Z' }],
    });
    render(() => <CalibrationPins />);
    await screen.findByText(/#deep \+ #unknown/);
  });

  it('zero suggestions + zero pins → the single quiet line', async () => {
    render(() => <CalibrationPins />);
    await screen.findByText(/No combo patterns detected yet/);
  });
});
