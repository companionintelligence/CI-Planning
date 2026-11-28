import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@solidjs/testing-library';
import { localISODate } from '../lib/dates.js';

const getNote = vi.fn(async (_date: string) => ({ note: null }));
vi.mock('../lib/api.js', () => ({ api: { reflections: { get: (date: string) => getNote(date), setNote: vi.fn() } } }));
vi.mock('../stores/index.js', async () => {
  const { createSignal } = await import('solid-js');
  const [selectedDay, setSelectedDay] = createSignal(localISODate());
  return {
    selectedDay, setSelectedDay,
    blocks: () => [],
    tasks: () => [
      { id: 'today-task', title: 'Today task', scheduled_for: localISODate(), status: 'open', tags: [] },
      { id: 'future-task', title: 'Future task', scheduled_for: '2099-02-01', status: 'open', tags: [] },
    ],
    taskOf: () => undefined,
    prefs: () => ({ time_sense_enabled: false }), tags: () => [], patternPrefs: () => ({ prefs: {} }),
    focusAppearance: () => ({ sessionMinutes: 30 }), categoryPrefs: () => ({ prefs: {} }),
    conflictedBlockIds: () => new Set(),
    refetchTasks: vi.fn(), refetchBlocks: vi.fn(), showToast: vi.fn(), openCloseRitual: vi.fn(),
  };
});
vi.mock('../components/FocusRitual.js', () => ({ FocusRitual: () => null }));
vi.mock('../components/FocusLab.js', () => ({ FocusLab: () => null }));
vi.mock('../components/FocusReminders.js', () => ({ FocusReminders: () => null }));
vi.mock('../components/TrialityBanner.js', () => ({ TrialityBanner: () => null }));
vi.mock('../components/DayGoals.js', () => ({ BriefMenu: () => null, FocusMenu: () => null }));
vi.mock('../components/DayReflowBanner.js', () => ({ DayReflowBanner: () => null }));
vi.mock('../components/EmptyStateConnectCTA.js', () => ({ EmptyStateConnectCTA: () => null }));
vi.mock('../components/LockToggle.js', () => ({ LockToggle: () => null }));
vi.mock('../components/SectionAddTask.js', () => ({ SectionAddTask: () => null }));

const { Focus } = await import('./Focus.js');
const { setSelectedDay } = await import('../stores/index.js');
afterEach(() => { setSelectedDay(localISODate()); vi.clearAllMocks(); });

describe('Focus day picker', () => {
  it('loads the chosen day’s tasks and note, with a way back to today', async () => {
    render(() => <Focus />);
    expect(screen.getByText('Today task')).toBeTruthy();
    setSelectedDay('2099-01-01'); // Start the calendar near the fixture date without navigating 870 months.
    fireEvent.click(screen.getByRole('button', { name: /Choose Focus day/ }));
    const calendar = screen.getByRole('dialog', { name: 'Choose Focus day' });
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    fireEvent.click(screen.getByRole('button', { name: 'February 1, 2099' }));
    fireEvent.click(calendar.querySelector('button.btn-primary')!);
    expect(screen.getByText('Future task')).toBeTruthy();
    expect(screen.queryByText('Today task')).toBeNull();
    await waitFor(() => expect(getNote).toHaveBeenCalledWith('2099-02-01'));
    fireEvent.click(screen.getByRole('button', { name: /Choose Focus day/ }));
    const returnCalendar = screen.getByRole('dialog', { name: 'Choose Focus day' });
    fireEvent.click(returnCalendar.querySelector('footer button')!);
    fireEvent.click(returnCalendar.querySelector('button.btn-primary')!);
    expect(screen.getByText('Today task')).toBeTruthy();
  });
});
