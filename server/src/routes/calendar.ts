import Router from '@koa/router';
import { eq, and, gte, lte, like, notInArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { timeBlocks } from '../db/schema.js';
import { broadcast } from './sse.js';

export function calendarRouter() {
  const router = new Router();

  // POST /api/calendar/events
  router.post('/api/calendar/events', async (ctx) => {
    const body = (ctx.request.body ?? {}) as {
      events?: {
        calendar_id: string;
        event_id: string;
        title: string;
        start: string;
        end: string;
      }[];
      prune_missing?: boolean;
      window_start?: string;
      window_end?: string;
    };

    const events = body.events ?? [];
    const pruneMissing = !!body.prune_missing;
    const windowStart = body.window_start;
    const windowEnd = body.window_end;

    let new_events = 0;
    let updated_events = 0;
    let removed_events = 0;

    // Track event refs to keep (per calendar)
    const keepRefsByCalendar = new Map<string, string[]>();

    for (const event of events) {
      if (!event.calendar_id || !event.event_id || !event.title || !event.start || !event.end) {
        continue;
      }

      const ref = `${event.calendar_id}:${event.event_id}`;
      
      // Store in keep list
      if (!keepRefsByCalendar.has(event.calendar_id)) {
        keepRefsByCalendar.set(event.calendar_id, []);
      }
      keepRefsByCalendar.get(event.calendar_id)!.push(ref);

      // Check if exists
      const [existing] = await db
        .select()
        .from(timeBlocks)
        .where(and(eq(timeBlocks.sourceKind, 'gcal'), eq(timeBlocks.sourceRef, ref)));

      if (existing) {
        // Check if anything changed
        if (existing.title !== event.title || existing.startAt !== event.start || existing.endAt !== event.end) {
          await db
            .update(timeBlocks)
            .set({
              title: event.title,
              startAt: event.start,
              endAt: event.end,
            })
            .where(eq(timeBlocks.id, existing.id));
          
          updated_events++;
          broadcast('block:updated', { id: existing.id, title: event.title, start_at: event.start, end_at: event.end });
        }
      } else {
        const [inserted] = await db
          .insert(timeBlocks)
          .values({
            title: event.title,
            startAt: event.start,
            endAt: event.end,
            blockKind: 'meeting',
            isLocked: true,
            isAuto: false,
            sourceKind: 'gcal',
            sourceRef: ref,
            status: 'planned',
          })
          .returning();
        
        new_events++;
        broadcast('block:created', inserted);
      }
    }

    // Handle pruning if requested
    if (pruneMissing && windowStart && windowEnd) {
      let calendarsToPrune = Array.from(keepRefsByCalendar.keys());
      
      // Fallback: If no events were provided in the request, look for active calendars in the DB
      // within the specified time window to ensure we can clear out stale events.
      if (calendarsToPrune.length === 0) {
        const blocksInWindow = await db
          .select()
          .from(timeBlocks)
          .where(
            and(
              eq(timeBlocks.sourceKind, 'gcal'),
              gte(timeBlocks.startAt, windowStart),
              lte(timeBlocks.endAt, windowEnd)
            )
          );
        const inferredCalendars = new Set<string>();
        for (const b of blocksInWindow) {
          if (b.sourceRef && b.sourceRef.includes(':')) {
            const calId = b.sourceRef.split(':')[0];
            inferredCalendars.add(calId);
          }
        }
        calendarsToPrune = Array.from(inferredCalendars);
      }
      
      for (const calendarId of calendarsToPrune) {
        const keepRefs = keepRefsByCalendar.get(calendarId) ?? [];
        
        const deleteConditions = [
          eq(timeBlocks.sourceKind, 'gcal'),
          like(timeBlocks.sourceRef, `${calendarId}:%`),
          gte(timeBlocks.startAt, windowStart),
          lte(timeBlocks.endAt, windowEnd)
        ];
        
        if (keepRefs.length > 0) {
          deleteConditions.push(notInArray(timeBlocks.sourceRef, keepRefs));
        }

        const toDelete = await db
          .select()
          .from(timeBlocks)
          .where(and(...deleteConditions));

        if (toDelete.length > 0) {
          await db.delete(timeBlocks).where(and(...deleteConditions));
          removed_events += toDelete.length;
          for (const item of toDelete) {
            broadcast('block:deleted', { id: item.id });
          }
        }
      }
    }

    ctx.body = {
      ok: true,
      new_events,
      updated_events,
      removed_events,
    };
  });

  return router;
}
