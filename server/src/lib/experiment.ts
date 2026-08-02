import { randomInt } from 'node:crypto';
import { store } from '../db/store.js';

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
export async function assignExperimentArmIfNeeded(ownerId: string): Promise<ExperimentArm | null> {
  const row = await store()
    .prepare(`SELECT z_experiment_arm AS arm FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ arm: string | null }>(ownerId);
  if (!row) return null;
  if (row.arm) return row.arm as ExperimentArm;

  const arm = ARMS[randomInt(ARMS.length)];
  const { haptic, color } = ARM_CHANNELS[arm];
  // Conditional on still-NULL so a concurrent enable (multi-process, or a caller that
  // captured a stale null before this ran) can't overwrite an already-assigned arm —
  // the fixed between-subjects invariant. First writer wins; a loser's UPDATE hits 0
  // rows and leaves the winning arm + its seeded channels intact. Read back the actual
  // stored arm rather than the one we tried to set.
  await store()
    .prepare(
      `UPDATE scheduling_prefs
          SET z_experiment_arm = ?, haptic_cues_enabled = ?, ambient_color_enabled = ?
        WHERE owner_id = ? AND z_experiment_arm IS NULL`,
    )
    .run(arm, haptic ? 1 : 0, color ? 1 : 0, ownerId);
  const final = await store()
    .prepare(`SELECT z_experiment_arm AS arm FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ arm: string | null }>(ownerId);
  return (final?.arm as ExperimentArm | null) ?? null;
}
