/**
 * CalendarBridge — wraps an external Google Calendar source so the planning server
 * can sync events into calendar_links and create new blocks for tasks.
 *
 * Architecture: the bridge is provider-agnostic. Default provider is "manual"
 * (events inserted via HTTP routes / tests). A "google-mcp" provider can be
 * registered by a parent runtime that has the Google Calendar MCP connected
 * — see CalendarProvider interface below. The server never imports the MCP
 * client directly; the runtime injects it.
 */
import type Database from 'better-sqlite3';
import {
  upsertCalendarLink,
  listCalendarLinksInRange,
  deleteCalendarLinkByEvent,
  logTaskEvent,
} from './db.js';

export interface CalendarEvent {
  calendar_id: string;
  event_id: string;
  title: string;
  start_at: number;  // unix ms
  end_at: number;    // unix ms
  todo_hash?: string;
}

export interface CalendarSlot {
  date: string;        // YYYY-MM-DD
  start_at: number;
  end_at: number;
  duration_minutes: number;
}

export interface SyncResult {
  ok: boolean;
  new_events: number;
  updated_events: number;
  removed_events: number;
  error?: string;
}

/**
 * A provider knows how to talk to a backend (Google Calendar MCP, ICS file,
 * mock, etc.). Implementations live outside this module so the server stays
 * dependency-free of any one calendar source.
 */
