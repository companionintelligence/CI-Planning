import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';
import type { ProbeResult } from '../lib/server-config.js';

/**
 * The mobile shell's first-run "Connect to your server" screen. The probe and the
 * save-and-reload are the seams: `probeServer` is mocked (no network) and `connectTo`
 * is a spy (jsdom cannot navigate). What is asserted is the contract with the user —
 * nothing is saved until the address checks out, and each way it can fail says
 * something different.
 */

const probeMock = vi.fn<(input: string) => Promise<ProbeResult>>();
const connectMock = vi.fn<(url: string) => void>();
vi.mock('../lib/server-config.js', () => ({
  probeServer: (input: string) => probeMock(input),
  connectTo: (url: string) => connectMock(url),
}));

const { ConnectServer } = await import('./ConnectServer.js');

function renderScreen() {
  const r = render(() => <ConnectServer />);
  const input = r.getByLabelText('Server address') as HTMLInputElement;
  const button = r.getByRole('button', { name: /connect/i }) as HTMLButtonElement;
  return { ...r, input, button };
}

beforeEach(() => {
  probeMock.mockReset();
  connectMock.mockReset();
});

describe('ConnectServer', () => {
  it('asks for the server address and will not submit an empty one', () => {
    const { getByRole, button } = renderScreen();

    expect(getByRole('heading', { name: 'Connect to your server' })).toBeInTheDocument();
    expect(button).toBeDisabled();
  });

  it('saves the normalised URL once the probe succeeds', async () => {
    probeMock.mockResolvedValue({ ok: true, url: 'http://192.168.1.20:3848' });
    const { input, button } = renderScreen();

    fireEvent.input(input, { target: { value: '192.168.1.20:3848' } });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    await waitFor(() => expect(connectMock).toHaveBeenCalledWith('http://192.168.1.20:3848'));
    expect(probeMock).toHaveBeenCalledWith('192.168.1.20:3848');
  });

  it.each([
    ['invalid', /does not look like a web address/i],
    ['unreachable', /could not reach that address/i],
    ['not-planning', /does not look like a Companion Planning server/i],
  ] as const)('shows a distinct message for %s and saves nothing', async (reason, message) => {
    probeMock.mockResolvedValue({ ok: false, reason });
    const { input, button, findByRole } = renderScreen();

    fireEvent.input(input, { target: { value: 'http://10.0.0.9:3848' } });
    fireEvent.click(button);

    expect(await findByRole('alert')).toHaveTextContent(message);
    expect(connectMock).not.toHaveBeenCalled();
    expect(button).not.toBeDisabled(); // can retry
  });

  it('clears an earlier problem when the next attempt starts', async () => {
    probeMock.mockResolvedValueOnce({ ok: false, reason: 'unreachable' });
    const { input, button, findByRole, queryByRole } = renderScreen();

    fireEvent.input(input, { target: { value: 'http://10.0.0.9:3848' } });
    fireEvent.click(button);
    await findByRole('alert');

    probeMock.mockReturnValueOnce(new Promise(() => {})); // second attempt hangs
    fireEvent.click(button);
    await waitFor(() => expect(queryByRole('alert')).toBeNull());
  });
});
