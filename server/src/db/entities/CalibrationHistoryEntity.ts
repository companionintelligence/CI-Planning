import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.calibration_history` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'calibration_history' })
export class CalibrationHistoryEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ name: 'scope_kind', type: 'text' })
  scopeKind!: string;

  @PrimaryColumn({ name: 'scope_ref', type: 'text' })
  scopeRef!: string;

  @PrimaryColumn({ name: 'computed_date', type: 'text' })
  computedDate!: string;

  @Column({ name: 'sample_count', type: 'int' })
  sampleCount!: number;

  @Column({ name: 'bias_ratio', type: 'double precision', nullable: true })
  biasRatio!: number | null;

  @Column({ type: 'double precision', nullable: true })
  p25!: number | null;

  @Column({ type: 'double precision', nullable: true })
  p50!: number | null;

  @Column({ type: 'double precision', nullable: true })
  p75!: number | null;
}

export type CalibrationHistory = Readonly<CalibrationHistoryEntity>;
