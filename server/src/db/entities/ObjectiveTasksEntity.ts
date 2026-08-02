import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.objective_tasks` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'objective_tasks' })
export class ObjectiveTasksEntity {
  @PrimaryColumn({ name: 'objective_id', type: 'text' })
  objectiveId!: string;

  @PrimaryColumn({ name: 'task_id', type: 'text' })
  taskId!: string;

  @Column({ type: 'text', nullable: true })
  id!: string | null;

  @Column({ type: 'int' })
  linked!: number;

  @Column({ type: 'int' })
  version!: number;

  @Column({ name: 'updated_at', type: 'text', nullable: true })
  updatedAt!: string | null;

  @Column({ name: 'field_ts', type: 'text', nullable: true })
  fieldTs!: string | null;
}

export type ObjectiveTasks = Readonly<ObjectiveTasksEntity>;
