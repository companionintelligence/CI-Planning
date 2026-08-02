import { Entity, Column, PrimaryColumn } from 'typeorm';

/** `planning.flight_plan` — generated from the ported schema; see
 *  db/postgres/migrations/20260802000400_create_planning_baseline.sql. */
@Entity({ schema: 'planning', name: 'flight_plan' })
export class FlightPlanEntity {
  @PrimaryColumn({ name: 'owner_id', type: 'text' })
  ownerId!: string;

  @PrimaryColumn({ name: 'task_id', type: 'text' })
  taskId!: string;

  @Column({ type: 'int', nullable: true })
  selected!: number | null;

  @Column({ type: 'int', nullable: true })
  position!: number | null;

  @Column({ name: 'added_at', type: 'text', nullable: true })
  addedAt!: string | null;

  @Column({ name: 'source_kind', type: 'text' })
  sourceKind!: string;

  @Column({ name: 'source_ref', type: 'text', nullable: true })
  sourceRef!: string | null;
}

export type FlightPlan = Readonly<FlightPlanEntity>;
