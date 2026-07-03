import { sqlite } from '../db/index.js';

/**
 * Phase Z master feature flag (0106). Default OFF — every Time-Sense surface
 * (Focus Ritual, scoped calibration, EOD Alignment) checks this before doing
 * anything the pre-Z app didn't. Per-owner, so one tenant opting in never
 * changes another's behavior.
 */
export function timeSenseEnabled(ownerId: string): boolean {
  const row = sqlite
    .prepare(`SELECT time_sense_enabled AS v FROM scheduling_prefs WHERE owner_id = ?`)
    .get(ownerId) as { v: number | null } | undefined;
  return !!row?.v;
}
