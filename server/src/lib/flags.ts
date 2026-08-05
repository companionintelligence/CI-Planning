import { store } from '../db/store.js';

/**
 * Phase Z master feature flag (0106). Default OFF — every Time-Sense surface
 * (Focus Ritual, scoped calibration, EOD Alignment) checks this before doing
 * anything the pre-Z app didn't. Per-owner, so one tenant opting in never
 * changes another's behavior.
 */
export async function timeSenseEnabled(ownerId: string): Promise<boolean> {
  const row = await store()
    .prepare(`SELECT time_sense_enabled AS v FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ v: number | null }>(ownerId);
  return !!row?.v;
}

/**
 * Triality master flag (0139). Default OFF — the suggestion banner, the
 * Balance→Metrics tiles, and every /api/triality/* surface (REST and GraphQL)
 * check this before existing at all. Per-owner, same contract as above.
 */
export async function trialityEnabled(ownerId: string): Promise<boolean> {
  const row = await store()
    .prepare(`SELECT triality_enabled AS v FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ v: number | null }>(ownerId);
  return !!row?.v;
}
