import { describe, it, expect } from 'vitest';
import { createFixtureGoogleClient, createGoogleClient } from '../src/mcp/google.js';

describe('Google MCP client (fixture-backed)', () => {
  const client = createFixtureGoogleClient();

  it('lists email fixtures', async () => {
    const emails = await client.listEmails();
    expect(emails.length).toBeGreaterThanOrEqual(20);
    for (const e of emails) {
      expect(e.id).toBeTruthy();
      expect(e.subject).toBeTruthy();
      expect(e.body).toBeTruthy();
      expect(Number.isNaN(new Date(e.receivedAt).getTime())).toBe(false);
    }
  });

  it('lists calendar fixtures with valid time ranges', async () => {
    const events = await client.listEvents();
    expect(events.length).toBeGreaterThanOrEqual(16);
    for (const ev of events) {
      expect(new Date(ev.end).getTime()).toBeGreaterThanOrEqual(new Date(ev.start).getTime());
    }
  });

  it('filters emails by since', async () => {
    const all = await client.listEmails();
    const cutoff = '2026-05-28T00:00:00.000Z';
    const recent = await client.listEmails({ since: cutoff });
    expect(recent.length).toBeLessThan(all.length);
    expect(recent.every((e) => e.receivedAt >= cutoff)).toBe(true);
  });

  it('filters events by from/to window', async () => {
    const windowed = await client.listEvents({ from: '2026-06-02T00:00:00.000Z', to: '2026-06-03T23:59:59.000Z' });
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed.every((e) => e.start >= '2026-06-02T00:00:00.000Z' && e.start <= '2026-06-03T23:59:59.000Z')).toBe(true);
  });

  it('respects a limit', async () => {
    const five = await client.listEmails({ limit: 5 });
    expect(five.length).toBe(5);
  });

  it('createGoogleClient() defaults to fixture mode under GOOGLE_MODE=fixture', () => {
    expect(createGoogleClient().mode).toBe('fixture');
  });
});
