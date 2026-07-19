import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './api.js';

/**
 * FTUE · T7 (#343) — client contract test for the hybrid follow-up endpoint. No
 * client test file exists for api.ts yet (the ticket left the test-dir convention
 * unconfirmed); this establishes the plainest option: mock the global `fetch` `request<T>`
 * already calls and assert on the request shape + response/error passthrough.
 */
describe('api.planWeek.nextStep', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('POSTs the input body to /api/plan-week/next-step and returns the typed response', async () => {
    const responseBody = { question: 'Which objective matters most?', options: ['a', 'b', 'c'], source: 'model' as const };
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => responseBody,
    });

    const input = {
      branch: 'schedule_tasks',
      context: { openCount: 3 },
      fallbackQuestion: 'Which task should I find time for?',
      fallbackOptions: ['x', 'y', 'z'],
    };
    const res = await api.planWeek.nextStep(input);

    expect(fetch).toHaveBeenCalledWith(
      '/api/plan-week/next-step',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(input) }),
    );
    expect(res).toEqual(responseBody);
  });

  it('a non-OK response rejects with the server-supplied error message', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      statusText: 'Unprocessable Entity',
      json: async () => ({ error: 'fallbackOptions must be exactly 3 non-empty strings' }),
    });

    await expect(
      api.planWeek.nextStep({ branch: 'x', fallbackQuestion: 'q', fallbackOptions: ['a'] }),
    ).rejects.toThrow('fallbackOptions must be exactly 3 non-empty strings');
  });
});
