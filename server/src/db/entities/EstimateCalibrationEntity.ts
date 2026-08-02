import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.estimate_calibration` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'estimate_calibration' })
export class EstimateCalibrationEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ name: 'scope_kind', type: 'text' })
  scopeKind!: string;

  @PrimaryColumn({ name: 'scope_ref', type: 'text' })
  scopeRef!: string;

  @Column({ name: 'computed_at', type: 'text' })
  computedAt!: string;

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

export type EstimateCalibration = Readonly<EstimateCalibrationEntity>;
