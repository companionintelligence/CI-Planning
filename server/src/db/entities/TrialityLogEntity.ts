import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.triality_log` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'triality_log' })
export class TrialityLogEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ name: 'shown_at', type: 'text' })
  shownAt!: string;

  @Column({ name: 'local_date', type: 'text' })
  localDate!: string;

  @Column({ type: 'text' })
  slot!: string;

  @Column({ name: 'action_kind', type: 'text' })
  actionKind!: string;

  @Column({ name: 'action_ref', type: 'text' })
  actionRef!: string;

  @Column({ type: 'text' })
  scores!: string;

  @Column({ type: 'text' })
  outcome!: string;

  @Column({ name: 'outcome_at', type: 'text', nullable: true })
  outcomeAt!: string | null;

  @Column({ type: 'text', nullable: true })
  confidence!: string | null;
}

export type TrialityLog = Readonly<TrialityLogEntity>;
