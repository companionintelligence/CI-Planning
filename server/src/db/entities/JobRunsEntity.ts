import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.job_runs` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'job_runs' })
export class JobRunsEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'job_id', type: 'text', nullable: true })
  jobId!: string | null;

  @Column({ name: 'started_at', type: 'text', nullable: true })
  startedAt!: string | null;

  @Column({ name: 'finished_at', type: 'text', nullable: true })
  finishedAt!: string | null;

  @Column({ type: 'text', nullable: true })
  status!: string | null;

  @Column({ name: 'items_created', type: 'int', nullable: true })
  itemsCreated!: number | null;

  @Column({ name: 'items_updated', type: 'int', nullable: true })
  itemsUpdated!: number | null;

  @Column({ type: 'text', nullable: true })
  log!: string | null;
}

export type JobRuns = Readonly<JobRunsEntity>;
