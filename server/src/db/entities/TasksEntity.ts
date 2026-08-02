import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.tasks` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'tasks' })
export class TasksEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ name: 'due_at', type: 'text', nullable: true })
  dueAt!: string | null;

  @Column({ name: 'task_time', type: 'text', nullable: true })
  taskTime!: string | null;

  @Column({ name: 'estimated_minutes', type: 'int', nullable: true })
  estimatedMinutes!: number | null;

  @Column({ type: 'int', nullable: true })
  priority!: number | null;

  @Column({ type: 'text', nullable: true })
  status!: string | null;

  @Column({ name: 'parent_id', type: 'text', nullable: true })
  parentId!: string | null;

  @Column({ name: 'owner_id', type: 'text', nullable: true })
  ownerId!: string | null;

  @Column({ name: 'source_kind', type: 'text', nullable: true })
  sourceKind!: string | null;

  @Column({ name: 'source_ref', type: 'text', nullable: true })
  sourceRef!: string | null;

  @Column({ name: 'created_at', type: 'text', nullable: true })
  createdAt!: string | null;

  @Column({ name: 'completed_at', type: 'text', nullable: true })
  completedAt!: string | null;

  @Column({ name: 'scheduled_for', type: 'text', nullable: true })
  scheduledFor!: string | null;

  @Column({ name: 'defer_until', type: 'text', nullable: true })
  deferUntil!: string | null;

  @Column({ name: 'actual_minutes', type: 'int' })
  actualMinutes!: number;

  @Column({ name: 'recurrence_rule', type: 'text', nullable: true })
  recurrenceRule!: string | null;

  @Column({ name: 'recurrence_parent_id', type: 'text', nullable: true })
  recurrenceParentId!: string | null;

  @Column({ name: 'recurrence_dtstart', type: 'text', nullable: true })
  recurrenceDtstart!: string | null;

  @Column({ name: 'recurrence_exdates', type: 'text', nullable: true })
  recurrenceExdates!: string | null;

  @Column({ name: 'occurrence_date', type: 'text', nullable: true })
  occurrenceDate!: string | null;

  @Column({ name: 'defer_count', type: 'int', nullable: true })
  deferCount!: number | null;

  @Column({ type: 'text', nullable: true })
  subtype!: string | null;

  @Column({ type: 'int' })
  version!: number;

  @Column({ name: 'updated_at', type: 'text', nullable: true })
  updatedAt!: string | null;

  @Column({ name: 'field_ts', type: 'text', nullable: true })
  fieldTs!: string | null;

  @Column({ name: 'texture_enabled', type: 'int' })
  textureEnabled!: number;

  @Column({ name: 'texture_color_token', type: 'text', nullable: true })
  textureColorToken!: string | null;

  @Column({ name: 'completion_mood', type: 'text', nullable: true })
  completionMood!: string | null;

  @Column({ name: 'completion_note', type: 'text', nullable: true })
  completionNote!: string | null;

  @Column({ name: 'reaction_at', type: 'text', nullable: true })
  reactionAt!: string | null;

  @Column({ type: 'text', nullable: true })
  motivation!: string | null;

  @Column({ name: 'motivation_source', type: 'text', nullable: true })
  motivationSource!: string | null;
}

export type Tasks = Readonly<TasksEntity>;
