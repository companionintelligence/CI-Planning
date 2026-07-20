import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import type { PatternType } from '../lib/api.js';

/**
 * PatternTypeManager (#391) — the contracts worth pinning:
 *   1. create posts name + icon_shape + color_token;
 *   2. the server's builtin-400 / in-use-409 messages surface verbatim via toast;
 *   3. per-type recolour patches color_token (including null = clear).
 */

const createMock = vi.fn(async (_b: unknown) => ({ pattern_type: { id: 'ty-new' } }));
const updateMock = vi.fn(async (_id: string, _b: unknown) => ({ pattern_type: { id: 'ty-1' } }));
const deleteMock = vi.fn(async (_id: string) => ({ ok: true }));
vi.mock('../lib/api.js', () => ({
  api: {
    patternTypes: {
      create: (b: unknown) => createMock(b),
      update: (id: string, b: unknown) => updateMock(id, b),
      delete: (id: string) => deleteMock(id),
    },
  },
}));

const TYPES: PatternType[] = [
  { id: 'ty-1', owner_id: 'o', name: 'Routine', icon_shape: 'square', reminder_config: null, is_builtin: true, color_token: null, texture: null, default_est_minutes: null, notify: false },
  { id: 'ty-2', owner_id: 'o', name: 'Deep work', icon_shape: 'hexagon', reminder_config: null, is_builtin: false, color_token: 'tag-2', texture: null, default_est_minutes: null, notify: false },
];
const [typesSig] = createSignal<PatternType[]>(TYPES);
const refetchMock = vi.fn();
const toastMock = vi.fn();
vi.mock('../stores/index.js', () => ({
  patternTypes: () => typesSig(),
  refetchPatternTypes: () => refetchMock(),
  showToast: (...a: unknown[]) => toastMock(...a),
}));

const { PatternTypeManager } = await import('./PatternTypeManager.js');

const mount = () => render(() => <PatternTypeManager onClose={vi.fn()} />);

describe('PatternTypeManager — create, rename, recolour, delete', () => {
  beforeEach(() => {
    createMock.mockReset().mockResolvedValue({ pattern_type: { id: 'ty-new' } });
    updateMock.mockReset().mockResolvedValue({ pattern_type: { id: 'ty-1' } });
    deleteMock.mockReset().mockResolvedValue({ ok: true });
    refetchMock.mockReset();
    toastMock.mockReset();
  });

  it('lists types; builtins carry the badge (rename allowed, delete protected server-side)', () => {
    mount();
    expect((screen.getByLabelText('Rename Routine') as HTMLInputElement).value).toBe('Routine');
    expect(screen.getAllByText('built-in')).toHaveLength(1); // only ty-1
  });

  it('create posts name + icon_shape + color_token', async () => {
    mount();
    fireEvent.click(screen.getByText('New type'));
    fireEvent.input(screen.getByPlaceholderText('Type name'), { target: { value: 'Errand' } });
    fireEvent.change(screen.getByLabelText('Icon shape'), { target: { value: 'diamond' } });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => expect(createMock).toHaveBeenCalledWith({ name: 'Errand', icon_shape: 'diamond', color_token: null }));
    await waitFor(() => expect(refetchMock).toHaveBeenCalled());
  });

  it("delete failures surface the server's message verbatim (400 builtin / 409 in-use)", async () => {
    deleteMock.mockRejectedValue(new Error('built-in types cannot be deleted'));
    mount();
    fireEvent.click(screen.getByTitle('Delete Routine'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('built-in types cannot be deleted', 'error'));

    deleteMock.mockRejectedValue(new Error('type is in use by patterns'));
    fireEvent.click(screen.getByTitle('Delete Deep work'));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('type is in use by patterns', 'error'));
  });

  it('rename patches on change; blank names are ignored', async () => {
    mount();
    const input = screen.getByLabelText('Rename Deep work');
    fireEvent.change(input, { target: { value: 'Deeper work' } });
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('ty-2', { name: 'Deeper work' }));

    updateMock.mockClear();
    fireEvent.change(input, { target: { value: '   ' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(updateMock).not.toHaveBeenCalled();
  });
});
