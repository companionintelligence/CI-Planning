import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.calibration_combo_pins` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'calibration_combo_pins' })
export class CalibrationComboPinsEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ name: 'scope_ref', type: 'text' })
  scopeRef!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

export type CalibrationComboPins = Readonly<CalibrationComboPinsEntity>;
