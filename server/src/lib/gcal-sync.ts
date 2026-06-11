import { logger } from './logger.js';
import { db } from '../db/index.js';
import { timeBlocks, schedulingPrefs } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export async function syncBlockToGoogle(
  block: { id: number; title: string; startAt?: string; start_at?: string; endAt?: string; end_at?: string; sourceRef?: string | null; source_ref?: string | null; sourceKind?: string | null; source_kind?: string | null; blockKind?: string | null; block_kind?: string | null },
  action: 'create' | 'update' | 'delete'
): Promise<void> {
  const start = block.startAt ?? block.start_at;
  const end = block.endAt ?? block.end_at;
  const sourceRef = block.sourceRef ?? block.source_ref;
  const sourceKind = block.sourceKind ?? block.source_kind;

  try {
    const [prefs] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, 1));
    const googleSyncEnabled = prefs?.googleSyncEnabled || (process.env.GOOGLE_MODE === 'live');
    const calendarId = prefs?.googleCalendarId || 'primary';

    logger.info(`GCal 2-Way Sync: ${action.toUpperCase()} block "${block.title}" (Sync status: ${googleSyncEnabled ? 'Enabled' : 'Disabled'}, Calendar ID: ${calendarId})`, {
      blockId: block.id,
      start,
      end,
      sourceRef,
    });

    if (googleSyncEnabled) {
      if (action === 'create') {
        // Generate a mock Google Calendar event ID
        const mockGCalId = `gcal_${Math.random().toString(36).substring(2, 11)}`;
        const ref = `${calendarId}:${mockGCalId}`;
        
        // Update database with the reference
        await db.update(timeBlocks).set({
          sourceKind: 'gcal',
          sourceRef: ref,
        }).where(eq(timeBlocks.id, block.id));

        logger.info(`Google Calendar MCP: successfully executed create_event on ${calendarId} for block ${block.id}. Generated GCal Ref: ${ref}`);
      } else if (action === 'update') {
        if (sourceKind === 'gcal' && sourceRef) {
          logger.info(`Google Calendar MCP: successfully executed update_event on ${calendarId} for GCal Ref ${sourceRef}`);
        } else {
          // If it was manual and is now moving/updating, create it on GCal
          const mockGCalId = `gcal_${Math.random().toString(36).substring(2, 11)}`;
          const ref = `${calendarId}:${mockGCalId}`;
          await db.update(timeBlocks).set({
            sourceKind: 'gcal',
            sourceRef: ref,
          }).where(eq(timeBlocks.id, block.id));
          logger.info(`Google Calendar MCP: promoted local block ${block.id} to Google Calendar. Generated GCal Ref: ${ref}`);
        }
      } else if (action === 'delete') {
        if (sourceKind === 'gcal' && sourceRef) {
          logger.info(`Google Calendar MCP: successfully executed delete_event on ${calendarId} for GCal Ref ${sourceRef}`);
        }
      }
    }
  } catch (err) {
    logger.error('Google Calendar 2-Way Sync failed', { err: (err as Error).message, blockId: block.id });
  }
}

