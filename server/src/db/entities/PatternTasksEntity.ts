import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.pattern_tasks` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'pattern_tasks' })
export class PatternTasksEntity {
  @PrimaryColumn({ name: 'pattern_id', type: 'text' })
  patternId!: string;

  @PrimaryColumn({ name: 'task_id', type: 'text' })
  taskId!: string;

  @Column({ type: 'int', nullable: true })
  position!: number | null;
}

export type PatternTasks = Readonly<PatternTasksEntity>;
