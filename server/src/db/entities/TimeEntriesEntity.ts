import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.time_entries` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'time_entries' })
export class TimeEntriesEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'task_id', type: 'text' })
  taskId!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ name: 'block_id', type: 'text', nullable: true })
  blockId!: string | null;

  @Column({ name: 'started_at', type: 'text' })
  startedAt!: string;

  @Column({ name: 'ended_at', type: 'text', nullable: true })
  endedAt!: string | null;

  @Column({ type: 'text', nullable: true })
  source!: string | null;

  @Column({ name: 'created_at', type: 'text', nullable: true })
  createdAt!: string | null;
}

export type TimeEntries = Readonly<TimeEntriesEntity>;
