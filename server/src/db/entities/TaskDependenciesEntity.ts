import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.task_dependencies` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'task_dependencies' })
export class TaskDependenciesEntity {
  @PrimaryColumn({ name: 'task_id', type: 'text' })
  taskId!: string;

  @PrimaryColumn({ name: 'depends_on_id', type: 'text' })
  dependsOnId!: string;

  @Column({ name: 'created_at', type: 'text', nullable: true })
  createdAt!: string | null;
}

export type TaskDependencies = Readonly<TaskDependenciesEntity>;
