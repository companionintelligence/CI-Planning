import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@solidjs/testing-library';

/**
 * Settings card for the mobile shell: shows the connected server and offers a
 * two-step "Change server". `changeServer` is mocked — its effects (op-log discard,
 * cursor reset, reload) are covered in lib/server-config.test.ts.
 */

const changeMock = vi.fn(async () => {});
vi.mock('../lib/server-config.js', () => ({
  getServerUrl: () => 'http://192.168.1.20:3848',
  changeServer: () => changeMock(),
}));

const { ServerConnection } = await import('./ServerConnection.js');

beforeEach(() => changeMock.mockClear());

describe('ServerConnection', () => {
  it('shows the server the app is connected to', () => {
    const { getByTestId } = render(() => <ServerConnection />);
    expect(getByTestId('server-url')).toHaveTextContent('http://192.168.1.20:3848');
  });

  it('does not switch on the first tap — it warns about unsynced edits and waits', () => {
    const { getByRole, queryByRole } = render(() => <ServerConnection />);

    fireEvent.click(getByRole('button', { name: /change server/i }));

    expect(getByRole('alert')).toHaveTextContent(/discards any changes you made offline/i);
    expect(changeMock).not.toHaveBeenCalled();
    expect(queryByRole('button', { name: /change server/i })).toBeNull();
  });

  it('cancel backs out without switching', () => {
    const { getByRole, queryByRole } = render(() => <ServerConnection />);

    fireEvent.click(getByRole('button', { name: /change server/i }));
    fireEvent.click(getByRole('button', { name: /cancel/i }));

    expect(queryByRole('alert')).toBeNull();
    expect(getByRole('button', { name: /change server/i })).toBeInTheDocument();
    expect(changeMock).not.toHaveBeenCalled();
  });

  it('switches only after the explicit confirmation', async () => {
    const { getByRole } = render(() => <ServerConnection />);

    fireEvent.click(getByRole('button', { name: /change server/i }));
    fireEvent.click(getByRole('button', { name: /switch server/i }));

    await waitFor(() => expect(changeMock).toHaveBeenCalledTimes(1));
  });

  it('never submits the surrounding Settings form (every button is type=button)', () => {
    const { container, getByRole } = render(() => <ServerConnection />);
    fireEvent.click(getByRole('button', { name: /change server/i }));

    for (const b of container.querySelectorAll('button')) {
      expect(b.getAttribute('type')).toBe('button');
    }
  });
});
