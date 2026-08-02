import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.scheduled_jobs` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'scheduled_jobs' })
export class ScheduledJobsEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'text' })
  cron!: string;

  @Column({ type: 'int', nullable: true })
  enabled!: number | null;

  @Column({ name: 'last_run_at', type: 'text', nullable: true })
  lastRunAt!: string | null;

  @Column({ name: 'next_run_at', type: 'text', nullable: true })
  nextRunAt!: string | null;

  @Column({ type: 'text', nullable: true })
  config!: string | null;
}

export type ScheduledJobs = Readonly<ScheduledJobsEntity>;
