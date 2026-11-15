import { describe, it, expect } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { MotivationBalanceBlock } from './MotivationBalanceBlock.js';
import type { MotivationBalance } from '../lib/api.js';

/**
 * The recap's "Me, us, them" block. Worth pinning: the exact minutes are in words (the bar is only
 * a picture of them), unlabeled time is its own thing and never `us`, a segment with no minutes is
 * not printed, and a week with no timed work says so instead of drawing empty bars.
 */

const data: MotivationBalance = {
  week_start: '2026-07-06',
  basis: 'timed',
  categories: [
    { category: 'health', me: 60, us: 0, them: 30, unlabeled: 0, total: 90 },
    { category: 'work', me: 0, us: 45, them: 30, unlabeled: 15, total: 90 },
  ],
  overall: { me: 80, us: 45, them: 40, unlabeled: 15, total: 180 },
};

const rows = () => screen.getAllByTestId('motivation-row');

describe('MotivationBalanceBlock', () => {
  it('draws the whole week first, then one row per category, in the order given', () => {
    render(() => <MotivationBalanceBlock data={data} />);
    expect(rows().map((r) => r.querySelector('span')?.textContent)).toEqual(['Whole week', 'health', 'work']);
  });

  it('states the minutes in words, as h/m', () => {
    render(() => <MotivationBalanceBlock data={data} />);
    const [week, health, work] = rows();
    expect(week.textContent).toContain('3h');                       // total 180
    expect(week.textContent).toContain('me 1h 20m · us 45m · them 40m · unlabeled 15m');
    expect(health.textContent).toContain('me 1h · them 30m');
    expect(work.textContent).toContain('us 45m · them 30m · unlabeled 15m');
  });

  it('does not print a segment that has no minutes', () => {
    render(() => <MotivationBalanceBlock data={data} />);
    const health = rows()[1].textContent!;
    expect(health).not.toContain('us 0m');
    expect(health).not.toContain('unlabeled');
  });

  it('keeps unlabeled time out of us', () => {
    render(() => (
      <MotivationBalanceBlock data={{
        ...data,
        categories: [{ category: 'home', me: 0, us: 0, them: 0, unlabeled: 40, total: 40 }],
        overall: { me: 0, us: 0, them: 0, unlabeled: 40, total: 40 },
      }} />
    ));
    const home = rows()[1].textContent!;
    expect(home).toContain('unlabeled 40m');
    expect(home).not.toMatch(/\bus \d/);
  });

  it('sizes the bar segments over all of the row\'s minutes, so unlabeled time shows as grey', () => {
    render(() => <MotivationBalanceBlock data={data} />);
    const work = rows()[2].querySelector('[aria-hidden="true"]')!;
    const widths = [...work.children].map((c) => (c as HTMLElement).style.width);
    expect(widths).toEqual(['0%', '50%', `${(30 / 90) * 100}%`, `${(15 / 90) * 100}%`]);
  });

  it('hides the bar from a screen reader (the words carry the data)', () => {
    render(() => <MotivationBalanceBlock data={data} />);
    for (const r of rows()) expect(r.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('says so, and draws nothing, when the week had no timed work', () => {
    render(() => (
      <MotivationBalanceBlock data={{ week_start: '2026-07-06', basis: 'timed', categories: [], overall: { me: 0, us: 0, them: 0, unlabeled: 0, total: 0 } }} />
    ));
    expect(screen.getByText('No timed work last week.')).toBeTruthy();
    expect(screen.queryAllByTestId('motivation-row')).toHaveLength(0);
  });

  it('explains the two things that make the rows hard to add up', () => {
    render(() => <MotivationBalanceBlock data={data} />);
    const note = screen.getByText(/by the label each task has now/);
    expect(note.textContent).toMatch(/unlabeled tasks is shown separately/);
    expect(note.textContent).toMatch(/counts in each of its categories/);
  });

  it('a whole-week total of zero but categories present still shows the empty state', () => {
    // overall is the authority for "was there any timed work"
    render(() => (
      <MotivationBalanceBlock data={{ ...data, overall: { me: 0, us: 0, them: 0, unlabeled: 0, total: 0 } }} />
    ));
    expect(screen.getByText('No timed work last week.')).toBeTruthy();
  });
});
