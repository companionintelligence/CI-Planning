import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.objectives` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'objectives' })
export class ObjectivesEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @Column({ name: 'parent_id', type: 'text', nullable: true })
  parentId!: string | null;

  @Column({ type: 'text' })
  level!: string;

  @Column({ type: 'text' })
  horizon!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'target_date', type: 'text', nullable: true })
  targetDate!: string | null;

  @Column({ type: 'text' })
  status!: string;

  @Column({ name: 'category_id', type: 'text', nullable: true })
  categoryId!: string | null;

  @Column({ name: 'progress_cache', type: 'double precision', nullable: true })
  progressCache!: number | null;

  @Column({ type: 'text' })
  cadence!: string;

  @Column({ name: 'last_advanced_at', type: 'text', nullable: true })
  lastAdvancedAt!: string | null;

  @Column({ type: 'int', nullable: true })
  priority!: number | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;

  @Column({ name: 'updated_at', type: 'text' })
  updatedAt!: string;

  @Column({ name: 'completed_at', type: 'text', nullable: true })
  completedAt!: string | null;

  @Column({ name: 'source_task_id', type: 'text', nullable: true })
  sourceTaskId!: string | null;

  @Column({ type: 'int' })
  version!: number;

  @Column({ name: 'field_ts', type: 'text', nullable: true })
  fieldTs!: string | null;

  @Column({ name: 'archived_at', type: 'text', nullable: true })
  archivedAt!: string | null;

  @Column({ name: 'archive_root_id', type: 'text', nullable: true })
  archiveRootId!: string | null;

  @Column({ name: 'purge_after', type: 'text', nullable: true })
  purgeAfter!: string | null;

  @Column({ name: 'color_token', type: 'text', nullable: true })
  colorToken!: string | null;
}

export type Objectives = Readonly<ObjectivesEntity>;
