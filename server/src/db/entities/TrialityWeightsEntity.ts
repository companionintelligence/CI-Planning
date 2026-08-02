import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.triality_weights` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'triality_weights' })
export class TrialityWeightsEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ type: 'text' })
  slot!: string;

  @Column({ type: 'text' })
  weights!: string;

  @Column({ name: 'sample_count', type: 'int' })
  sampleCount!: number;

  @Column({ name: 'computed_date', type: 'text' })
  computedDate!: string;
}

export type TrialityWeights = Readonly<TrialityWeightsEntity>;
