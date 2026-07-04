import { randomInt } from 'node:crypto';
import { sqlite } from '../db/index.js';

/**
 * Phase Z · Z5 (Time-Sense) — A/B experiment arm assignment (spec §5.2).
 *
 * A between-subjects 2×2 factorial (haptic × ambient color). Each owner is assigned
 * ONE arm and keeps it for the whole study — a within-subject crossover is rejected
 * on both validity (the cue only conditions by firing identically every time) and
 * humane-design grounds (§5.2). Assignment is server-only so the client can never
 * self-select a condition; the arm column is stripped from the PATCH body.
 */
export type ExperimentArm = 'A' | 'B' | 'C' | 'D';

/** The 2×2 cell each arm sets on first enable. Owners can override afterward (§4). */
const ARM_CHANNELS: Record<ExperimentArm, { haptic: boolean; color: boolean }> = {
  A: { haptic: false, color: false }, // control — plain end-alarm only
  B: { haptic: true, color: false }, //  transition cues only
  C: { haptic: false, color: true }, //  duration rendering only
  D: { haptic: true, color: true }, //   full ritual
};

const ARMS = Object.keys(ARM_CHANNELS) as ExperimentArm[];

/**
 * Assign a random arm the first time an owner turns Time-Sense on, and seed the
 * haptic/color channels to match it. Idempotent: once an arm is set it never changes
 * (fixed between-subjects), so a disable→re-enable keeps the original arm and any
 * later per-channel overrides the owner made. No-op when an arm already exists.
 * Returns the owner's arm (existing or freshly assigned), or null if the row is missing.
 */
export function assignExperimentArmIfNeeded(ownerId: string): ExperimentArm | null {
  const row = sqlite
    .prepare(`SELECT z_experiment_arm AS arm FROM scheduling_prefs WHERE owner_id = ?`)
    .get(ownerId) as { arm: string | null } | undefined;
  if (!row) return null;
  if (row.arm) return row.arm as ExperimentArm;

  const arm = ARMS[randomInt(ARMS.length)];
  const { haptic, color } = ARM_CHANNELS[arm];
  sqlite
    .prepare(
      `UPDATE scheduling_prefs
          SET z_experiment_arm = ?, haptic_cues_enabled = ?, ambient_color_enabled = ?
        WHERE owner_id = ?`,
    )
    .run(arm, haptic ? 1 : 0, color ? 1 : 0, ownerId);
  return arm;
}
