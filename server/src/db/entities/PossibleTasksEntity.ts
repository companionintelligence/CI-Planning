import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.possible_tasks` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'possible_tasks' })
export class PossibleTasksEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'raw_title', type: 'text' })
  rawTitle!: string;

  @Column({ name: 'raw_summary', type: 'text', nullable: true })
  rawSummary!: string | null;

  @Column({ name: 'proposed_due_at', type: 'text', nullable: true })
  proposedDueAt!: string | null;

  @Column({ name: 'proposed_priority', type: 'int', nullable: true })
  proposedPriority!: number | null;

  @Column({ name: 'proposed_owner_id', type: 'text', nullable: true })
  proposedOwnerId!: string | null;

  @Column({ name: 'source_kind', type: 'text', nullable: true })
  sourceKind!: string | null;

  @Column({ name: 'source_ref', type: 'text', nullable: true })
  sourceRef!: string | null;

  @Column({ name: 'source_payload', type: 'text', nullable: true })
  sourcePayload!: string | null;

  @Column({ type: 'double precision', nullable: true })
  confidence!: number | null;

  @Column({ type: 'text', nullable: true })
  status!: string | null;

  @Column({ name: 'promoted_task_id', type: 'text', nullable: true })
  promotedTaskId!: string | null;

  @Column({ name: 'created_at', type: 'text', nullable: true })
  createdAt!: string | null;

  @Column({ name: 'proposed_estimated_minutes', type: 'int', nullable: true })
  proposedEstimatedMinutes!: number | null;

  @Column({ name: 'proposed_scheduled_for', type: 'text', nullable: true })
  proposedScheduledFor!: string | null;

  @Column({ name: 'proposed_task_time', type: 'text', nullable: true })
  proposedTaskTime!: string | null;
}

export type PossibleTasks = Readonly<PossibleTasksEntity>;
