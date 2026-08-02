import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.time_blocks` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'time_blocks' })
export class TimeBlocksEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'task_id', type: 'text', nullable: true })
  taskId!: string | null;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ name: 'block_kind', type: 'text', nullable: true })
  blockKind!: string | null;

  @Column({ name: 'start_at', type: 'text' })
  startAt!: string;

  @Column({ name: 'end_at', type: 'text' })
  endAt!: string;

  @Column({ name: 'is_locked', type: 'int', nullable: true })
  isLocked!: number | null;

  @Column({ name: 'is_auto', type: 'int', nullable: true })
  isAuto!: number | null;

  @Column({ name: 'source_kind', type: 'text', nullable: true })
  sourceKind!: string | null;

  @Column({ name: 'source_ref', type: 'text', nullable: true })
  sourceRef!: string | null;

  @Column({ type: 'text', nullable: true })
  status!: string | null;

  @Column({ name: 'created_at', type: 'text', nullable: true })
  createdAt!: string | null;

  @Column({ name: 'all_day', type: 'int', nullable: true })
  allDay!: number | null;

  @Column({ type: 'text', nullable: true })
  tag!: string | null;

  @Column({ name: 'block_type', type: 'text', nullable: true })
  blockType!: string | null;

  @Column({ name: 'goal_start_date', type: 'text', nullable: true })
  goalStartDate!: string | null;

  @Column({ name: 'duration_minutes', type: 'int', nullable: true })
  durationMinutes!: number | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ name: 'parent_block_id', type: 'text', nullable: true })
  parentBlockId!: string | null;

  @Column({ name: 'recurrence_rule', type: 'text', nullable: true })
  recurrenceRule!: string | null;

  @Column({ name: 'recurrence_dtstart', type: 'text', nullable: true })
  recurrenceDtstart!: string | null;

  @Column({ name: 'recurrence_parent_id', type: 'text', nullable: true })
  recurrenceParentId!: string | null;

  @Column({ name: 'occurrence_date', type: 'text', nullable: true })
  occurrenceDate!: string | null;

  @Column({ name: 'auto_run_id', type: 'text', nullable: true })
  autoRunId!: string | null;

  @Column({ name: 'last_moved_at', type: 'text', nullable: true })
  lastMovedAt!: string | null;

  @Column({ name: 'category_id', type: 'text', nullable: true })
  categoryId!: string | null;

  @Column({ name: 'color_token', type: 'text', nullable: true })
  colorToken!: string | null;

  @Column({ name: 'recurrence_exdates', type: 'text', nullable: true })
  recurrenceExdates!: string | null;

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
}

export type TimeBlocks = Readonly<TimeBlocksEntity>;