export interface CalendarProvider {
  name: string;
  listEvents(startMs: number, endMs: number): Promise<CalendarEvent[]>;
  createEvent(input: {
    calendar_id: string;
    title: string;
    start_at: number;
    end_at: number;
    description?: string;
  }): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

/**
 * Manual provider — events are inserted directly into the DB by HTTP/MCP
 * callers. Always available; useful for tests and for a "I want to block this
 * time" UI flow that doesn't depend on Google.
 */
class ManualProvider implements CalendarProvider {
  name = 'manual';
  async listEvents(): Promise<CalendarEvent[]> { return []; }
  async createEvent(input: {
    calendar_id: string; title: string; start_at: number; end_at: number;
  }): Promise<CalendarEvent> {
    return {
      calendar_id: input.calendar_id || 'manual',
      event_id: `manual_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      title: input.title,
      start_at: input.start_at,
      end_at: input.end_at,
    };
  }
  async deleteEvent(): Promise<void> { /* no-op */ }
}

export class CalendarBridge {
  private provider: CalendarProvider;

  constructor(private db: Database.Database, provider?: CalendarProvider) {
    this.provider = provider ?? new ManualProvider();
  }

  setProvider(provider: CalendarProvider): void {
    this.provider = provider;
  }

  getProviderName(): string {
    return this.provider.name;
  }

  /**
   * Pull events from the provider into calendar_links for the given window.
   * Returns counts and any error message.
   */
  async syncIncoming(weeksAhead = 3): Promise<SyncResult> {
    const startMs = Date.now();
    const endMs = startMs + weeksAhead * 7 * 86400000;
    try {
      const events = await this.provider.listEvents(startMs, endMs);
      let newCount = 0;
      let updatedCount = 0;
      const seen = new Set<string>();
      for (const e of events) {
        const key = `${e.calendar_id}:${e.event_id}`;
        seen.add(key);
        const beforeCount = listCalendarLinksInRange(this.db, e.start_at, e.start_at + 1).length;
        upsertCalendarLink(this.db, {
          todo_hash: e.todo_hash ?? '',
          calendar_id: e.calendar_id,
          event_id: e.event_id,
          event_title: e.title,
          start_at: e.start_at,
          end_at: e.end_at,
          status: 'active',
          synced_at: Date.now(),
        });
        const afterCount = listCalendarLinksInRange(this.db, e.start_at, e.start_at + 1).length;
        if (afterCount > beforeCount) newCount++;
        else updatedCount++;
      }
      // Soft-delete: links in the synced window that weren't seen are removed
      const existing = listCalendarLinksInRange(this.db, startMs, endMs);
      let removed = 0;
      for (const link of existing) {
        const key = `${link.calendar_id}:${link.event_id}`;
        if (!seen.has(key) && link.calendar_id !== 'manual') {
          deleteCalendarLinkByEvent(this.db, link.calendar_id, link.event_id);
          removed++;
        }
      }
      return { ok: true, new_events: newCount, updated_events: updatedCount, removed_events: removed };
    } catch (e) {
      return { ok: false, new_events: 0, updated_events: 0, removed_events: 0, error: (e as Error).message };
    }
  }

  /**
   * Create a calendar block for a task. The provider creates the event;
   * a calendar_links row mirrors it. Logs to task_events.
   */
  async scheduleTask(input: {
    todo_hash: string;
    date: string;            // YYYY-MM-DD
    start_time: string;      // HH:MM
    duration_minutes: number;
    calendar_id?: string;
    title?: string;
  }): Promise<{ ok: boolean; calendar_link_id?: number; event_id?: string; error?: string }> {
    try {
      const startAt = new Date(`${input.date}T${input.start_time}:00`).getTime();
      if (Number.isNaN(startAt)) return { ok: false, error: 'invalid date/time' };
      const endAt = startAt + input.duration_minutes * 60_000;
      const event = await this.provider.createEvent({
        calendar_id: input.calendar_id ?? 'primary',
        title: input.title ?? `[Task] ${input.todo_hash}`,
        start_at: startAt,
        end_at: endAt,
      });
      const id = upsertCalendarLink(this.db, {
        todo_hash: input.todo_hash,
        calendar_id: event.calendar_id,
        event_id: event.event_id,
        event_title: event.title,
        start_at: event.start_at,
        end_at: event.end_at,
        status: 'active',
        synced_at: Date.now(),
      });
      // Stamp the calendar_event_id back on the todo
      this.db.prepare(`UPDATE todos SET calendar_event_id=? WHERE hash=?`).run(event.event_id, input.todo_hash);
      logTaskEvent(this.db, input.todo_hash, 'calendar_linked', 'user', {
        calendar_id: event.calendar_id,
        event_id: event.event_id,
        start_at: event.start_at,
        end_at: event.end_at,
      });
      return { ok: true, calendar_link_id: id, event_id: event.event_id };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /**
   * Find free slots of `durationMinutes` between startDate and endDate,
   * given a daily workday window (default 09:00–17:00 local).
   */
  findSlots(input: {
    duration_minutes: number;
    start_date: string;
    end_date: string;
    workday_start?: string;   // HH:MM, default '09:00'
    workday_end?: string;     // HH:MM, default '17:00'
    max_results?: number;
  }): CalendarSlot[] {
    const dur = input.duration_minutes;
    const startD = new Date(`${input.start_date}T00:00:00`);
    const endD = new Date(`${input.end_date}T23:59:59`);
    const wStart = input.workday_start ?? '09:00';
    const wEnd = input.workday_end ?? '17:00';
    const maxResults = input.max_results ?? 10;
    const slots: CalendarSlot[] = [];

    for (let d = new Date(startD); d <= endD && slots.length < maxResults; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      const dayStartMs = new Date(`${dateStr}T${wStart}:00`).getTime();
      const dayEndMs = new Date(`${dateStr}T${wEnd}:00`).getTime();
      const links = listCalendarLinksInRange(this.db, dayStartMs - 1, dayEndMs + 1);
      // Build the busy-list within the workday window
      const busy = links
        .map(l => ({ start: Math.max(l.start_at, dayStartMs), end: Math.min(l.end_at, dayEndMs) }))
        .filter(b => b.end > b.start)
        .sort((a, b) => a.start - b.start);
      let cursor = dayStartMs;
      const slotsToday: CalendarSlot[] = [];
      for (const b of busy) {
        if (b.start - cursor >= dur * 60_000) {
          slotsToday.push({
            date: dateStr,
            start_at: cursor,
            end_at: cursor + dur * 60_000,
            duration_minutes: dur,
          });
        }
        cursor = Math.max(cursor, b.end);
      }
      if (dayEndMs - cursor >= dur * 60_000) {
        slotsToday.push({
          date: dateStr,
          start_at: cursor,
          end_at: cursor + dur * 60_000,
          duration_minutes: dur,
        });
      }
      // Skip past slots if dateStr is today
      const nowMs = Date.now();
      const filteredToday = slotsToday.filter(s => s.start_at > nowMs);
      for (const s of filteredToday) {
        if (slots.length >= maxResults) break;
        slots.push(s);
      }
    }
    return slots;
  }
}
