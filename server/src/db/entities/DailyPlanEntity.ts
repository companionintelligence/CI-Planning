import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.daily_plan` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'daily_plan' })
export class DailyPlanEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ type: 'text' })
  date!: string;

  @PrimaryColumn({ name: 'task_id', type: 'text' })
  taskId!: string;

  @Column({ type: 'int' })
  position!: number;

  @Column({ type: 'text', nullable: true })
  rationale!: string | null;

  @Column({ type: 'text' })
  source!: string;

  @Column({ name: 'block_id', type: 'text', nullable: true })
  blockId!: string | null;

  @Column({ type: 'text', nullable: true })
  outcome!: string | null;
}

export type DailyPlan = Readonly<DailyPlanEntity>;
